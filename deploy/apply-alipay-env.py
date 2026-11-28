"""手术式写入生产网关的支付宝三键。只改这三行，不动 gateway.env 的其余内容。

绝不用 deploy-gateway.sh：那个脚本会按模板重写整份 gateway.env，
本地一旦缺 IDENT_PEPPER 就会换成新随机值，全站身份对不上。

凭据只从 --from 指定的本地 .env 读取（默认仓库根 .env）。
日志只打印 AppID 和密钥长度，不打印私钥或公钥正文。

用法：
  python deploy/apply-alipay-env.py --from <本地.env>
  python deploy/apply-alipay-env.py --from <本地.env> --apply
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
TARGET_KEYS = ["ALIPAY_APP_ID", "ALIPAY_PRIVATE_KEY", "ALIPAY_PUBLIC_KEY"]
GUARD_KEYS = ["IDENT_PEPPER", "JWT_SECRET", "SMS_MASTER_CODE"]
CONFIRMED_APP_TAIL = "5998"
APPLY = "--apply" in sys.argv


def arg_value(flag: str) -> str:
    if flag not in sys.argv:
        return ""
    i = sys.argv.index(flag)
    if i + 1 >= len(sys.argv):
        return ""
    return sys.argv[i + 1]


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


def pem_body(raw: str) -> str:
    text = raw.strip()
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        text = text[1:-1]
    text = text.replace("\\n", "\n")
    text = re.sub(r"-----BEGIN [^-]+-----", "", text)
    text = re.sub(r"-----END [^-]+-----", "", text)
    return re.sub(r"\s+", "", text)


def pem_line(raw: str, begin: str, end: str) -> str:
    compact = pem_body(raw)
    chunks = [compact[i:i + 64] for i in range(0, len(compact), 64)]
    pem = "-----BEGIN " + begin + "-----\n" + "\n".join(chunks) + "\n-----END " + end + "-----\n"
    # 必须加双引号。systemd 的 EnvironmentFile 对无引号的 \n 会吃掉反斜杠，
    # 进程里的 PEM 变成一串插着字母 n 的坏密钥，Node 签名报 DECODER unsupported。
    # 双引号内的 \n 会被 systemd 还原成真正的换行。
    return '"' + pem.replace("\n", "\\n") + '"'


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
    script = r"""
