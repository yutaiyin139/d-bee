#!/usr/bin/env node
/**
 * gen-redeem-codes.mjs · D-Bee 兑换码发码工具（0044 三档）
 * ═══════════════════════════════════════════════════════════════════════
 * 用途：向 redeem_codes 表批量发放兑换码，支持 lifetime / pro(月) / pro(年)。
 *
 * 🔴 为什么必须走 SSH + psql，而不是 PostgREST / SDK / 网关：
 *   `0012:88` 起 `REVOKE ALL ON TABLE redeem_codes FROM PUBLIC, anon, authenticated`，
 *   0044 重申。任何登录用户都**无法** INSERT（这正是防「翻包拿码」的设计）。
 *   实测 `server/` 下无任何 redeem 路由 → 也没有网关后门。
 *   故唯一合法通道 = 服务器上的 postgres 超级用户身份执行 SQL。
 *   Node 侧无 ssh2/pg 依赖（实测 package.json 均无）→ 复用既有
 *   `deploy/dbee-ssh.py run <脚本>` 通道，与 0039/0040 的运维脚本同一手法。
 *
 * 🔴 安全纪律：
 *   1. **参数绑定，不拼字符串**：所有用户可控值（code/plan/months/note）经
 *      `psql -v 名=值` + SQL 里的 `:'名'` 传入。psql 的 `:'var'` 是官方安全插值，
 *      会按字面量转义 —— 不依赖「我的码字符集安全所以可以内联」这种假设。
 *   2. **码默认不打印到 stdout**：码等于钱，进终端历史/CI 日志就等于泄露。
 *      默认只打印摘要（数量/档位/文件路径）；要明文须显式 `--print`。
 *   3. **码文件落在 `release/`**：`.gitignore:80` 已忽略该目录（与 APK 归档同级），
 *      绝不会被误提交。文件名含档位与日期，便于对账。
 *   4. **凭据只从 .env 读**，不接命令行参数（避免进 shell history）。
 *
 * 🔴 码格式选择（2026-11-06 实测校准，别改回带连字符的）：
 *   `redeem_by_code` 的归一化是 `upper(regexp_replace(code,'\s+','','g'))` ——
 *   **只去空白，不去连字符**（实测 `'AB-CD' → 'AB-CD'`）。
 *   所以码里带连字符 = 用户漏打一个连字符就兑换失败（存量码正是这样，charset 含 `-`）。
 *   → 本工具生成**纯连续串**（无连字符、无空格），用户怎么复制都能成功；
 *     大小写不敏感（upper 归一），空格也会被忽略。
 *   字符集用 Crockford base32（0-9A-Z 去掉 I L O U 共 32 个），
 *   避开 I/1、L/1、O/0 的肉眼混淆 —— 客服转述码时不会出错。
 *   长度 16 → 32^16 = 2^80 ≈ 1.2e24 的空间。
 *
 * 🔴 为什么码空间必须这么大（实测发现的暴露面）：
 *   `redeem_by_code` **没有任何节流**（实测函数体无 throttl/attempt/rate 字样），
 *   而 `bind_invite` 自 0012 起有 `invite_throttled`（60s 内失败 ≥5 次即拒）。
 *   即：兑换码接口可被无限次尝试。2^80 的空间使爆破在数学上不可行，
 *   但**若将来缩短码长或缩小字符集，这条前提就没了** —— 改格式前先算空间。
 *   补节流已记入待办（见 docs 里的四端路线图/本文件末尾），不在本工具职责内。
 *
 * 用法：
 *   node tools/gen-redeem-codes.mjs --plan lifetime --count 5 --note "2026-11 内测"
 *   node tools/gen-redeem-codes.mjs --plan pro --months 1  --count 20 --note "月卡首发"
 *   node tools/gen-redeem-codes.mjs --plan pro --months 12 --count 20 --note "年卡首发"
 *   node tools/gen-redeem-codes.mjs --plan pro --months 1 --count 20 --note "限时月卡" --expires-days 30
 *   node tools/gen-redeem-codes.mjs --plan pro --months 1 --count 3 --note "测试" --dry-run
 *   加 --print 才在终端显示码明文；加 --db 指定库名（默认 dbee）；
 *   加 --expires-days N 设码有效期（N 天，缺省 = 永久有效）。
 *
 * 依赖 0048 已应用（redeem_codes 需有 code_hash 列）。未应用时本工具会
 * 明确报「服务端尚未支持哈希存储」，而不是静默退化成明文入库。
 * 🔴 0048 起库内只存 SHA-256 哈希，明文码只落 release/*.txt（gitignore + 600）。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 码格式常量（改前先读文件头「码空间」那段）─────────────────────────
/** Crockford base32：0-9A-Z 去掉易混的 I L O U（肉眼混淆 1/1、1/L、0/O） */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** 码长。32^16 = 2^80，配合「接口无节流」的现实，这个长度是下限而非余量 */
export const CODE_LENGTH = 16
/** 单次发码上限（防手滑 --count 100000 打爆表与输出文件） */
const MAX_COUNT = 500
/** months 上限，与 0044 的 redeem_codes_months_chk 保持一致 */
const MAX_MONTHS = 1200
const VALID_PLANS = ['lifetime', 'pro']

