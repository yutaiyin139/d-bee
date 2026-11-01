#!/usr/bin/env python3
"""只读探针：量化「重启生产网关」的真实影响面 + 选定低峰窗口 + 建立 LLM 耗时基线。

背景（为什么需要这个探针）：
  apply-llm-thinking-fix.py 会 `systemctl restart dbee-gateway`。重启的确定性代价是
  清空两块**内存态**：
    · OtpStore.challenges / tokens（lib/otp.mjs:62-63，close() 时 .clear()）
    · RefreshStore.map（lib/auth.mjs:69，close() 时 .clear()）
  access token 是无状态 JWT（lib/jwt.mjs 手写 HS256，只验签+exp），**不受影响**；
  gateway.env 也一个字节不动，故 JWT_SECRET 保留、旧 access token 仍验得过。
  → 净效果：只有「access token 已过期、需要靠 refresh 续期」的用户被迫重新登录。

  叠加风险：被踢出的用户要重新登进来靠短信验证码，而移动侧签名报备未完成
  （PORT_NOT_REGISTERED），导致移动号段无密码用户可能**登不回来**。
  故本探针的目标是：先量化波及规模，再决定要不要重启、何时重启。

本探针能测什么 / 不能测什么（诚实边界，写死在代码里避免误读）：
  ✅ 能测：飞行中的验证码挑战数 —— healthz 直接返回 otp.stats（lib/app.mjs:101），
     这是「重启瞬间会被作废的验证码」的精确实时计数，不需要 grep 日志猜。
  ✅ 能测：登录活动按小时分布（低峰窗口）、独立 owner 数（波及规模）、LLM 耗时基线。
  ❌ 不能测：refresh_token 的存量条数。RefreshStore 有 `get size()`（lib/auth.mjs:95）
     但**未暴露到 healthz**，且 refresh 成功路径无日志（lib/auth.mjs:448 只在失败时返回 401）。
     要测它必须改代码加埋点 —— 那属于「为了测量而动生产」，本探针拒绝做。
     故波及规模用「近 48h 活跃 owner 数」作**上界**近似，会偏大（含已过期会话）。

实现说明（为什么用 bash -s 而不是逐条 exec_command）：
  统计段落涉及 journalctl + grep + awk 的多层引号。若用 Python 拼 `sh -c '...awk "..."...'`
  会形成四层引号嵌套，且**失败时静默返回空** —— 那会让「日志缺失」被误读成「零流量」，
  正好毁掉本探针的核心价值（选低峰窗口）。故整段远端脚本经 stdin 喂给 bash，
  引号只剩 bash 一层，可直读、可单独在服务器上复跑验证。

安全约束（遵 MEMORY.md 铁律）：
  · 全程只读：只用 journalctl / systemctl show / curl healthz / timedatectl，
    绝不 restart、绝不写文件、绝不改 env
  · 绝不 cat/grep env 正文；只取两个**非秘密**的 TTL 键，且用正则校验为时长格式才输出
  · 手机号沿用网关日志里已掩码的形式（maskAny → 139****1170），不落完整号码
  · SSH 密码只从本地 .env 读，只报 sha8 + 长度，不打印明文

用法：python deploy/probe-restart-window.py
"""

from __future__ import annotations

import hashlib
import os
import sys

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(REPO, ".env")

# 统计窗口：48h 足够看出昼夜节律（两个完整日夜），又不至于超出 journal 保留期
WINDOW = "48 hours ago"

# 登录活动特征行（来自 lib/auth.mjs 的 logger.info 字面量）：
#   :332 `[auth] 发码 ...`        :403 `[auth] 登录成功 ...`（验证码路径）
#   :248 `[auth] 密码登录成功 ...`  :513 `[auth] 登出 ...`
AUTH_PAT = r"\[auth\] (发码|登录成功|密码登录成功|登出)"