const { createPrivateKey, createPublicKey } = require('crypto')
let raw = ''
process.stdin.on('data', c => { raw += c })
process.stdin.on('end', () => {
  const parts = raw.split('-----SPLIT-----')
  const unfold = s => {
    let t = (s || '').trim()
    if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1)
    return t.replace(/\\n/g, String.fromCharCode(10))
  }
  const pk = createPrivateKey(unfold(parts[0]))
  const derived = createPublicKey(pk).export({ type: 'spki', format: 'der' }).toString('base64')
  const given = createPublicKey(unfold(parts[1])).export({ type: 'spki', format: 'der' }).toString('base64')
  if (derived === given) {
    console.log('SAME')
    process.exit(2)
  }
  console.log('OK')
})
"""
    proc = subprocess.run(
        ["node", "-e", script],
        input=new["ALIPAY_PRIVATE_KEY"] + "-----SPLIT-----" + new["ALIPAY_PUBLIC_KEY"],
        text=True,
        capture_output=True,
        timeout=20,
    )
    if proc.returncode != 0 or "OK" not in proc.stdout:
        detail = "公钥与这把私钥是一对" if "SAME" in proc.stdout else (proc.stderr or proc.stdout or "解析失败")[:180]
        raise SystemExit(f"[x] 本地密钥校验失败：{detail}")


def main() -> int:
    src = arg_value("--from") or os.path.join(REPO, ".env")
    if not os.path.isfile(src):
        print(f"[x] 找不到凭据文件：{src}")
        return 2
    dot = load_dotenv(src)
    host = dot.get("DBEE_HOST") or os.environ.get("DBEE_HOST", "")
    user = dot.get("USER", "ubuntu")
    pwd = dot.get("SSH_PWD", "") or os.environ.get("SSH_PWD", "")
    app_id = (dot.get("ALIPAY_APP_ID") or dot.get("VITE_ALIPAY_APPID") or "").strip()
    private_raw = (dot.get("ALIPAY_PRIVATE_KEY") or "").strip()
    public_raw = (dot.get("ALIPAY_PUBLIC_KEY") or "").strip()

    print("═══ ⓪ 本地校验 ═══")
    print(f"  模式 = {'APPLY（会改生产）' if APPLY else 'DRY-RUN（不改生产）'}")
    print(f"  凭据文件 = {src}")
    if len(app_id) != 16 or not app_id.endswith(CONFIRMED_APP_TAIL):
        print(f"[x] ALIPAY_APP_ID / VITE_ALIPAY_APPID 不是已确认的尾号 {CONFIRMED_APP_TAIL}")
        return 2
    if not private_raw or not public_raw:
        print("[x] 私钥或支付宝公钥为空")
        return 2
    if not host or not pwd:
        print("[x] 凭据文件缺 DBEE_HOST 或 SSH_PWD")
        return 2
    new = {
        "ALIPAY_APP_ID": app_id,
        "ALIPAY_PRIVATE_KEY": pem_line(private_raw, "PRIVATE KEY", "PRIVATE KEY"),
        "ALIPAY_PUBLIC_KEY": pem_line(public_raw, "PUBLIC KEY", "PUBLIC KEY"),
    }
    validate_local(new)
    print(f"  ALIPAY_APP_ID = {app_id}")
    print(f"  ALIPAY_PRIVATE_KEY {fp(new['ALIPAY_PRIVATE_KEY'])}")
    print(f"  ALIPAY_PUBLIC_KEY  {fp(new['ALIPAY_PUBLIC_KEY'])}")
    print("  公钥与私钥不是一对，本地解析通过")

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"\n═══ 连接 {user}@{host} ═══")
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
        guard_before = {k: fp(cur.get(k, "")) for k in GUARD_KEYS}
        for k, v in guard_before.items():
            print(f"  {k:20s} {v}")
        print(f"  键总数 = {len(cur)}")
        print(f"  现有 ALIPAY_APP_ID = {cur.get('ALIPAY_APP_ID') or '<空>'}")
        print(f"  现有私钥 {fp(cur.get('ALIPAY_PRIVATE_KEY', ''))}")
        print(f"  现有公钥 {fp(cur.get('ALIPAY_PUBLIC_KEY', ''))}")

        new_body, changed, appended = build_new_body(body, new)
        print(f"\n═══ ② 拟改 {len(changed)} 键，新增 {len(appended)} 键 ═══")
        if not changed and not appended:
            print("三键已是目标值，生产无需改动")
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
                print(f"[x] 第 {i + 1} 行不是支付宝三键 —— 中止")
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
        print("  内存校验通过：只动支付宝三键，红线键未变")

        if not APPLY:
            print("\nDRY-RUN 结束，生产文件未改。确认后加 --apply。")
            return 0

        ts = time.strftime("%Y%m%d-%H%M%S")
        bak_dir = f"/etc/dbee/.bak-alipay-{ts}"
        print(f"\n═══ ③ 备份到 {bak_dir} ═══")
        rc, out, err = sh(
            f"sudo -n install -d -m 0750 -o root -g dbee {bak_dir} "
            f"&& sudo -n cp -a {ENV_FILE} {bak_dir}/gateway.env "
            f"&& sudo -n sha256sum {bak_dir}/gateway.env"
        )
        if rc != 0:
            print("[x] 备份失败 —— 未落盘")
            return 3
        print(f"  {out.strip()}")

        rc, home, _ = sh("echo $HOME")
        home = home.strip()
        stage = f"{home}/dbee-alipay-env"
        sh(f"rm -rf '{stage}' && mkdir -p '{stage}' && chmod 700 '{stage}'")
        sftp = cli.open_sftp()
        with sftp.open(f"{stage}/gateway.env", "w") as fh:
            fh.write(new_body)
        sftp.close()
        sh(f"chmod 600 '{stage}/gateway.env'")
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

        _rc, code, _err = sh(
            "curl -sS -m 20 -o /tmp/alipay-prepay.txt -w '%{http_code}' "
            "-X POST http://127.0.0.1:8080/.cloud/payment/apppay/prepay "
            "-H 'content-type: application/json' -d '{}'",
            timeout=40,
        )
        _rc, body_out, _err = sh("head -c 240 /tmp/alipay-prepay.txt")
        print(f"  prepay HTTP {code.strip()} body {body_out.strip()[:180]}")
        if "apppay_not_configured" in body_out or "alipay_not_configured" in body_out:
            print("[x] 仍是未配置 —— 回滚")
            sh(f"sudo -n cp -a {bak_dir}/gateway.env {ENV_FILE}")
            sh("sudo -n systemctl restart dbee-gateway && sleep 8", timeout=120)
            sh(f"rm -rf '{stage}'")
            return 1
        sh(f"rm -rf '{stage}'")
        print(f"\n支付宝三键已写入生产。备份在 {bak_dir}/gateway.env")
        print("未打开收费开关，也没有更换公开下载包。")
        return 0
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
