"""手术式写入生产网关的小程序虚拟支付五键。只改这五行，不动 gateway.env 其余内容。

绝不用 deploy-gateway.sh：那个脚本会按模板重写整份 gateway.env，
本地一旦缺 IDENT_PEPPER 就会换成新随机值，全站身份对不上。

写入：XPAY_OFFER_ID、XPAY_APP_KEY、XPAY_PUSH_TOKEN、XPAY_PUSH_AES_KEY、
WECHAT_SESSION_ENC_KEY。不写 XPAY_SANDBOX。

凭据只从 --from 指定的本地 .env 读取。日志只打印长度和红线键指纹，不打印密钥正文。

用法：
  python deploy/apply-xpay-env.py --from <本地.env>
  python deploy/apply-xpay-env.py --from <本地.env> --apply
"""
from __future__ import annotations

import base64
import hashlib
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = "/etc/dbee/gateway.env"
TARGET_KEYS = [
    "XPAY_OFFER_ID",
    "XPAY_APP_KEY",
    "XPAY_PUSH_TOKEN",
    "XPAY_PUSH_AES_KEY",
    "WECHAT_SESSION_ENC_KEY",
]
GUARD_KEYS = ["IDENT_PEPPER", "JWT_SECRET", "SMS_MASTER_CODE"]
APPLY = "--apply" in sys.argv
SANDBOX_ON = re.compile(r"^(1|true|yes|on)$", re.I)


def arg_value(flag: str) -> str:
    if flag not in sys.argv:
        return ""
    i = sys.argv.index(flag)
    if i + 1 >= len(sys.argv):
        return ""
    return sys.argv[i + 1]


def load_dotenv(path: str) -> tuple[dict[str, str], list[str]]:
    out: dict[str, str] = {}
    conflicts: list[str] = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            raw = line.strip()
            if not raw or raw.startswith("#") or "=" not in raw:
                continue
            k, v = raw.split("=", 1)
            k = k.strip()
            value = v.strip().strip('"').strip("'")
            if k in out and out[k] != value and k not in conflicts:
                conflicts.append(k)
            out[k] = value
    return out, conflicts


def fp(v: str) -> str:
    if not v:
        return "<空>"
    return f"sha256:{hashlib.sha256(v.encode()).hexdigest()[:8]} len={len(v)}"


def parse_env_map(body: str) -> dict[str, str]:
    cur: dict[str, str] = {}
    for line in body.splitlines():
        mm = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line)
        if mm:
            cur[mm.group(1)] = mm.group(2)
    return cur


def build_new_body(body: str, new: dict[str, str]) -> tuple[str, list[str], list[str]]:
    lines = body.splitlines(keepends=True)
    out: list[str] = []
    changed: list[str] = []
    present: set[str] = set()
    for line in lines:
        mm = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*?)(\r?\n?)$", line)
        if mm and mm.group(1) in TARGET_KEYS:
            k, oldv, nl = mm.group(1), mm.group(2), mm.group(3) or "\n"
            present.add(k)
            if oldv == new[k]:
                out.append(line)
                continue
            out.append(f"{k}={new[k]}{nl}")
            changed.append(k)
        else:
            out.append(line)
    to_append = [k for k in TARGET_KEYS if k not in present]
    if to_append:
        block = "".join(f"{k}={new[k]}\n" for k in to_append)
        if out and not out[-1].endswith("\n"):
            out[-1] += "\n"
        out.append(block)
    return "".join(out), changed, to_append


def validate_local(new: dict[str, str]) -> None:
    rules = {
        "XPAY_OFFER_ID": re.compile(r"^\d{10}$"),
        "XPAY_APP_KEY": re.compile(r"^[A-Za-z0-9]{32}$"),
        "XPAY_PUSH_TOKEN": re.compile(r"^[A-Za-z0-9]{3,32}$"),
        "XPAY_PUSH_AES_KEY": re.compile(r"^[A-Za-z0-9]{43}$"),
        "WECHAT_SESSION_ENC_KEY": re.compile(r"^[0-9a-fA-F]{64}$"),
    }
    for k, pat in rules.items():
        if not pat.fullmatch(new[k]):
            raise SystemExit(f"[x] {k} 格式不符（len={len(new[k])}）—— 未连接生产")
    try:
        raw = base64.b64decode(new["XPAY_PUSH_AES_KEY"] + "=", validate=True)
    except Exception:
        raise SystemExit("[x] XPAY_PUSH_AES_KEY 不是合法的 EncodingAESKey —— 未连接生产")
    if len(raw) != 32:
        raise SystemExit(f"[x] EncodingAESKey 解码后是 {len(raw)} 字节，必须是 32 —— 未连接生产")