# ── 远端只读脚本（整段经 stdin 喂 bash，引号仅一层）──────────────────────
# 占位符 __WINDOW__ / __AUTH_PAT__ 由 Python 注入，避免在 bash 里再套一层引号。
REMOTE_SCRIPT = r"""
set -uo pipefail   # 刻意不加 -e：探针要跑完所有段，单段失败不能中断取证

WINDOW="__WINDOW__"
AUTH_PAT='__AUTH_PAT__'

hr() { printf '%s\n' "──────────────────────────────────────────────────────────────"; }

# 统一日志读取入口。sudo -n 免密已在前序探针验证可用；拿不到就静默返回空，
# 由 ① 段的「总行数」暴露出来，不靠异常中断。
jlog() {
  sudo -n journalctl -u dbee-gateway --since "$WINDOW" --no-pager 2>/dev/null
}
jlog_iso() {
  sudo -n journalctl -u dbee-gateway --since "$WINDOW" -o short-iso --no-pager 2>/dev/null
}

hr
echo "⓪ 服务器时区与当前时间（小时桶的解读基准）"
hr
timedatectl 2>/dev/null | grep -iE 'Time zone|Local time' || date '+%Y-%m-%d %H:%M:%S %Z'
echo

hr
echo "① journal 可用范围（区分「无流量」与「日志未保留」）"
hr
# 必须先测这个：空桶可能是「无流量」也可能是「日志没留那么久」，
# 不区分就会把「数据缺失」误读成「低峰」，进而选错窗口
echo "磁盘占用: $(sudo -n journalctl --disk-usage 2>/dev/null || echo '取不到')"
echo "最早一条: $(sudo -n journalctl -u dbee-gateway -o short-iso --no-pager 2>/dev/null | head -1 | cut -c1-30)"
echo "最新一条: $(sudo -n journalctl -u dbee-gateway -o short-iso --no-pager 2>/dev/null | tail -1 | cut -c1-30)"
echo "$WINDOW 内总行数: $(jlog | wc -l)"
echo

hr
echo "② healthz 实时采样 ×6（间隔 2s）→ otp.challenges/tokens = 重启会作废的在途验证码"
hr
for i in 1 2 3 4 5 6; do
  printf '%s  ' "$(date +%H:%M:%S)"
  curl -sS -m 5 http://127.0.0.1:8080/.cloud/healthz 2>&1 | head -c 400
  echo
  [ "$i" -lt 6 ] && sleep 2
done
echo

hr
echo "③ 近 48h 登录活动按小时分布（找低峰窗口）"
hr
# -o short-iso 给形如 2026-11-01T18:34:40+08:00 的时间戳，substr($1,12,2) 取小时位。
# printf 补零排序，缺失的小时不输出 —— 读结果时须对照 ① 判断是「无流量」还是「无日志」
jlog_iso | grep -E "$AUTH_PAT" | awk '
  { h = substr($1, 12, 2); c[h]++; t++ }
  END {
    if (t == 0) { print "  (窗口内无登录活动记录)"; exit }
    for (k in c) printf "%s:00  %d\n", k, c[k]
  }
' | sort
echo

hr
echo "④ 波及规模：独立 owner 数（会话波及上界）与各登录路径计数"
hr
# 🔴 不把全量日志塞进变量：48h 全量可能几十 MB，低内存机器上有风险且毫无必要。
#    只在捕获时过滤出关心的两类行（auth / llm），体积骤降，且各跑一次 journalctl。
LAUTH=$(jlog | grep -E "$AUTH_PAT")
# owner= 是 uuid，非秘密。sort -u 去重即独立用户数。
# 这是**上界**：含 access token 仍未过期、重启后根本不需要重登的用户
printf '独立 owner 数(波及上界): %s\n' "$(printf '%s\n' "$LAUTH" | grep -oE 'owner=[0-9a-f-]+' | sort -u | grep -c .)"
printf '验证码登录成功:          %s\n' "$(printf '%s\n' "$LAUTH" | grep -cE '\[auth\] 登录成功')"
printf '密码登录成功:            %s\n' "$(printf '%s\n' "$LAUTH" | grep -cE '\[auth\] 密码登录成功')"
printf '发码次数:                %s\n' "$(printf '%s\n' "$LAUTH" | grep -cE '\[auth\] 发码')"
printf '登出次数:                %s\n' "$(printf '%s\n' "$LAUTH" | grep -cE '\[auth\] 登出')"
echo "  ↑ 密码登录占比越高，重启的实际痛感越低（这批人能自己登回来，不依赖短信）"
echo

hr
echo "⑤ LLM 耗时基线（部署前 before，用于验证提速效果）"
hr
# 日志格式（lib/llm.mjs:468-471）：`[llm] owner=... model=... 耗时=NNNms usage={...}`
# 没有这份 before，部署后就无法证明提速是真的
# 只在捕获时过滤 [llm] 行，不缓存全量日志（理由同 ④）
LLM=$(jlog | grep -E '\[llm\]')
printf '%s\n' "$LLM" | grep -oE '耗时=[0-9]+ms' | grep -oE '[0-9]+' | sort -n | awk '
  { a[NR] = $1; s += $1 }
  END {
    if (NR == 0) { print "  无 [llm] 耗时样本（窗口内没有识别请求，或该修复尚未部署）"; exit }
    printf "  样本=%d\n  最小=%dms\n  中位=%dms\n  P90=%dms\n  最大=%dms\n  均值=%.0fms\n",
           NR, a[1], a[int((NR+1)/2)], a[int(NR*0.9+0.5)], a[NR], s/NR
  }
'
echo

hr
echo "⑥ reasoning_tokens 空转印证（思考模式关闭前的基线）"
hr
printf '%s\n' "$LLM" | grep -oE 'reasoning_tokens[":]+[0-9]+' | grep -oE '[0-9]+$' | sort -n | awk '
  { a[NR] = $1; s += $1 }
  END {
    if (NR == 0) { print "  无 reasoning_tokens 记录（上游未返回该字段，或窗口内无识别请求）"; exit }
    printf "  样本=%d  最小=%d  中位=%d  最大=%d  均值=%.0f\n",
           NR, a[1], a[int((NR+1)/2)], a[NR], s/NR
  }
'
echo

hr
echo "⑦ 服务稳定性与 uptime"
hr
systemctl show dbee-gateway -p ActiveState,SubState,NRestarts,ExecMainStartTimestamp --no-pager 2>&1
echo "当前状态: $(systemctl is-active dbee-gateway 2>&1)"
echo "  ↑ NRestarts 若本就很高，说明服务在反复重启，人工重启的边际代价更小"
echo

hr
echo "⑧ TTL 生效值（决定被踢出登录的比例）"
hr
# 只取三个**非秘密**的时长键，且用正则确认是时长格式才输出；不匹配就隐藏，
# 避免误把某个被复用的敏感值打印出来。绝不 cat 整个 env 文件。
sudo -n sh -c '
  for k in JWT_EXPIRES_IN JWT_REFRESH_EXPIRES_IN OTP_TTL_SEC; do
    v=$(grep -E "^${k}=" /etc/dbee/gateway.env 2>/dev/null | head -1 | cut -d= -f2-)
    if [ -z "$v" ]; then
      echo "  $k (未设置 → 用代码默认值)"
    elif printf "%s" "$v" | grep -qE "^[0-9]+[smhd]?$"; then
      echo "  $k = $v"
    else
      echo "  $k 非时长格式（已隐藏，不打印）"
    fi
  done
' 2>&1
echo "  ↑ access TTL 越短，重启后需要 refresh 的在线用户比例越高"
echo

hr
echo "PROBE_DONE 全程只读：无 restart / 无写操作 / 无 env 改动"
hr
"""


