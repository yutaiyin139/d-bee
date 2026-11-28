"""只读：看网关支付宝下单失败原因，并在服务器上试签一次。

不打印私钥、公钥、订单号。不改 gateway.env，不重启。
"""
from __future__ import annotations

import os
import sys

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


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


REMOTE = r"""
set +e
echo '=== journal ==='
sudo -n journalctl -u dbee-gateway --since '40 min ago' --no-pager \
  | grep '\[apppay\]' \
  | sed -E 's/order=[^ :]*/order=<redacted>/g' \
  | tail -n 30
echo '=== sign probe ==='
sudo -n python3 - <<'PY'
import re, subprocess, os
path = "/etc/dbee/gateway.env"
text = open(path, encoding="utf-8", errors="replace").read()
vals = {}
for line in text.splitlines():
    m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line)
    if m:
        vals[m.group(1)] = m.group(2)
raw = vals.get("ALIPAY_PRIVATE_KEY", "")
pem = raw.replace("\\n", "\n").strip()
header = "NONE"
mm = re.search(r"-----BEGIN ([A-Z0-9 ]+)-----", pem)
if mm:
    header = mm.group(1)
print("header=" + header)
print("raw_has_backslash_n=" + str("\\n" in raw))
print("pem_newlines=" + str(pem.count("\n")))
print("pem_len=" + str(len(pem)))
print("app_id_len=" + str(len(vals.get("ALIPAY_APP_ID", ""))))
open("/tmp/dbee-alipay-probe.pem", "w").write(pem + "\n")
os.chmod("/tmp/dbee-alipay-probe.pem", 0o600)
r = subprocess.run(
    ["openssl", "pkey", "-in", "/tmp/dbee-alipay-probe.pem", "-noout"],
    capture_output=True, text=True,
)
os.remove("/tmp/dbee-alipay-probe.pem")
err = (r.stderr or "").strip().splitlines()
print("openssl_rc=" + str(r.returncode))
print("openssl_err=" + (err[-1] if err else ""))
r2 = subprocess.run(
    ["openssl", "pkey", "-in", "/dev/stdin", "-noout", "-text"],
    input=pem + "\n", capture_output=True, text=True,
)
kind = "unknown"
for line in (r2.stdout or "").splitlines():
    s = line.strip()
    if s.startswith("Private-Key:") or s.startswith("Public-Key:") or "bit" in s and "Private" in s:
        kind = s
        break
    if "ASN1 OID" in s or s.startswith("RSA") or s.startswith("prime"):
        kind = s
        break
print("key_kind=" + kind)
pid = subprocess.run(["systemctl", "show", "-p", "MainPID", "--value", "dbee-gateway"], capture_output=True, text=True).stdout.strip()
print("pid=" + pid)
try:
    blob = open("/proc/" + pid + "/environ", "rb").read()
    item = next((x for x in blob.split(b"\0") if x.startswith(b"ALIPAY_PRIVATE_KEY=")), b"")
    val = item.split(b"=", 1)[1] if b"=" in item else b""
    print("proc_len=" + str(len(val)))
    print("proc_newlines=" + str(val.count(b"\n")))
    print("proc_bs_n=" + str(val.count(b"\\n")))
    print("proc_begin=" + str(b"BEGIN" in val))
    head = val[:40].decode("utf-8", "replace")
    print("proc_head_kind=" + ("PRIVATE" if "PRIVATE" in head else "OTHER" if head else "EMPTY"))
    def pem_body(s):
        s = re.sub(r"-----BEGIN [^-]+-----", "", s)
        s = re.sub(r"-----END [^-]+-----", "", s)
        return re.sub(r"\s+", "", s)
    file_body = pem_body(pem)
    proc_body = pem_body(val.decode("utf-8", "replace"))
    print("body_len_file=" + str(len(file_body)))
    print("body_len_proc=" + str(len(proc_body)))
    print("body_match=" + str(file_body == proc_body))
except Exception as ex:
    print("proc_err=" + type(ex).__name__)
unit = subprocess.run(["systemctl", "cat", "dbee-gateway"], capture_output=True, text=True)
for line in (unit.stdout or "").splitlines():
    if line.startswith("#") or line.startswith("EnvironmentFile") or line.startswith("ExecStart") or line.startswith("WorkingDirectory") or line.startswith("[Service]"):
        print("unit " + line[:200])
node = subprocess.run(["bash", "-lc", "command -v node"], capture_output=True, text=True)
print("node=" + (node.stdout or node.stderr).strip())
cfg = subprocess.run(["grep", "-n", "alipayPrivateKey", "/opt/dbee/server/lib/config.mjs"], capture_output=True, text=True)
line = (cfg.stdout or "").strip().splitlines()
print("config_line=" + (line[0][:180] if line else "missing"))
script = r'''
const fs = require("fs");
const crypto = require("crypto");
const text = fs.readFileSync("/etc/dbee/gateway.env", "utf8");
let raw = "";
for (const line of text.split(/\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && m[1] === "ALIPAY_PRIVATE_KEY") raw = m[2];
}
const pem = raw.replace(/\\n/g, "\n").trim();
function trySign(label, key) {
  try {
    const sig = crypto.createSign("RSA-SHA256").update("ping", "utf8").end().sign(key, "base64");
    console.log(label + "=ok len=" + sig.length);
  } catch (e) {
    console.log(label + "=fail " + (e && e.message ? e.message.split("\n")[0] : "error"));
  }
}
trySign("sign_pem", pem);
try {
  trySign("sign_keyobj", crypto.createPrivateKey(pem));
} catch (e) {
  console.log("createPrivateKey=fail " + (e && e.message ? e.message.split("\n")[0] : "error"));
}
const pid = "1412633";
try {
  const buf = fs.readFileSync("/proc/" + pid + "/environ");
  const item = buf.split(Buffer.from([0])).find((x) => x.slice(0, 20).toString() === "ALIPAY_PRIVATE_KEY=");
  if (!item) console.log("proc=missing");
  else {
    const val = item.slice("ALIPAY_PRIVATE_KEY=".length);
    console.log("proc_len=" + val.length);
    console.log("proc_newlines=" + val.filter((b) => b === 10).length);
    console.log("proc_bs_n=" + val.toString("utf8").split("\\n").length - 1);
    console.log("proc_begin=" + val.toString("utf8").includes("BEGIN"));
  }
} catch (e) {
  console.log("proc=unreadable");
}
'''
open("/tmp/dbee-alipay-probe.js", "w").write(script)
os.chmod("/tmp/dbee-alipay-probe.js", 0o600)
r3 = subprocess.run(["node", "/tmp/dbee-alipay-probe.js"], capture_output=True, text=True)
os.remove("/tmp/dbee-alipay-probe.js")
print(r3.stdout.strip())
if r3.returncode != 0:
    print("node_rc=" + str(r3.returncode))
    print((r3.stderr or "").strip().splitlines()[-1:] or [""])
PY
"""


def main() -> int:
    src = arg_value("--from") or os.path.join(REPO, ".env")
    dot = load_dotenv(src)
    host = (dot.get("DBEE_HOST") or "").strip()
    user = (dot.get("DBEE_SSH_USER") or "ubuntu").strip()
    pwd = (dot.get("SSH_PWD") or "").strip()
    if not host or not pwd:
        print("[x] 缺 SSH 凭据")
        return 2
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(host, username=user, password=pwd, timeout=30, banner_timeout=30, auth_timeout=30)
    try:
        _i, o, e = cli.exec_command(REMOTE, timeout=60)
        out = o.read().decode("utf-8", "replace")
        err = e.read().decode("utf-8", "replace")
        print(out)
        if err.strip():
            print(err)
        return o.channel.recv_exit_status()
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
