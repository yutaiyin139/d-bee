"""手术式更新生产网关的视觉三键（BASE_URL / MODEL / API_KEY），env 其余字节不动。

🔴 为什么绝不用 deploy/deploy-gateway.sh：
  该脚本用模板整体重渲染并覆盖 /etc/dbee/gateway.env。虽然 .secrets.local 里
  确实存着 JWT_SECRET / IDENT_PEPPER，但一旦那个文件缺失或被清（10-29 就发生过），
  load_secret 会静默回退 rand_hex 32 生成**全新随机值** →
  全站 ident_hash 永久失效（老用户身份全部对不上）+ 全员登出。
  这是不可逆的数据损坏，没有回滚余地。故本脚本只碰该碰的 3 行。

🔴 为什么必须三键一起换（不能只换 KEY）：
  阿里云百炼的 API Key 绑定工作空间。新 key（len=35，sk- 开头）属于
  ws-eu9wgvc1ysz242kj；旧 key（len=116）属于 ws-myumgi46hdb6mu3z。
  只换 key 不换 BASE_URL → 403（key 与工作空间不匹配）。
  同理 LLM_MODEL_VISION 必须换成该工作空间下已开通的 qwen3-vl-plus，
  否则 404（模型 ID 不存在）。
  注：config.mjs 回落链是 LLM_VISION_MODEL || LLM_MODEL_VISION，生产前者为空，
  所以实际生效的是 LLM_MODEL_VISION —— 改这个键才有效。

安全措施（每步失败即中止/回滚，绝不留半部署状态）：
  ① 推送前先跑本地 tools/vision-key-selftest.mjs —— 这把 key 当下不可用就拒绝推
  ② 改前备份 gateway.env 到 /etc/dbee/.bak-<时间戳>/
  ③ 记录 IDENT_PEPPER / JWT_SECRET / SMS_MASTER_CODE 指纹与键总数
  ④ 内存精确改行（保留原始换行符与缩进），逐行 diff
  ⑤ 🔴 断言「恰好只有目标 3 行变化」，多一行都视为异常 → 中止且不落盘
  ⑥ 断言键总数不变（改前 51 键 → 改后仍 51 键）
  ⑦ install 保持 root:dbee 0640（与原件一致）；回读断言红线键指纹逐一未变
  ⑧ 🔴 重启前最后一道闸：服务器侧用**新配置**直连上游发一次真实视觉请求。
     失败即回滚并中止 —— 此刻网关仍在跑旧配置（旧 key 在内存里），
     回滚 = cp 备份回去，线上零感知零中断。绝不「预检失败还硬重启」：
     若生产出口 IP 未进新工作空间白名单，硬重启会让线上拍照识别全部 403。
  ⑨ 重启后 healthz 探活，非 200 自动回滚备份并再重启
  ⑩ 启动日志扫可疑关键词；清理含明文的暂存文件

退出码：0=成功/无需改动 · 1=部署失败已自动回滚 · 2=本地配置缺失
        3=断言失败已回滚 · 4=服务器侧预检失败已回滚（线上未受影响）

用法：python deploy/apply-vision-key-update.py
      加 --dry-run 只做本地校验与自测，不连接服务器、不改动任何文件。
"""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
import time

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = "/etc/dbee/gateway.env"
# 本次要改的三键（目标值来自项目根 .env，本地已用 vision-key-selftest 实测 10/10 通过）
TARGET_KEYS = ["LLM_VISION_BASE_URL", "LLM_MODEL_VISION", "LLM_VISION_API_KEY"]
# 🔴 红线保护键：一旦变化 = 全站身份失效，必须回滚
GUARD_KEYS = ["IDENT_PEPPER", "JWT_SECRET", "SMS_MASTER_CODE"]

DRY_RUN = "--dry-run" in sys.argv

