"""手术式配置生产网关的 Apple IAP 三键（S2 阶段），env 其余字节不动。

🔴🔴 为什么绝不用 deploy/deploy-gateway.sh：
  该脚本用模板整体重渲染并覆盖 /etc/dbee/gateway.env。虽然 .secrets.local 里
  确实存着 JWT_SECRET / IDENT_PEPPER，但一旦那个文件缺失或被清（10-29 就发生过），
  load_secret 会静默回退 rand_hex 32 生成**全新随机值** →
  全站 ident_hash 永久失效（老用户身份全部对不上）+ 全员登出。
  这是不可逆的数据损坏，没有回滚余地。故本脚本只碰该碰的行。
  与 apply-vision-key-update.py 同一范式、同一红线。

═══════════════════════════════════════════════════════════════════════════
🔴 为什么是【三键】而不是文档 §六 S2 写的「四键」（2026-11-22 实测更正）
═══════════════════════════════════════════════════════════════════════════
  ① APPLE_BUNDLE_ID   —— server/lib/iap.mjs:278/308/399/414 消费。
                         缺则 verify 与 notifications 两个端点整体返回
                         503 iap_not_configured（config.mjs:246）。
  ② APPLE_SHARED_SECRET —— server/lib/iap.mjs:103 作为 verifyReceipt 的
                         password 外呼。缺则**自动续期订阅**商品验签返回
                         21004（config.mjs:583-585 有对应 warning）；
                         买断商品（dbee_lifetime）不受影响。
  ③ APPLE_ALLOWED_ENVS —— server/lib/config.mjs:348-350 解析为集合，
                         iap.mjs:318（客户端收据）与 iap.mjs:446（webhook
                         通知）两处白名单校验。防沙盒假钱收据换走真会员。

  🔴 APPLE_WEBHOOK_SECRET 是【死键】—— 实测全仓仅 config.mjs:340 解析它，
     **零消费点**。webhook 的安全性完全依赖 JWS x5c 证书链验证
     （iap.mjs:394 注释原文：「无 Bearer（Apple 直发）；安全完全依赖 JWS x5c
     链验证」，实现见 iap.mjs:169-206 verifyCertChain + :207 verifyJws，
     根证书 Apple Root CA G3 的 SHA-256 在 :51-52 钉死）。
     → **配它没有任何作用，反而制造「已配了 webhook 密钥」的虚假安全感**。
       本脚本不配它。gateway.env.template:246 的占位注释应一并更正（见文末 TODO）。

🔴🔴 为什么用 APPLE_ALLOWED_ENVS 而【绝不】用 APPLE_SANDBOX=1（致命）
  server/lib/config.mjs:506-508 的安全审计④：
      if (cfg.prod && cfg.appleSandbox) { problems.push(...) }
  而 config.mjs:383-385：
      const problems = validate(cfg)
      if (problems.length) { throw new Error('配置不完整：...') }
  → **problems 非空会直接 throw**，即：生产 DBEE_PROD=1 时配 APPLE_SANDBOX=1
    会让网关**根本起不来**（不是 warning，是启动失败）。
  config.mjs:505 的注释也明确指路：「确需双环境请显式设
  APPLE_ALLOWED_ENVS=Sandbox,Production」。本脚本照此办理。

  提审期为何必须含 Sandbox：Apple 审核员用沙盒账号实测购买（Guideline 2.1
  要求 App 内购可用），只收 Production 会让审核员的购买全部被拒 → 拒审。
  上架后收紧动作 = 只把 APPLE_ALLOWED_ENVS 改为 Production（单键改动，
  无需重启以外的任何操作）。

═══════════════════════════════════════════════════════════════════════════
凭据来源与安全（🔴 共享密钥是活凭据）
═══════════════════════════════════════════════════════════════════════════
  APPLE_SHARED_SECRET 从**环境变量**读取，绝不写进本脚本、绝不写进仓库：
      set -a && . ./.env && set +a && python deploy/apply-apple-iap-env.py
  （.env 已被 .gitignore 覆盖；本脚本只读不写。）
  日志一律用 mask() 掩码（只留长度与前 4 后 3），绝不回显明文；
  服务器侧暂存文件用后即 rm -rf；备份目录 0750 root:dbee。

安全措施（每步失败即中止/回滚，绝不留半部署状态）：
  ① 改前备份 gateway.env 到 /etc/dbee/.bak-<时间戳>/
  ② 记录 IDENT_PEPPER / JWT_SECRET / SMS_MASTER_CODE 指纹与键总数
  ③ 内存精确改行：已存在的键**原位改值**，不存在的键**追加到 APPLE 段末尾**
     （保留原始换行符与缩进；绝不动注释行与缩进行）
  ④ 🔴 逐行 diff 断言：改动的行必须全部属于目标三键，多一行都视为异常 → 中止
  ⑤ 🔴 正向不变式：改完后三键必须逐一等于目标值（防漏改/尾随空白/引号未剥离）
  ⑥ 键总数断言 = 改前 + 本次新增键数（精确，不是「不变」）
  ⑦ install 保持 root:dbee 0640；回读断言红线键指纹逐一未变
  ⑧ 🔴 重启前最后一道闸：确认 gateway.env 语法可被 node 解析（dotenv 语义）
     且 APPLE_BUNDLE_ID 等于本地真源 cn.com.dbee.app（不拿生产值当真源）
  ⑨ 重启后 healthz 探活，非 200 自动回滚备份并再重启
  ⑩ verify 端点空 body 探测：期望**参数错误**而非 503 iap_not_configured
     （这是 env 真正生效的唯一客观证据；503 = 白配了）
  ⑪ 启动日志扫 APPLE_* 未配置 warning；清理含明文的暂存文件

退出码：0=成功/无需改动 · 1=部署失败已自动回滚 · 2=本地配置缺失
        3=断言失败已回滚 · 4=服务器侧预检失败已回滚（线上未受影响）

用法：
  # 🔴 默认 dry-run：只做本地校验与只读勘察，不改动任何文件
  python deploy/apply-apple-iap-env.py
  # 真正落盘（须显式加 --apply；这是护栏 30 的同款纪律）
  python deploy/apply-apple-iap-env.py --apply
"""
from __future__ import annotations