/** 解析 .env 的极简实现（无 dotenv 依赖）。只取 KEY=VALUE，忽略注释与空行。 */
export function parseEnv(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i <= 0) continue
    const k = s.slice(0, i).trim()
    let v = s.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

/**
 * 生成一个码。用 crypto.randomInt（CSPRNG）而非 Math.random ——
 * 码等于钱，Math.random 的 48-bit 状态可被观测后预测，不可用于此。
 */
export function makeCode(rand = (n) => crypto.randomInt(n)) {
  let s = ''
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[rand(CODE_ALPHABET.length)]
  return s
}

/** 批量生成且去重（碰撞概率极低，但 UNIQUE 约束在，必须自己先保证不重） */
export function makeCodes(n, rand) {
  const set = new Set()
  let guard = 0
  while (set.size < n) {
    if (++guard > n * 50 + 1000) throw new Error('生成码时陷入循环，请检查随机源')
    set.add(makeCode(rand))
  }
  return [...set]
}

/** 极简 argv 解析：--k v / --k=v / --flag */
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1)
    } else {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = true
      }
    }
  }
  return out
}

/** 校验并归一化参数；返回 {ok, ...} 而非抛异常，便于单测断言错误文案 */
export function validate(opts) {
  const plan = String(opts.plan ?? '').trim()
  if (!VALID_PLANS.includes(plan)) {
    return { ok: false, error: `--plan 必须是 ${VALID_PLANS.join(' / ')}（收到 '${plan || '<空>'}'）` }
  }
  const countRaw = opts.count ?? '1'
  const count = Number(countRaw)
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    return { ok: false, error: `--count 必须是 1..${MAX_COUNT} 的整数（收到 '${countRaw}'）` }
  }
  const note = String(opts.note ?? '').trim()
  if (!note) return { ok: false, error: '--note 必填：批次说明是对账的唯一线索，不能空' }
  if (note.length > 200) return { ok: false, error: '--note 过长（>200 字符）' }

  let months = null
  if (plan === 'pro') {
    months = Number(opts.months)
    if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) {
      return {
        ok: false,
        error: `--plan pro 必须给 --months（1..${MAX_MONTHS} 的整数）；月卡=1，年卡=12（收到 '${opts.months}'）`,
      }
    }
  } else if (opts.months !== undefined && opts.months !== true) {
    // lifetime 给了 months：0044 的 CHECK 会拒（lifetime 必须 months IS NULL）
    return { ok: false, error: '--plan lifetime 不能带 --months（0044 CHECK：lifetime 的 months 必须为 NULL）' }
  }

  // 有效期（0048 新增）：--expires-days N 天；缺省 = 永久有效（NULL）
  let expiresDays = null
  if (opts['expires-days'] !== undefined && opts['expires-days'] !== true) {
    expiresDays = Number(opts['expires-days'])
    if (!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > 3650) {
      return { ok: false, error: `--expires-days 必须是 1..3650 的整数（收到 '${opts['expires-days']}'）` }
    }
  }
  return { ok: true, plan, months, expiresDays, count, note }
}