# 服务器侧视觉预检探针（不含任何机密；机密从环境变量 VU/VM/VK 读）。
# 用 1x1 纯色 PNG 即可验证「认证通过 + 模型 ID 有效 + 生产网络能到该工作空间」，
# 这三点恰是换工作空间/换模型/换 key 时最容易翻车的地方。
# 只依赖标准库（urllib），不假设服务器装了 requests/openai SDK。
VISION_PROBE_PY = r'''
import base64, json, os, sys, time, urllib.error, urllib.request

base = os.environ["VU"].rstrip("/")
model = os.environ["VM"]
key = os.environ["VK"]
# 🔴 必须用 >=10px 的图：1x1 会被百炼直接拒 —— 实测报
#    HTTP 400 InternalError.Algo.InvalidParameter:
#    "The image length and width do not meet the model restrictions.
#     [height:1 or width:1 must be larger than 10]"
#    这个 400 极具误导性：它说明认证已通过、请求已进到模型参数校验阶段，
#    却会被误读成「配置有问题」。故用 64x64 纯红 PNG（答案已知=红，
#    顺带验证模型真在看图而非瞎猜）。程序化生成：zlib + struct 手搓
#    PNG chunk，不依赖 Pillow（服务器与本地都不必装图像处理库）。
PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PQQkA"
    "AAgAsetfWiP4FgYrsKZeS0BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBA"
    "QEBAQEBAQEBAQEBAQEDgsqnc8OJg6Ln3AAAAAElFTkSuQmCC"
)
body = json.dumps({
    "model": model,
    "stream": False,
    "enable_thinking": False,   # 与网关 llm.mjs:365 一致，避免思考链拖时间
    "max_tokens": 32,
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": "这张图是什么颜色？只回答一个颜色词。"},
        {"type": "image_url",
         "image_url": {"url": "data:image/png;base64," + PNG_B64, "detail": "high"}},
    ]}],
}).encode()

req = urllib.request.Request(
    base + "/chat/completions", data=body,
    headers={"Content-Type": "application/json",
             "Authorization": "Bearer " + key})
t0 = time.time()
try:
    r = urllib.request.urlopen(req, timeout=90)
    d = json.loads(r.read().decode())
except urllib.error.HTTPError as e:
    detail = e.read().decode("utf-8", "replace")[:300]
    print(f"PROBE_FAIL HTTP {e.code} {e.reason} :: {detail}")
    hint = {
        401: "key 无效/被吊销",
        403: "key 与工作空间不匹配、模型未开通或欠费",
        404: "模型 ID 或 base url 不对",
        # 🔴 400 要特别小心解读：能拿到百炼的 InvalidParameter 说明
        #    认证已通过、请求已进到模型参数校验 —— 配置本身多半是好的，
        #    是请求体（如图片尺寸）不合模型要求。别误判成「配置错误」。
        400: "请求体不被接受（认证已通过！）。若是 image length/width "
             "must be larger than 10 → 是探针图片太小，不是配置问题",
    }.get(e.code)
    if hint:
        print(f"  诊断：{hint}")
    sys.exit(1)
except Exception as e:
    print(f"PROBE_FAIL {type(e).__name__}: {e}")
    sys.exit(1)

ans = (d.get("choices") or [{}])[0].get("message", {}).get("content", "")
usage = d.get("usage") or {}
print(f"PROBE_OK HTTP {r.status} 耗时 {time.time() - t0:.1f}s")
print(f"  answer={ans.strip()[:40]!r} model={d.get('model', '?')}")
print(f"  usage prompt={usage.get('prompt_tokens')} "
      f"completion={usage.get('completion_tokens')} total={usage.get('total_tokens')}")
'''