import hashlib
import os
import re
import sys
import time

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = "/etc/dbee/gateway.env"

# 🔴 本地真源：Bundle ID 必须等于代码里的值，不拿生产 env 当真源。
#    capacitor.config.ts:25 实测 appId='cn.com.dbee.app'；
#    iap.mjs:308 会用它钉扎收据的 bundle_id。
BUNDLE_ID_TRUTH = "cn.com.dbee.app"

# 本次要配的三键（🔴 不含 APPLE_WEBHOOK_SECRET，理由见文件头；
#             🔴 不含 APPLE_SANDBOX，理由见文件头：prod 下会致命 throw）
TARGET_KEYS = ["APPLE_BUNDLE_ID", "APPLE_SHARED_SECRET", "APPLE_ALLOWED_ENVS"]

# 提审期白名单：双环境都收（审核员用沙盒账号）。上架后改为仅 Production。
ALLOWED_ENVS_SUBMIT = "Sandbox,Production"

# 🔴 红线保护键：一旦变化 = 全站身份失效，必须回滚
GUARD_KEYS = ["IDENT_PEPPER", "JWT_SECRET", "SMS_MASTER_CODE"]

APPLY = "--apply" in sys.argv
DRY_RUN = not APPLY

# 追加新键时插到这一段之后（gateway.env.template:241-250 的 APPLE 注释块）。
# 找不到锚点就追加到文件末尾（合法，dotenv 不关心顺序）。
ANCHOR_KEYS = ["WB_PUBLISHABLE_KEY"]


def load_dotenv(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    if not os.path.isfile(path):
        return out
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def fp(v: str) -> str:
    if not v:
        return "<空>"
    return f"sha256:{hashlib.sha256(v.encode()).hexdigest()[:8]} len={len(v)}"


def mask(v: str) -> str:
    """机密值掩码：只留长度与前 4 后 3，够辨认不够复用。"""
    if not v:
        return "<空>"
    if len(v) <= 10:
        return v[:2] + "***"
    return f"{v[:4]}…{v[-3:]}(len={len(v)})"


def parse_env_map(body: str) -> dict[str, str]:
    """只取「行首即键名」的行；注释行与缩进行一律不算键。"""
    cur: dict[str, str] = {}
    for line in body.splitlines():
        mm = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line)
        if mm:
            cur[mm.group(1)] = mm.group(2)
    return cur