def load_env() -> dict[str, str]:
    out: dict[str, str] = {}
    if not os.path.exists(ENV_PATH):
        return out
    with open(ENV_PATH, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def sha8(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()[:8]


def main() -> int:
    env = load_env()
    host = env.get("DBEE_HOST") or env.get("SSH_HOST") or ""
    user = env.get("USER") or "ubuntu"
    pwd = env.get("SSH_PWD") or ""

    if not host or not pwd:
        print("❌ .env 缺 DBEE_HOST / USER / SSH_PWD，无法连接")
        return 2
    print(f"目标: {user}@{host}  SSH_PWD sha8={sha8(pwd)} len={len(pwd)}")
    print("模式: 🔒 全程只读（无 restart / 无写操作 / 无 env 改动）")
    print(f"窗口: 近 {WINDOW}\n")

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        cli.connect(host, username=user, password=pwd, timeout=25,
                    banner_timeout=25, auth_timeout=25)
    except Exception as exc:  # noqa: BLE001
        print(f"❌ SSH 连接失败: {type(exc).__name__}: {exc}")
        return 3
    tr = cli.get_transport()
    if tr:
        tr.set_keepalive(30)

    # 注入占位符后整段喂 stdin（与 apply-llm-thinking-fix.py / probe-sms-delivery.py 同一模式）
    script = REMOTE_SCRIPT.replace("__WINDOW__", WINDOW).replace("__AUTH_PAT__", AUTH_PAT)

    # ② 段含 5 次 sleep 2 + 6 次 curl，给足超时余量
    _, so, se = cli.exec_command("bash -s", timeout=240)
    so.channel.sendall(script.encode("utf-8"))
    so.channel.shutdown_write()
    out = so.read().decode("utf-8", "replace")
    err = se.read().decode("utf-8", "replace")
    rc = so.channel.recv_exit_status()
    cli.close()

    print(out)
    if err.strip():
        # stderr 里 sudo 的告警很常见（如 tty 相关），不影响取证，原样透出便于判断
        print("───── [stderr] ─────")
        print(err.strip()[:2000])

    if "PROBE_DONE" not in out:
        print(f"\n❌ 探针未跑完（rc={rc}），上面的输出可能不完整 —— 勿据此下结论")
        return 1

    print("""
读数指引：
  · ② 的 otp.challenges/tokens 若长期为 0 → 任意时刻重启都不会作废在途验证码
  · ③ 的最小桶即低峰窗口（用 ⓪ 的时区解读）；若 ① 显示日志未覆盖 48h，
    则缺失的小时是「无数据」不是「无流量」，**不可**当作低峰
  · ④ 的「独立 owner 数」是波及**上界**（含 access token 仍未过期者），
    真实需重登人数 ≤ 该值；结合 ⑧ 的 access TTL 才能估出比例
  · ⑤⑥ 是部署前基线，务必留存；部署后同口径再跑一次即可量化提速

已知测不到的项：refresh_token 存量条数（RefreshStore.size 未暴露到 healthz，
  refresh 成功路径也无日志）。要测它需加埋点，属「为测量而动生产」，本探针不做。
""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