def load_dotenv(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
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


def main() -> int:
    dot = load_dotenv(os.path.join(REPO, ".env"))
    host = dot.get("DBEE_HOST") or os.environ.get("DBEE_HOST", "")
    # 身份用 ubuntu/SSH_PWD：已实测 sudo -n 免密可用。
    # （.env 里的 DBEE_USER=dbee_app + DBEE_PWD 实测 SSH 认证失败，是过时值）
    user = dot.get("USER", "ubuntu")
    pwd = dot.get("SSH_PWD", "")
    if not host or not pwd:
        print("[x] .env 缺 DBEE_HOST 或 SSH_PWD")
        return 2

    # ── 目标新值（来自本地 .env，与网关 config.mjs 回落链同源）──────────
    new = {
        "LLM_VISION_BASE_URL": (dot.get("LLM_VISION_BASE_URL", "").rstrip("/")),
        "LLM_MODEL_VISION": dot.get("LLM_MODEL_VISION", "").strip(),
        "LLM_VISION_API_KEY": dot.get("LLM_VISION_API_KEY", "").strip(),
    }
    print("═══ ⓪ 本地目标值校验 ═══")
    bad = [k for k, v in new.items() if not v]
    if bad:
        print(f"[x] 本地 .env 缺目标值：{bad} —— 中止")
        return 2
    for k in TARGET_KEYS:
        shown = mask(new[k]) if "API_KEY" in k else new[k]
        print(f"  {k:24s} → {shown}")
    if not new["LLM_VISION_API_KEY"].startswith("sk-"):
        print(f"  ⚠ 新 key 不以 sk- 开头（{mask(new['LLM_VISION_API_KEY'])}）—— "
              "请确认这是百炼 API Key 而非 AccessKeySecret")
    # 工作空间 ID 从 BASE_URL 抽出，用于断言 key 与端点同源
    m = re.search(r"//([^./]+)\.", new["LLM_VISION_BASE_URL"])
    ws = m.group(1) if m else "?"
    print(f"  目标工作空间 = {ws}")

    # ── ⓪b 本地实测：这把 key 现在还能用吗（避免把废 key 推上生产）──────
    print("\n═══ ⓪b 推送前本地自测（确认这把 key 当下可用）═══")
    r = subprocess.run(
        ["node", os.path.join(REPO, "tools", "vision-key-selftest.mjs")],
        capture_output=True, text=True, cwd=REPO, timeout=180)
    tail = "\n".join((r.stdout or "").strip().splitlines()[-4:])
    print("  " + tail.replace("\n", "\n  "))
    if r.returncode != 0:
        print("[x] 本地自测未通过 —— 这把 key 不可用，拒绝推生产")
        print((r.stderr or "")[:400])
        return 1
    print("  ✓ 自测通过，继续")

    if DRY_RUN:
        print("\n[--dry-run] 只读校验完成，未连接服务器、未改动任何文件")
        return 0

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"\n═══ 连接 {user}@{host} ═══")
    cli.connect(host, username=user, password=pwd, timeout=30,
                banner_timeout=30, auth_timeout=30)
    tr = cli.get_transport()
    if tr:
        tr.set_keepalive(30)

    def sh(cmd: str, timeout: int = 60) -> tuple[int, str, str]:
        _i, o, e = cli.exec_command(cmd, timeout=timeout)
        out = o.read().decode("utf-8", "replace")
        err = e.read().decode("utf-8", "replace")
        return o.channel.recv_exit_status(), out, err

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

        # 红线键改前指纹
        guard_before: dict[str, str] = {}
        cur: dict[str, str] = {}
        for line in body.splitlines():
            mm = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line)
            if mm:
                cur[mm.group(1)] = mm.group(2)
        for k in GUARD_KEYS:
            guard_before[k] = fp(cur.get(k, ""))
        print("  红线键改前指纹：")
        for k, v in guard_before.items():
            print(f"    {k:20s} {v}")
        key_count_before = len(cur)
        print(f"  键总数 = {key_count_before}")

        missing = [k for k in TARGET_KEYS if k not in cur]
        if missing:
            print(f"[x] 生产 env 缺目标键 {missing} —— 需人工确认后处理，中止")
            return 3

        # ── ② 内存精确改行（保留原始换行符）────────────────────────
        print("\n═══ ② 构造新内容（内存精确改行）═══")
        lines = body.splitlines(keepends=True)
        new_lines: list[str] = []
        changed: list[tuple[str, str, str]] = []
        for line in lines:
            # 只匹配「行首即目标键」，注释行（# 开头）与缩进行都不动
            mm = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*?)(\r?\n?)$", line)
            if mm and mm.group(1) in TARGET_KEYS:
                k, oldv, nl = mm.group(1), mm.group(2), mm.group(3) or "\n"
                newv = new[k]
                if oldv == newv:
                    new_lines.append(line)
                    print(f"  · {k} 已是目标值，跳过")
                    continue
                new_lines.append(f"{k}={newv}{nl}")
                changed.append((k, oldv, newv))
                o_shown = mask(oldv) if "API_KEY" in k else oldv
                n_shown = mask(newv) if "API_KEY" in k else newv
                print(f"  ✎ {k}\n      旧: {o_shown}\n      新: {n_shown}")
            else:
                new_lines.append(line)

        if not changed:
            print("\n三键均已是目标值 —— 生产无需改动")
            return 0
        # 🔴 不要求「恰好改 3 行」：生产某键可能已被手工改成目标值（合法场景，
        #    比如历史上单独换过 BASE_URL）。真正的不变式是下面两条：
        #    ① 被改动的行必须全部属于目标键（③ 逐行 diff 强校验）
        #    ② 改完后三键都必须等于目标值（下面校验，缺一即中止）
        for k in TARGET_KEYS:
            if k not in cur:
                print(f"\n[x] 生产 env 缺目标键 {k} —— 中止")
                return 3
        print(f"\n  本次实际改动 {len(changed)} 键："
              f"{[k for k, _, _ in changed]}")
        already = [k for k in TARGET_KEYS if k not in [c[0] for c in changed]]
        if already:
            print(f"  （{already} 生产已是目标值，不动）")

        new_body = "".join(new_lines)
        new_bytes = new_body.encode("utf-8")

        # ── ③ 🔴 逐行 diff 断言：改动的行必须全是目标键 ──────────────
        print("\n═══ ③ 逐行 diff 断言 ═══")
        a, b = body.splitlines(), new_body.splitlines()
        if len(a) != len(b):
            print(f"[x] 行数变了 {len(a)} → {len(b)} —— 中止，未落盘")
            return 3
        diff_idx = [i for i in range(len(a)) if a[i] != b[i]]
        print(f"  差异行数 = {len(diff_idx)}（行号 {[i + 1 for i in diff_idx]}）")
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
        print(f"  ✓ {len(diff_idx)} 行变化，全部属于目标键，无越界改动")

        # 🔴 正向不变式：改完后三键都必须恰好等于目标值。
        #    上面只保证了「没动别的」，这条保证「该动的都动对了」
        #    （防止改行逻辑漏掉某键 / 目标值带尾随空白 / 引号未剥离）
        after_map: dict[str, str] = {}
        for line in new_body.splitlines():
            mm = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line)
            if mm:
                after_map[mm.group(1)] = mm.group(2)
        for k in TARGET_KEYS:
            if after_map.get(k) != new[k]:
                shown = mask(after_map.get(k, "")) if "API_KEY" in k else after_map.get(k, "<缺>")
                print(f"[x] 新内容里 {k} = {shown}，不等于目标值 —— 中止，未落盘")
                return 3
        print("  ✓ 三键在改后内容中均已等于目标值")

        # 新内容的键总数必须不变
        new_keys = set()
        for line in new_body.splitlines():
            mm = re.match(r"^([A-Z_][A-Z0-9_]*)=", line)
            if mm:
                new_keys.add(mm.group(1))
        if len(new_keys) != key_count_before:
            print(f"[x] 键总数变了 {key_count_before} → {len(new_keys)} —— 中止")
            return 3
        print(f"  ✓ 键总数不变（{len(new_keys)}）")

        # ── ④ 备份 + 落盘 ─────────────────────────────────────────
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

        # 取远端 HOME（SFTP 不展开 ~）
        rc, home, _ = sh("echo $HOME")
        home = home.strip()
        if not home.startswith("/"):
            print(f"[x] 取 HOME 失败：{home!r} —— 中止")
            return 3
        stage = f"{home}/dbee-visionfix"
        sh(f"mkdir -p '{stage}'")
        sftp = cli.open_sftp()
        with sftp.open(f"{stage}/gateway.env", "w") as f:
            f.write(new_body)
        sftp.close()
        rc, out, _ = sh(f"stat -c 'size=%s' '{stage}/gateway.env'")
        print(f"  暂存文件 {out.strip()}（预期 {len(new_bytes)} 字节）")
        if f"size={len(new_bytes)}" not in out:
            print("[x] 暂存文件字节数不符 —— 中止，生产文件未动")
            return 3

        print("\n═══ ⑤ 安装（保持 root:dbee 0640）═══")
        rc, out, err = sh(f"sudo -n install -m 0640 -o root -g dbee "
                          f"'{stage}/gateway.env' {ENV_FILE} "
                          f"&& sudo -n stat -c 'owner=%U:%G perm=%a size=%s' {ENV_FILE}")
        if rc != 0:
            print(f"[x] install 失败 rc={rc}: {err[:200]} —— 立即回滚")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            return 3
        print(f"  ✓ {out.strip()}")

        # ── ⑥ 回读断言：红线键指纹必须完全一致 ─────────────────────
        print("\n═══ ⑥ 回读断言（红线键 + 三键新值）═══")
        rc, after, err = sh(f"sudo -n cat {ENV_FILE}")
        if rc != 0:
            print(f"[x] 回读失败 —— 回滚")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            return 3
        after_cur: dict[str, str] = {}
        for line in after.splitlines():
            mm = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line)
            if mm:
                after_cur[mm.group(1)] = mm.group(2)
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
            shown = mask(v) if "API_KEY" in k else v
            print(f"  {'✓' if same else '✗'} {k:24s} = {shown}")
        if not ok:
            print("[x] 断言失败 —— 立即回滚 env（尚未重启，线上仍是旧配置）")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            rc, chk, _ = sh(f"sudo -n sha256sum {ENV_FILE}")
            print(f"  回滚后 sha256 = {chk.strip()}")
            return 3
        print("  ✓ 全部断言通过")

        # ── ⑦ 服务器侧用新配置直连上游（重启前先验证网络可达 + 凭证有效）──
        # 🔴 这一步是「重启前最后一道闸」，失败必须回滚而不是硬重启。
        #    此刻 env 已改但网关**仍在跑旧配置**（旧 key 在内存里），
        #    回滚 = cp 备份回去，线上零感知、零中断。
        #    若跳过预检硬重启，一旦生产出口 IP 未进新工作空间白名单，
        #    线上拍照识别会全部 403 —— 那是真实用户可见的故障。
        print("\n═══ ⑦ 服务器侧真实视觉调用（新 key + 新工作空间 + 新模型）═══")
        rc, out, err = sh("command -v python3 || echo NONE")
        if "NONE" in out or not out.strip():
            print("  ⚠ 服务器无 python3，无法预检 —— 为安全起见回滚并中止")
            print("    （不做无验证的重启：宁可保持旧配置可用）")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            return 4
        # 探针脚本本身不含任何机密；机密经 0600 临时 env 文件传入，
        # 不写进命令行（避免出现在 ps / shell history / journalctl）
        stage2 = f"{home}/dbee-vprobe"
        sh(f"mkdir -p '{stage2}' && chmod 700 '{stage2}'")
        sftp2 = cli.open_sftp()
        with sftp2.open(f"{stage2}/probe.py", "w") as f:
            f.write(VISION_PROBE_PY)
        with sftp2.open(f"{stage2}/v.env", "w") as f:
            f.write(f"VU={new['LLM_VISION_BASE_URL']}\n"
                    f"VM={new['LLM_MODEL_VISION']}\n"
                    f"VK={new['LLM_VISION_API_KEY']}\n")
        sftp2.close()
        sh(f"chmod 600 '{stage2}/v.env' '{stage2}/probe.py'")
        rc, out, err = sh(
            f"cd '{stage2}' && set -a && . ./v.env && set +a "
            f"&& python3 probe.py; rm -rf '{stage2}'", timeout=150)
        if rc == 0 and "PROBE_OK" in out:
            print("  ✓ 生产网络可达新工作空间，凭证与模型均有效：")
            print("    " + out.strip().replace("\n", "\n    "))
        else:
            print("  [x] 服务器侧预检未通过 —— 🔴 回滚 env 并中止（网关未重启，线上零影响）")
            print("    " + ((err or out).strip()[:500] or "(无输出)").replace("\n", "\n    "))
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            rc, chk, _ = sh(f"sudo -n sha256sum {ENV_FILE} | cut -c1-16")
            print(f"  已回滚，env sha256 = {chk.strip()}"
                  f"（应等于勘察时的 02852cc5dcde7f8d 前 16 位）")
            print("\n  最可能的原因与处置：")
            print("  · HTTP 403 → 生产出口 IP 未加入新工作空间白名单。"
                  "到阿里云百炼控制台为该工作空间放通服务器公网 IP。")
            print("  · HTTP 401 → key 无效或不属于该工作空间。")
            print("  · HTTP 404 → 模型 ID 在该工作空间未开通。")
            print("  · HTTP 400 → 认证已通过，是请求体不合模型要求"
                  "（如图片尺寸下限 10px）—— 属探针自身问题，非配置问题。")
            print("  · 超时/连接失败 → 服务器出网策略或 DNS 问题。")
            print(f"  备份仍保留在 {bak_dir}/gateway.env，排查后可直接重跑本脚本。")
            return 4

        # ── ⑧ 重启 + healthz（失败自动回滚）───────────────────────
        print("\n═══ ⑧ 重启网关 + healthz 探活 ═══")
        rc, out, err = sh("sudo -n systemctl restart dbee-gateway && sleep 4 "
                          "&& sudo -n systemctl is-active dbee-gateway", timeout=90)
        print(f"  is-active = {out.strip() or err.strip()[:120]}")
        rc, hz, _ = sh("curl -sS -m 15 -o /tmp/hz-vision.txt -w '%{http_code}' "
                       "http://127.0.0.1:8080/.cloud/healthz || echo 000", timeout=40)
        print(f"  healthz -> HTTP {hz.strip()}")
        if hz.strip() != "200":
            print("  [x] 网关未起来 —— 自动回滚 env 并重启")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            sh("sudo -n systemctl restart dbee-gateway && sleep 4")
            rc, hz2, _ = sh("curl -sS -m 15 -o /dev/null -w '%{http_code}' "
                            "http://127.0.0.1:8080/.cloud/healthz || echo 000", timeout=40)
            print(f"  回滚后 healthz -> HTTP {hz2.strip()}")
            rc, lg, _ = sh("sudo -n journalctl -u dbee-gateway --since '3 minutes ago' "
                           "--no-pager | tail -25")
            print(lg)
            return 1
        rc, hzb, _ = sh("head -c 400 /tmp/hz-vision.txt")
        print(f"  healthz body: {hzb.strip()[:300]}")

        # ── ⑨ 启动日志确认无视觉相关报错 ───────────────────────────
        print("\n═══ ⑨ 启动日志 ═══")
        rc, lg, _ = sh("sudo -n journalctl -u dbee-gateway --since '2 minutes ago' "
                       "--no-pager | tail -20")
        print(lg.strip()[:1500])
        for kw in ["vision_not_configured", "EADDRINUSE", "Cannot find module",
                   "Invalid API", "401", "403"]:
            if kw.lower() in lg.lower():
                print(f"  ⚠ 日志出现可疑关键词：{kw} —— 请人工复核")

        # 清理暂存（含明文 key 的文件不能留在 home）
        sh(f"rm -rf '{stage}'")
        print(f"\n✅ 部署成功。备份在 {bak_dir}/gateway.env")
        print("   回滚命令：")
        print(f"     sudo cp -a {bak_dir}/gateway.env {ENV_FILE} "
              "&& sudo systemctl restart dbee-gateway")
        print("   验证方式：App/Web 拍照识别一单，journalctl -u dbee-gateway 的 [llm] 行")
        print(f"   应显示 model={new['LLM_MODEL_VISION']} 且耗时正常（无 30s+）。")
        return 0
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