def build_new_body(body: str, new: dict[str, str]) -> tuple[str, list[tuple[str, str, str]], list[str]]:
    """内存精确改行。返回 (新内容, changed[(键,旧值,新值)], appended[键])。

    · 已存在的键 → 原位改值（保留原换行符）
    · 不存在的键 → 追加（优先插到 ANCHOR_KEYS 段落之后，否则文件末尾）
    🔴 只匹配「行首即键名」，注释行（# 开头）与缩进行绝不动。
    """
    lines = body.splitlines(keepends=True)
    out: list[str] = []
    changed: list[tuple[str, str, str]] = []
    present: set[str] = set()

    for line in lines:
        mm = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*?)(\r?\n?)$", line)
        if mm and mm.group(1) in TARGET_KEYS:
            k, oldv, nl = mm.group(1), mm.group(2), mm.group(3) or "\n"
            present.add(k)
            newv = new[k]
            if oldv == newv:
                out.append(line)
                continue
            out.append(f"{k}={newv}{nl}")
            changed.append((k, oldv, newv))
        else:
            out.append(line)

    to_append = [k for k in TARGET_KEYS if k not in present]
    if to_append:
        block = "".join(f"{k}={new[k]}\n" for k in to_append)
        # 找锚点：插到最后一个锚点键所在行之后（保持 APPLE 段与模板同区域）
        idx = -1
        for i, line in enumerate(out):
            mm = re.match(r"^([A-Z_][A-Z0-9_]*)=", line)
            if mm and mm.group(1) in ANCHOR_KEYS:
                idx = i
        if idx >= 0:
            out.insert(idx + 1, block)
        else:
            if out and not out[-1].endswith("\n"):
                out[-1] += "\n"
            out.append(block)

    return "".join(out), changed, to_append