/**
 * Shell 单引号安全转义。
 * 🔴 必须用单引号而非 JSON.stringify 的双引号：双引号内 bash 仍会展开 `$var`
 *    与 `$(cmd)` —— 备注里写 `$(rm -rf /)` 就成了命令注入。
 *    单引号内 bash 不做任何展开；单引号本身用 `'\'` 经典手法闭合再拼接。
 */
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * 构造服务器端执行脚本。
 * 🔴 码/plan/months/note 全部经 psql -v 传入，SQL 里用 :'名' 引用（psql 官方
 *    安全插值，按字面量转义）—— 不做任何字符串拼接进 SQL 正文。
 * 🔴 传给 -v 的值用 shq() 单引号包裹，防 shell 层注入（双引号挡不住 $(cmd)）。
 * 🔴 SQL 走 heredoc 写临时文件 + `psql -f`，不用管道：`echo 密码 | sudo -S` 已占用
 *    stdin，再管道给 psql 会让 SQL 收不到（本项目已实测踩过两次）。
 */
export function buildServerScript({ codes, plan, months, note, db, sqlPath, batchTag, expiresDays }) {
  const vars = [`-v notev=${shq(note)}`, `-v planv=${shq(plan)}`,
                `-v monthsv=${shq(months === null ? '' : String(months))}`,
                `-v expiresv=${shq(expiresDays === null ? '' : String(expiresDays))}`]
  codes.forEach((c, i) => vars.push(`-v c${i}=${shq(c)}`))
  // 🔴 0048：只存 code_hash（库内 SQL 现算 SHA-256），不存明文 code。
  //   expires_at 用 make_interval(days => N) 现算（now() + N 天）；空 = 永久（NULL）。
  //   🔴 不能用 N::interval（那会被解析成 N 秒而非 N 天），必须 make_interval(days=>N)。
  const rows = codes.map((_, i) =>
    `  (encode(digest(:'c${i}', 'sha256'), 'hex'), :'planv', nullif(:'monthsv','')::int, :'notev',` +
    ` CASE WHEN nullif(:'expiresv','')::int IS NULL THEN NULL ELSE now() + make_interval(days => nullif(:'expiresv','')::int) END)`
  ).join(',\n')

  return `#!/usr/bin/env bash
# 自动生成：发码批次 ${batchTag}（${codes.length} 张，plan=${plan}，months=${months ?? 'NULL'}，expiresDays=${expiresDays ?? 'NULL'}）
# 生成器 tools/gen-redeem-codes.mjs。本文件用后即删，勿手工编辑。
set -uo pipefail
SUDO() { echo "__SUDO_PWD__" | sudo -S -p '' "$@" 2>/dev/null; }
cat > ${sqlPath} <<'GENCODES_SQL_EOF'
-- 0048 前置检查：无 code_hash 列则直接失败，绝不静默退化成「明文入库」
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='redeem_codes' AND column_name='code_hash') THEN
    RAISE EXCEPTION '0048 未应用：redeem_codes 缺 code_hash 列，无法安全发码';
  END IF;
END $chk$;

INSERT INTO public.redeem_codes (code_hash, plan, months, note, expires_at) VALUES
${rows}
ON CONFLICT (code_hash) DO NOTHING
RETURNING 'GENCODES_OK:' || plan || ':' || coalesce(months::text,'NULL');
GENCODES_SQL_EOF

echo "=== applying to database '${db}' ==="
# 🔴 必须带 -tA（tuples-only + unaligned）：默认对齐输出会在每行前补空格与表头，
#    实测得到 " GENCODES_OK:pro:1"（行首有空格），导致 Node 侧 /^GENCODES_OK:/ 恒不匹配
#    → 误判「插入 0 行」→ 不发码文件，而 INSERT 其实已成功（库里留下无明文的孤儿哈希）。
#    -tA 后每行就是裸值，无前导空格、无表头、无行数尾巴。
SUDO -u postgres psql -d ${db} -tA -v ON_ERROR_STOP=1 ${vars.join(' ')} -f ${sqlPath}
RC=$?
rm -f ${sqlPath}
echo "=== psql exit=$RC ==="
if [ $RC -ne 0 ]; then echo "FATAL: insert failed, no codes were committed"; exit $RC; fi

echo "=== post-insert inventory for this batch (no plaintext codes, no hashes) ==="
SUDO -u postgres psql -d ${db} -tA -F' | ' -v notev=${shq(note)} -c "select 'batch rows=' || count(*) || ' plan=' || coalesce(string_agg(distinct plan,''),'?') || ' unused=' || count(*) filter (where used_by is null) from redeem_codes where note = :'notev'" 2>/dev/null
exit 0
`
}