def handshake_query(token: str) -> str:
    ts = str(int(time.time()))
    nonce = "dbeehandshake"
    echostr = "dbee-ok"
    sig = hashlib.sha1("".join(sorted([token, ts, nonce])).encode()).hexdigest()
    return urllib.parse.urlencode({
        "signature": sig,
        "timestamp": ts,
        "nonce": nonce,
        "echostr": echostr,
    })


VERIFY_JS = r"""
const fs = require('fs')
const http = require('http')
const crypto = require('crypto')
const text = fs.readFileSync('/etc/dbee/gateway.env', 'utf8')
const env = {}
for (const line of text.split('\n')) {
  const i = line.indexOf('=')
  if (i <= 0) continue
  env[line.slice(0, i)] = line.slice(i + 1).replace(/\r$/, '')
}
const token = env.XPAY_PUSH_TOKEN || ''
const ts = String(Math.floor(Date.now() / 1000))
const nonce = 'dbeehandshake'
const echostr = 'dbee-ok'
const sig = crypto.createHash('sha1').update([token, ts, nonce].sort().join(''), 'utf8').digest('hex')
const path = '/.cloud/payment/wechat/notify?' + new URLSearchParams({ signature: sig, timestamp: ts, nonce, echostr }).toString()
const req = http.get({ hostname: '127.0.0.1', port: 8080, path, timeout: 15000 }, (res) => {
  let body = ''
  res.on('data', (c) => { body += c })
  res.on('end', () => {
    const lens = ['XPAY_OFFER_ID','XPAY_APP_KEY','XPAY_PUSH_TOKEN','XPAY_PUSH_AES_KEY','WECHAT_SESSION_ENC_KEY']
      .map((k) => k + '=' + (env[k] || '').length).join(',')
    const sandbox = env.XPAY_SANDBOX || '<unset>'
    process.stdout.write('lens ' + lens + '\n')
    process.stdout.write('sandbox ' + sandbox + '\n')
    process.stdout.write('handshake ' + (res.statusCode === 200 && body === echostr ? 'pass' : 'fail') + ' http=' + res.statusCode + '\n')
  })
})
req.on('error', (err) => {
  process.stdout.write('handshake fail err=' + err.message + '\n')
  process.exit(1)
})
"""