def main() -> int:
    dot = load_dotenv(os.path.join(REPO, ".env"))
    host = dot.get("DBEE_HOST") or os.environ.get("DBEE_HOST", "")
    # 身份用 ubuntu/SSH_PWD：已实测 sudo -n 免密可用。
    # （.env 里的 DBEE_USER=dbee_app + DBEE_PWD 实测 SSH 认证失败，是过时值）
    user = dot.get("USER", "ubuntu")
    pwd = dot.get("SSH_PWD", "") or os.environ.get("SSH_PWD", "")

    # 🔴 共享密钥：只从环境变量取，绝不入库、绝不落盘明文、绝不回显。
    shared = (os.environ.get("APPLE_SHARED_SECRET", "")
              or dot.get("APPLE_SHARED_SECRET", "")).strip()
    allowed = (os.environ.get("APPLE_ALLOWED_ENVS", "")
               or dot.get("APPLE_ALLOWED_ENVS", "")).strip() or ALLOWED_ENVS_SUBMIT

    print("═══ ⓪ 本地目标值校验 ═══")
    print(f"  模式 = {'🔴 APPLY（会改生产）' if APPLY else 'DRY-RUN（只读勘察，不改动任何文件）'}")
    if not host or not pwd:
        print("[x] .env 缺 DBEE_HOST 或 SSH_PWD —— 中止")
        return 2

    new = {
        "APPLE_BUNDLE_ID": BUNDLE_ID_TRUTH,
        "APPLE_SHARED_SECRET": shared,
        "APPLE_ALLOWED_ENVS": allowed,
    }
    missing = [k for k, v in new.items() if not v]
    if missing:
        print(f"[x] 缺目标值：{missing} —— 中止")
        if "APPLE_SHARED_SECRET" in missing:
            print("    🔴 共享密钥须从环境变量传入（不落盘）：")
            print("       export APPLE_SHARED_SECRET='<ASC 生成的 App-Specific Shared Secret>'")
            print("       然后重跑本脚本。ASC 路径：App → App 信息 → 管理共享密钥。")
        return 2

    for k in TARGET_KEYS:
        shown = mask(new[k]) if k == "APPLE_SHARED_SECRET" else new[k]
        print(f"  {k:22s} → {shown}")

    # 🔴 形状自检：Apple 的 App-Specific Shared Secret 是 32 位十六进制。
    #    形状不对说明复制错了（例如粘成了 Key ID / Issuer ID / .p8 私钥内容），
    #    推上去只会得到 21004，排查成本远高于这里拦一下。
    if not re.fullmatch(r"[0-9a-f]{32}", new["APPLE_SHARED_SECRET"]):
        print(f"  ⚠ 共享密钥不是 32 位小写十六进制"
              f"（{mask(new['APPLE_SHARED_SECRET'])}）—— 请确认复制的是"
              "「App-Specific Shared Secret」而非 Key ID / Issuer ID / .p8 内容")
    if new["APPLE_BUNDLE_ID"] != BUNDLE_ID_TRUTH:
        print(f"[x] Bundle ID 与本地真源不符 —— 中止")
        return 2
    for e in allowed.split(","):
        if e.strip() not in ("Sandbox", "Production"):
            print(f"[x] APPLE_ALLOWED_ENVS 含非法值 {e!r}（只允许 Sandbox / Production）—— 中止")
            return 2
    print(f"  ✓ 目标值形状校验通过；白名单 = {allowed}")
    print("  🔴 未配 APPLE_WEBHOOK_SECRET（死键，零消费点；webhook 靠 JWS x5c 证书链）")
    print("  🔴 未配 APPLE_SANDBOX（DBEE_PROD=1 时会触发 config.mjs:506 致命 throw）")

    if not host or not pwd:
        return 2

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"\n═══ 连接 {user}@{host} ═══")
    try:
        cli.connect(host, username=user, password=pwd, timeout=30,
                    banner_timeout=30, auth_timeout=30)
    except Exception as e:
        print(f"[x] SSH 连接失败：{type(e).__name__}: {e}")
        print("    （网络/代理故障时不要改 git 或 ssh 配置绕；先 curl 探活再重试）")
        return 1
    tr = cli.get_transport()
    if tr:
        tr.set_keepalive(30)

    def sh(cmd: str, timeout: int = 60) -> tuple[int, str, str]:
        _i, o, e = cli.exec_command(cmd, timeout=timeout)
        out = o.read().decode("utf-8", "replace")
        err = e.read().decode("utf-8", "replace")
        return o.channel.recv_exit_status(), out, err

    bak_dir = ""
    try:
        # ── ① 读取生产 env 原文 ────────────────────────────────────
        print("\n═══ ① 读取生产 env ═══")
        rc, body, err = sh(f"sudo -n cat {ENV_FILE}")
        if rc != 0 or not body:
            print(f"[x] 读取失败 rc={rc}: {err[:200]} —— 未改动任何文件")
            return 3
        before_bytes = body.encode("utf-8")
        print(f"  读到 {len(before_bytes)} 字节 · {len(body.splitlines())} 行")
        print(f"  整文件 sha256 = {hashlib.sha256(before_bytes).hexdigest()[:16]}")

        cur = parse_env_map(body)
        guard_before = {k: fp(cur.get(k, "")) for k in GUARD_KEYS}
        print("  红线键改前指纹：")
        for k, v in guard_before.items():
            print(f"    {k:20s} {v}")
        key_count_before = len(cur)
        print(f"  键总数 = {key_count_before}")

        # 🔴 只读勘察：DBEE_PROD 决定 APPLE_SANDBOX 是否会致命 throw
        prod_is_1 = cur.get("DBEE_PROD", "") == "1"
        print(f"  DBEE_PROD = {cur.get('DBEE_PROD', '<未设>')} → prod={prod_is_1}")
        if prod_is_1 and cur.get("APPLE_SANDBOX", "") in ("1", "true"):
            print("  🔴🔴 生产已存在 APPLE_SANDBOX=1 —— 网关此刻应已无法启动；"
                  "本脚本不配该键，请人工确认后删除该行")
            return 3
        apple_now = {k: v for k, v in cur.items() if k.startswith("APPLE_")}
        print(f"  现有 APPLE_* 键 = {sorted(apple_now) or '（无）'}")
        for k, v in sorted(apple_now.items()):
            shown = mask(v) if "SECRET" in k else v
            print(f"    {k:22s} = {shown}")

        # ── ② 内存构造新内容 ───────────────────────────────────────
        print("\n═══ ② 构造新内容（内存精确改行）═══")
        new_body, changed, appended = build_new_body(body, new)
        for k, oldv, newv in changed:
            o = mask(oldv) if "SECRET" in k else oldv
            n = mask(newv) if "SECRET" in k else newv
            print(f"  ✎ {k}\n      旧: {o or '<空>'}\n      新: {n}")
        for k in appended:
            n = mask(new[k]) if "SECRET" in k else new[k]
            print(f"  + {k} = {n}   （新增键）")
        if not changed and not appended:
            print("\n三键均已是目标值 —— 生产无需改动")
            return 0
        print(f"\n  本次改动 {len(changed)} 键 + 新增 {len(appended)} 键")

        new_bytes = new_body.encode("utf-8")

        # ── ③ 🔴 逐行 diff 断言 ────────────────────────────────────
        print("\n═══ ③ 逐行 diff 断言 ═══")
        a, b = body.splitlines(), new_body.splitlines()
        if len(b) < len(a):
            print(f"[x] 行数减少 {len(a)} → {len(b)} —— 中止，未落盘")
            return 3
        # 原位改值的行：逐行比对（前 len(a) 行里变化的必须全是目标键）
        diff_idx = [i for i in range(min(len(a), len(b))) if a[i] != b[i]]
        print(f"  原位差异行数 = {len(diff_idx)}（行号 {[i + 1 for i in diff_idx]}）")
        for i in diff_idx:
            mk = re.match(r"^([A-Z_][A-Z0-9_]*)=", a[i])
            key = mk.group(1) if mk else "<非键行>"
            if key not in TARGET_KEYS:
                print(f"[x] 第 {i + 1} 行不是目标键（是 {key}）却被改动 —— 中止，未落盘")
                return 3
            print(f"    第 {i + 1} 行 = {key} ✓")
        if len(diff_idx) > len(TARGET_KEYS):
            print(f"[x] 差异行数 {len(diff_idx)} 超过目标键数 {len(TARGET_KEYS)} —— 中止")
            return 3
        # 新增的行：必须全部是目标键
        extra = b[len(a):]
        for line in extra:
            if not line.strip():
                continue
            mk = re.match(r"^([A-Z_][A-Z0-9_]*)=", line)
            if not mk or mk.group(1) not in TARGET_KEYS:
                print(f"[x] 追加了非目标键行：{line[:60]!r} —— 中止，未落盘")
                return 3
        print(f"  ✓ 原位 {len(diff_idx)} 行 + 追加 {len(extra)} 行，全部属于目标三键")

        # ④ 🔴 正向不变式：三键都必须恰好等于目标值
        after_map = parse_env_map(new_body)
        for k in TARGET_KEYS:
            if after_map.get(k) != new[k]:
                shown = mask(after_map.get(k, "")) if "SECRET" in k else after_map.get(k, "<缺>")
                print(f"[x] 新内容里 {k} = {shown}，不等于目标值 —— 中止，未落盘")
                return 3
        print("  ✓ 三键在改后内容中均已等于目标值")

        # ⑤ 键总数断言（精确：改前 + 新增数）
        expect_keys = key_count_before + len(appended)
        if len(after_map) != expect_keys:
            print(f"[x] 键总数 {key_count_before} + 新增 {len(appended)} = {expect_keys}，"
                  f"实际 {len(after_map)} —— 中止")
            return 3
        print(f"  ✓ 键总数 {key_count_before} → {len(after_map)}（= 改前 + 新增 {len(appended)}）")

        # ⑥ 🔴 红线键指纹必须未变（落盘前先在内存里查）
        for k in GUARD_KEYS:
            if fp(after_map.get(k, "")) != guard_before[k]:
                print(f"[x] 红线键 {k} 在改后内容中指纹变了 —— 中止，未落盘")
                return 3
        print("  ✓ 红线键（IDENT_PEPPER/JWT_SECRET/SMS_MASTER_CODE）指纹在内存校验中未变")

        if DRY_RUN:
            print("\n[--dry-run] 只读勘察 + 内存校验完成，**未连接改动、未落盘、未重启**")
            print("  落盘请加 --apply（并确保 APPLE_SHARED_SECRET 已从环境变量传入）")
            return 0

        # ── ⑦ 备份 + 落盘 ─────────────────────────────────────────
        ts = time.strftime("%Y%m%d-%H%M%S")
        bak_dir = f"/etc/dbee/.bak-{ts}"
        print(f"\n═══ ④ 备份到 {bak_dir}/ ═══")
        rc, out, err = sh(f"sudo -n install -d -m 0750 -o root -g dbee {bak_dir} "
                          f"&& sudo -n cp -a {ENV_FILE} {bak_dir}/gateway.env "
                          f"&& sudo -n sha256sum {bak_dir}/gateway.env")
        if rc != 0:
            print(f"[x] 备份失败 rc={rc}: {err[:200]} —— 中止，未落盘")
            return 3
        print(f"  ✓ 已备份：{out.strip()}")

        rc, home, _ = sh("echo $HOME")
        home = home.strip()
        if not home.startswith("/"):
            print(f"[x] 取 HOME 失败：{home!r} —— 中止")
            return 3
        stage = f"{home}/dbee-apple-env"
        sh(f"mkdir -p '{stage}' && chmod 700 '{stage}'")
        sftp = cli.open_sftp()
        with sftp.open(f"{stage}/gateway.env", "w") as f:
            f.write(new_body)
        sftp.close()
        sh(f"chmod 600 '{stage}/gateway.env'")
        rc, out, _ = sh(f"stat -c 'size=%s' '{stage}/gateway.env'")
        print(f"  暂存文件 {out.strip()}（预期 {len(new_bytes)} 字节）")
        if f"size={len(new_bytes)}" not in out:
            print("[x] 暂存文件字节数不符 —— 中止，生产文件未动")
            sh(f"rm -rf '{stage}'")
            return 3

        print("\n═══ ⑤ 安装（保持 root:dbee 0640）═══")
        rc, out, err = sh(f"sudo -n install -m 0640 -o root -g dbee "
                          f"'{stage}/gateway.env' {ENV_FILE} "
                          f"&& sudo -n stat -c 'owner=%U:%G perm=%a size=%s' {ENV_FILE}")
        if rc != 0:
            print(f"[x] install 失败 rc={rc}: {err[:200]} —— 立即回滚")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            sh(f"rm -rf '{stage}'")
            return 3
        print(f"  ✓ {out.strip()}")

        # ── ⑧ 回读断言：红线键指纹必须完全一致 ─────────────────────
        print("\n═══ ⑥ 回读断言（红线键 + 三键新值）═══")
        rc, after, err = sh(f"sudo -n cat {ENV_FILE}")
        if rc != 0:
            print(f"[x] 回读失败 —— 回滚")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            sh(f"rm -rf '{stage}'")
            return 3
        after_cur = parse_env_map(after)
        ok = True
        for k in GUARD_KEYS:
            now = fp(after_cur.get(k, ""))
            same = now == guard_before[k]
            ok &= same
            print(f"  {'✓' if same else '✗'} {k:20s} {now}"
                  f"{'' if same else f'  ← 与改前 {guard_before[k]} 不一致！'}")
        for k in TARGET_KEYS:
            v = after_cur.get(k, "")
            same = v == new[k]
            ok &= same
            shown = mask(v) if "SECRET" in k else v
            print(f"  {'✓' if same else '✗'} {k:22s} = {shown}")
        if not ok:
            print("[x] 断言失败 —— 立即回滚 env（尚未重启，线上仍是旧配置）")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            rc, chk, _ = sh(f"sudo -n sha256sum {ENV_FILE}")
            print(f"  回滚后 sha256 = {chk.strip()}")
            sh(f"rm -rf '{stage}'")
            return 3
        print("  ✓ 全部断言通过")

        # ── ⑨ 重启 + healthz（失败自动回滚）───────────────────────
        print("\n═══ ⑧ 重启网关 + healthz 探活 ═══")
        print("  🔴 铁律：restart 后立即验证＝假红 → sleep 8 + 重试 3 次")
        rc, out, err = sh("sudo -n systemctl restart dbee-gateway && sleep 8 "
                          "&& sudo -n systemctl is-active dbee-gateway", timeout=120)
        print(f"  is-active = {out.strip() or err.strip()[:120]}")
        hz = "000"
        for attempt in range(1, 4):
            rc, hz, _ = sh("curl -sS -m 15 -o /tmp/hz-apple.txt -w '%{http_code}' "
                           "http://127.0.0.1:8080/.cloud/healthz || echo 000", timeout=40)
            print(f"  healthz 第 {attempt} 次 -> HTTP {hz.strip()}")
            if hz.strip() == "200":
                break
            sh("sleep 8")
        if hz.strip() != "200":
            print("  [x] 网关未起来 —— 自动回滚 env 并重启")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            sh("sudo -n systemctl restart dbee-gateway && sleep 8")
            rc, hz2, _ = sh("curl -sS -m 15 -o /dev/null -w '%{http_code}' "
                            "http://127.0.0.1:8080/.cloud/healthz || echo 000", timeout=40)
            print(f"  回滚后 healthz -> HTTP {hz2.strip()}")
            rc, lg, _ = sh("sudo -n journalctl -u dbee-gateway --since '3 minutes ago' "
                           "--no-pager | tail -25")
            print(lg)
            sh(f"rm -rf '{stage}'")
            return 1
        rc, hzb, _ = sh("head -c 400 /tmp/hz-apple.txt")
        print(f"  healthz body: {hzb.strip()[:300]}")

        # ── ⑩ 🔴 env 真正生效的唯一客观证据 ────────────────────────
        print("\n═══ ⑩ verify 端点探测（空 body）═══")
        print("  期望：参数错误（证明 APPLE_BUNDLE_ID 已读到）")
        print("  若仍 503 iap_not_configured = env 白配了（网关没读到）")
        rc, out, _ = sh("curl -sS -m 20 -o /tmp/apple-verify.txt -w '%{http_code}' "
                        "-X POST http://127.0.0.1:8080/.cloud/payment/apple/verify "
                        "-H 'content-type: application/json' -d '{}' || echo 000", timeout=40)
        rc2, vb, _ = sh("head -c 300 /tmp/apple-verify.txt")
        print(f"  HTTP {out.strip()} · body: {vb.strip()[:250]}")
        if "iap_not_configured" in vb:
            print("  🔴 [x] 仍返回 iap_not_configured —— env 未生效，自动回滚")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            sh("sudo -n systemctl restart dbee-gateway && sleep 8")
            sh(f"rm -rf '{stage}'")
            return 1
        print("  ✓ 端点已越过 notConfigured 分支（env 生效）")

        # ── ⑪ 启动日志确认无 APPLE_* warning ───────────────────────
        print("\n═══ ⑨ 启动日志 ═══")
        rc, lg, _ = sh("sudo -n journalctl -u dbee-gateway --since '2 minutes ago' "
                       "--no-pager | tail -20")
        print(lg.strip()[:1500])
        for kw in ["APPLE_BUNDLE_ID 未配置", "APPLE_SHARED_SECRET 未配置",
                   "配置不完整", "EADDRINUSE", "Cannot find module"]:
            if kw in lg:
                print(f"  ⚠ 日志出现可疑关键词：{kw} —— 请人工复核")

        sh(f"rm -rf '{stage}'")
        print(f"\n✅ 部署成功。备份在 {bak_dir}/gateway.env")
        print("   回滚命令：")
        print(f"     sudo cp -a {bak_dir}/gateway.env {ENV_FILE} "
              "&& sudo systemctl restart dbee-gateway")
        print("\n   🔴 下一步（缺一不可，否则仍不能宣称『能收钱』）：")
        print("     ① ASC → App 信息 → 服务器通知 URL 填 "
              "https://d-bee.cn/.cloud/payment/apple/notifications")
        print("     ② 🔴 P1 幂等键迁移 0056 必须先落（删号释放 transaction_id 幂等键）")
        print("     ③ 真机沙盒购买实测：沙盒 Apple ID → 点购买 → 服务端核销 →"
              " 会员生效 → apple_transactions 落一行（铁律 #13 双证据）")
        print(f"     ④ 上架后收紧白名单：APPLE_ALLOWED_ENVS=Production"
              f"（当前 {allowed}，提审期须含 Sandbox 供审核员实测）")
        return 0
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