/** 输出文件名：release/redeem-codes-<plan>[-<months>m]-<YYYYMMDD-HHMMSS>.txt */
export function outFileName({ plan, months, tag }) {
  const tier = plan === 'pro' ? `pro${months}m` : 'lifetime'
  return `redeem-codes-${tier}-${tag}.txt`
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const v = validate(opts)
  if (!v.ok) {
    console.error(`✗ ${v.error}`)
    process.exit(2)
  }
  const db = String(opts.db || 'dbee')
  const dryRun = !!opts['dry-run']

  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const tag = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

  const codes = makeCodes(v.count)
  const relDir = path.join(ROOT, 'release')
  const outFile = path.join(relDir, outFileName({ plan: v.plan, months: v.months, tag }))

  console.log('─── D-Bee 发码工具（0048 哈希 + 三档 + 有效期）───')
  console.log(`档位   : ${v.plan}${v.plan === 'pro' ? ` / ${v.months} 个月` : '（终身买断）'}`)
  console.log(`数量   : ${v.count}`)
  console.log(`批次备注: ${v.note}`)
  console.log(`有效期 : ${v.expiresDays === null ? '永久有效' : `${v.expiresDays} 天`}`)
  console.log(`目标库 : ${db}`)
  console.log(`码格式 : ${CODE_LENGTH} 位 Crockford base32（无连字符/无空格，大小写与空格容错）`)
  console.log(`码空间 : 32^${CODE_LENGTH} = 2^80 ≈ 1.2e24`)
  console.log(`存储   : 库内仅存 SHA-256 哈希（明文只落文件）`)
  console.log(`输出   : ${path.relative(ROOT, outFile)}`)

  if (dryRun) {
    console.log('\n[--dry-run] 不连服务器、不写库、不落盘。样例码（前 3 张，非真实发放）:')
    codes.slice(0, 3).forEach((c) => console.log(`  ${c}`))
    console.log('\n[--dry-run] 结束。去掉该参数即真正发码。')
    return 0
  }

  // 凭据：只从 .env 读，不接受命令行传入（防进 shell history）
  const envPath = path.join(ROOT, '.env')
  if (!existsSync(envPath)) {
    console.error(`✗ 找不到 ${envPath}；发码需要 DBEE_HOST / USER / SSH_PWD`)
    return 2
  }
  const env = parseEnv(readFileSync(envPath, 'utf8'))
  const host = env.DBEE_HOST || env.IP
  const user = env.USER || env.DBEE_USER
  const pwd = env.SSH_PWD || env.DBEE_PWD
  if (!host || !user || !pwd) {
    console.error('✗ .env 缺少 DBEE_HOST(或 IP) / USER / SSH_PWD 之一，无法连服务器')
    return 2
  }

  mkdirSync(relDir, { recursive: true })

  // ═══════════════════════════════════════════════════════════════════
  // 🔴🔴 先落盘明文，再写库（顺序是关键，别改回去）
  // ───────────────────────────────────────────────────────────────────
  // 原实现是「INSERT 成功 → 解析计数 → 写码文件」。2026-11-10 实测炸了：
  //   psql 默认对齐输出给 " GENCODES_OK:pro:1"（行首有空格），
  //   而计数用 /^INSERTED:/gm 锚定行首 → 恒匹配 0 行 → 判「发码失败」直接 return，
  //   码文件从未写出，进程退出后**明文永久丢失**；但 INSERT 其实已成功，
  //   库里留下一行只有 SHA-256 哈希的记录（哈希不可逆推）= **无主死码/孤儿行**，
  //   既没人能兑换、也没人知道它对应哪张码，只能事后清理。
  // 修法：**明文先落盘**。这样无论后续解析/网络/退出码出任何问题，
  //   明文都已在本地文件里，最坏情况是「库里少了记录 → 重发」，绝不会「明文丢失」。
  //   失败方向的代价必须偏小：宁可多发一次（幂等可清理），不可丢明文（不可恢复）。
  // ═══════════════════════════════════════════════════════════════════
  const header = [
    '# D-Bee 兑换码批次（机密 —— 等同现金，勿外发、勿提交、勿贴聊天）',
    `# 生成时间 : ${now.toISOString()}`,
    `# 档位     : ${v.plan}${v.plan === 'pro' ? ` / ${v.months} 个月` : '（终身买断）'}`,
    `# 数量     : ${codes.length}`,
    `# 批次备注 : ${v.note}`,
    `# 有效期   : ${v.expiresDays === null ? '永久有效' : `${v.expiresDays} 天（过期不可兑换）`}`,
    `# 目标库   : ${db}`,
    `# 格式     : ${CODE_LENGTH} 位 Crockford base32，无连字符；大小写与空格不敏感`,
    '# 说明     : 每张码只能兑换一次；pro 档到期不自动续费（见用户协议 §六）',
    '# 存储     : 库内仅存 SHA-256 哈希，明文只在本文件',
    '',
  ].join('\n')
  writeFileSync(outFile, header + codes.join('\n') + '\n', 'utf8')
  try { chmodSync(outFile, 0o600) } catch { /* Windows 上无 POSIX 权限，忽略 */ }
  console.log(`\n🔐 明文已先落盘 → ${path.relative(ROOT, outFile)}（写库失败也不会丢码）`)

  const sqlPath = `/tmp/gencodes-${tag}.sql`
  const script = buildServerScript({ codes, plan: v.plan, months: v.months, note: v.note, db, sqlPath, batchTag: tag, expiresDays: v.expiresDays })
  const scriptPath = path.join(ROOT, `tmp-gencodes-${tag}.sh`)
  writeFileSync(scriptPath, script, 'utf8')

  console.log('\n─── 正在经 SSH 写入服务器（psql -v 参数绑定）───')
  const r = spawnSync('python', ['deploy/dbee-ssh.py', 'run', path.basename(scriptPath)], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DBEE_HOST: host, DBEE_USER: user, DBEE_PWD: pwd },
  })
  const stdout = (r.stdout || '') + (r.stderr || '')

  // 🔴 计数容错：行首允许空白（万一 psql 参数被人改回对齐模式也不会再误判）。
  //    标记串 GENCODES_OK 足够独特，不会与 SQL 报错文本撞车。
  const inserted = (stdout.match(/^\s*GENCODES_OK:/gm) || []).length

  // 回显：GENCODES_OK 行不含码明文（明文只在本地文件），可安全打印；
  // 但仍过滤掉，避免刷屏与误粘贴。
  const safe = stdout.split('\n').filter((l) => !/^\s*GENCODES_OK:/.test(l))
  console.log(safe.join('\n'))

  try { rmSync(scriptPath, { force: true }) } catch { /* 尽力清理 */ }

  if (r.status !== 0 || inserted === 0) {
    console.error(`\n✗ 发码失败（psql 退出码 ${r.status}，确认插入 ${inserted} 行）`)
    console.error(`  ✅ 明文已安全落盘，未丢失：${path.relative(ROOT, outFile)}`)
    console.error('  ⚠ 但库内可能已部分写入（哈希已生成而明文只在本地 → 会成孤儿死码）。')
    console.error('  请先核对并按需清理，再重跑本命令：')
    console.error(`    SELECT id, plan, months, used_by FROM redeem_codes WHERE note = '${v.note.replace(/'/g, "''")}';`)
    console.error(`    -- 确认是孤儿后清理：DELETE FROM redeem_codes WHERE note = '${v.note.replace(/'/g, "''")}' AND used_by IS NULL;`)
    console.error('  🔴 若不清理就重跑，会产生「有哈希无明文」的死码行（本次事故的根因）。')
    return 1
  }
  if (inserted !== codes.length) {
    console.error(`\n⚠ 只插入了 ${inserted}/${codes.length} 张（ON CONFLICT DO NOTHING 命中或约束拒绝）`)
    console.error(`  码文件里是全部 ${codes.length} 张明文；未入库的那几张无法兑换，请核对后清理文件。`)
  }

  console.log(`\n✅ 已发放 ${inserted} 张码 → ${path.relative(ROOT, outFile)}`)
  if (opts.print) {
    console.log('\n─── 码明文（--print）───')
    codes.forEach((c) => console.log(c))
  } else {
    console.log('   （码明文只在该文件内；要打印到终端请加 --print）')
  }
  console.log('\n下一步：核对库存可跑 deploy/probe-0044-parity.sh')
  return 0
}

// 仅在直接执行时跑 main（被 import 做单测时不执行）
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) process.exit(main())