def main() -> int:
    src = arg_value("--from") or os.path.join(REPO, ".env")
    if not os.path.isfile(src):
        print(f"[x] 找不到凭据文件：{src}")
        return 2
    dot, conflicts = load_dotenv(src)
    host = dot.get("DBEE_HOST") or os.environ.get("DBEE_HOST", "")
    user = dot.get("USER", "ubuntu")
    pwd = dot.get("SSH_PWD", "") or os.environ.get("SSH_PWD", "")
    new = {k: (dot.get(k) or "").strip() for k in TARGET_KEYS}

    print("═══ ⓪ 本地校验 ═══")
    print(f"  模式 = {'APPLY（会改生产）' if APPLY else 'DRY-RUN（不改生产）'}")
    bad = [k for k in conflicts if k in TARGET_KEYS]
    if bad:
        print(f"[x] 凭据文件里这些键有两行不同的值：{', '.join(bad)}")
        return 2
    missing = [k for k, v in new.items() if not v]
    if missing:
        print(f"[x] 缺少：{', '.join(missing)}")
        return 2
    if not host or not pwd:
        print("[x] 凭据文件缺 DBEE_HOST 或 SSH_PWD")
        return 2
    validate_local(new)
    for k in TARGET_KEYS:
        print(f"  {k} len={len(new[k])}")

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print("\n═══ 连接生产 ═══")
    try:
        cli.connect(host, username=user, password=pwd, timeout=30, banner_timeout=30, auth_timeout=30)
    except Exception as e:
        print(f"[x] SSH 连接失败：{type(e).__name__}")
        return 1
    tr = cli.get_transport()
    if tr:
        tr.set_keepalive(30)

    def sh(cmd: str, timeout: int = 60) -> tuple[int, str, str]:
        _i, o, e = cli.exec_command(cmd, timeout=timeout)
        out = o.read().decode("utf-8", "replace")
        err = e.read().decode("utf-8", "replace")
        return o.channel.recv_exit_status(), out, err

    try:
        print("\n═══ ① 读取生产 env ═══")
        rc, body, err = sh(f"sudo -n cat {ENV_FILE}")
        if rc != 0 or not body:
            print(f"[x] 读取失败 rc={rc} —— 未改动")
            return 3
        cur = parse_env_map(body)
        sandbox = (cur.get("XPAY_SANDBOX") or "").strip().strip('"').strip("'")
        if SANDBOX_ON.fullmatch(sandbox):
            print("[x] 生产已开启 XPAY_SANDBOX —— 中止，不改文件")
            return 3
        guard_before = {k: fp(cur.get(k, "")) for k in GUARD_KEYS}
        for k, v in guard_before.items():
            print(f"  {k:20s} {v}")
        print(f"  键总数 = {len(cur)}")
        for k in TARGET_KEYS:
            print(f"  现有 {k} len={len(cur.get(k, ''))}")

        new_body, changed, appended = build_new_body(body, new)
        print(f"\n═══ ② 拟改 {len(changed)} 键，新增 {len(appended)} 键 ═══")
        if changed:
            print("  改写 " + ", ".join(changed))
        if appended:
            print("  追加 " + ", ".join(appended))
        if not changed and not appended:
            print("五键已是目标值，生产无需改动")
            return 0

        a, b = body.splitlines(), new_body.splitlines()
        if len(b) < len(a):
            print("[x] 行数减少 —— 中止")
            return 3
        diff_idx = [i for i in range(min(len(a), len(b))) if a[i] != b[i]]
        for i in diff_idx:
            mk = re.match(r"^([A-Z_][A-Z0-9_]*)=", a[i])
            key = mk.group(1) if mk else ""
            if key not in TARGET_KEYS:
                print(f"[x] 第 {i + 1} 行不是虚拟支付五键 —— 中止")
                return 3
        for line in b[len(a):]:
            if not line.strip():
                continue
            mk = re.match(r"^([A-Z_][A-Z0-9_]*)=", line)
            if not mk or mk.group(1) not in TARGET_KEYS:
                print("[x] 追加了非目标键 —— 中止")
                return 3
        after_map = parse_env_map(new_body)
        for k in TARGET_KEYS:
            if after_map.get(k) != new[k]:
                print(f"[x] 改后 {k} 不等于目标值 —— 中止")
                return 3
        if len(after_map) != len(cur) + len(appended):
            print("[x] 键总数不符合预期 —— 中止")
            return 3
        for k in GUARD_KEYS:
            if fp(after_map.get(k, "")) != guard_before[k]:
                print(f"[x] 红线键 {k} 被改动 —— 中止")
                return 3
        if SANDBOX_ON.fullmatch((after_map.get("XPAY_SANDBOX") or "").strip().strip('"').strip("'")):
            print("[x] 改后会打开沙箱 —— 中止")
            return 3
        print("  内存校验通过：只动虚拟支付五键，红线键未变，沙箱仍关")

        if not APPLY:
            print("\nDRY-RUN 结束，生产文件未改。确认后加 --apply。")
            return 0

        ts = time.strftime("%Y%m%d-%H%M%S")
        bak_dir = f"/etc/dbee/.bak-xpay-{ts}"
        print(f"\n═══ ③ 备份 ═══")
        rc, out, err = sh(
            f"sudo -n install -d -m 0750 -o root -g dbee {bak_dir} "
            f"&& sudo -n cp -a {ENV_FILE} {bak_dir}/gateway.env "
            f"&& sudo -n sha256sum {bak_dir}/gateway.env"
        )
        if rc != 0:
            print("[x] 备份失败 —— 未落盘")
            return 3
        print("  备份完成")

        rc, home, _ = sh("echo $HOME")
        home = home.strip()
        stage = f"{home}/dbee-xpay-env"
        sh(f"rm -rf '{stage}' && mkdir -p '{stage}' && chmod 700 '{stage}'")
        sftp = cli.open_sftp()
        with sftp.open(f"{stage}/gateway.env", "w") as fh:
            fh.write(new_body)
        with sftp.open(f"{stage}/verify.js", "w") as fh:
            fh.write(VERIFY_JS)
        sftp.close()
        sh(f"chmod 600 '{stage}/gateway.env' '{stage}/verify.js'")
        rc, out, _ = sh(f"stat -c 'size=%s' '{stage}/gateway.env'")
        expect = len(new_body.encode("utf-8"))
        if f"size={expect}" not in out:
            print("[x] 暂存字节数不符 —— 生产未动")
            sh(f"rm -rf '{stage}'")
            return 3

        print("═══ ④ 安装 ═══")
        rc, out, err = sh(
            f"sudo -n install -m 0640 -o root -g dbee '{stage}/gateway.env' {ENV_FILE} "
            f"&& sudo -n stat -c 'owner=%U:%G perm=%a size=%s' {ENV_FILE}"
        )
        if rc != 0:
            print("[x] install 失败 —— 回滚")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            sh(f"rm -rf '{stage}'")
            return 3
        print(f"  {out.strip()}")

        rc, after, _ = sh(f"sudo -n cat {ENV_FILE}")
        after_cur = parse_env_map(after)
        ok = all(fp(after_cur.get(k, "")) == guard_before[k] for k in GUARD_KEYS)
        ok = ok and all(after_cur.get(k) == new[k] for k in TARGET_KEYS)
        if not ok:
            print("[x] 回读断言失败 —— 回滚，不重启")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            sh(f"rm -rf '{stage}'")
            return 3
        print("  回读通过")

        print("═══ ⑤ 重启并探活 ═══")
        sh("sudo -n systemctl restart dbee-gateway && sleep 8", timeout=120)
        hz = ""
        for attempt in range(1, 4):
            _rc, hz, _err = sh(
                "curl -sS -m 15 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/.cloud/healthz || echo 000",
                timeout=40,
            )
            print(f"  healthz 第 {attempt} 次 {hz.strip()}")
            if hz.strip() == "200":
                break
            sh("sleep 8")
        if hz.strip() != "200":
            print("[x] 网关没起来 —— 回滚并重启")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            sh("sudo -n systemctl restart dbee-gateway && sleep 8", timeout=120)
            sh(f"rm -rf '{stage}'")
            return 1

        rc, verify_out, verify_err = sh(
            f"sudo -n /usr/local/bin/node '{stage}/verify.js'",
            timeout=40,
        )
        print(verify_out.strip() or verify_err.strip()[:200])
        sandbox_now = ""
        for line in verify_out.splitlines():
            if line.startswith("sandbox "):
                sandbox_now = line.split(" ", 1)[1].strip()
        if "handshake pass" not in verify_out or SANDBOX_ON.fullmatch(sandbox_now or ""):
            print("[x] 握手未通过或沙箱被打开 —— 回滚并重启")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            sh("sudo -n systemctl restart dbee-gateway && sleep 8", timeout=120)
            sh(f"rm -rf '{stage}'")
            return 1

        sh(f"rm -rf '{stage}'")
        print(f"\n虚拟支付五键已写入生产。备份在 {bak_dir}/gateway.env")
        print("未打开售卖开关。")
        return 0
    finally:
        cli.close()


def public_handshake(token: str) -> None:
    query = handshake_query(token)
    url = "https://d-bee.cn/.cloud/payment/wechat/notify?" + query
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            body = resp.read().decode("utf-8", "replace")
            code = resp.status
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        code = err.code
    print(f"公网握手 {'pass' if code == 200 and body == 'dbee-ok' else 'fail'} http={code}")


if __name__ == "__main__":
    code = main()
    if code == 0 and APPLY:
        src = arg_value("--from") or os.path.join(REPO, ".env")
        token = load_dotenv(src)[0].get("XPAY_PUSH_TOKEN", "")
        if token:
            public_handshake(token)
    sys.exit(code)
