"""在服务器上执行。由 fix-alipay-pem-quoting.py 上传。不要单独带密钥运行。"""
from __future__ import annotations

import hashlib
import re
import subprocess
import sys
import time

ENV_FILE = "/etc/dbee/gateway.env"
KEYS = ("ALIPAY_PRIVATE_KEY", "ALIPAY_PUBLIC_KEY")
GUARDS = ("IDENT_PEPPER", "JWT_SECRET", "SMS_MASTER_CODE")
APPLY = len(sys.argv) > 1 and sys.argv[1] == "apply"


def fp(v: str) -> str:
    if not v:
        return "empty"
    return "sha256:" + hashlib.sha256(v.encode()).hexdigest()[:8] + " len=" + str(len(v))


def parse_map(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def pem_body(text: str) -> str:
    text = re.sub(r"-----BEGIN [^-]+-----", "", text)
    text = re.sub(r"-----END [^-]+-----", "", text)
    return re.sub(r"\s+", "", text)


def systemd_value(raw: str) -> str:
    v = raw.strip()
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        v = v[1:-1].replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
    else:
        v = v.replace("\\n", "\n")
    return v


def quote_lines(text: str) -> str:
    out = []
    for line in text.splitlines():
        m = re.match(r"^([A-Z_][A-Z0-9_]*)=(.*)$", line)
        if m and m.group(1) in KEYS:
            key, val = m.group(1), m.group(2)
            if not (val.startswith('"') and val.endswith('"')):
                if '"' in val:
                    raise SystemExit("[x] " + key + " 含双引号，中止")
                val = '"' + val + '"'
            out.append(f"{key}={val}")
        else:
            out.append(line)
    trailing = "\n" if text.endswith("\n") or text.endswith("\r\n") else ""
    return "\n".join(out) + trailing


def probe_systemd() -> bool:
    path = "/tmp/dbee-esc-probe.env"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write('PROBE="A\\nB\\nC"\n')
    print("probe_file=" + open(path, encoding="utf-8").read().replace("\n", "\\n"))
    try:
        r = subprocess.run(
            [
                "systemd-run", "--quiet", "--pipe", "--wait", "--collect",
                "-p", "EnvironmentFile=" + path,
                "/usr/bin/python3", "-c",
                "import os; v=os.environ.get('PROBE',''); print('len='+str(len(v))); print('nl='+str(v.count(chr(10)))); print('bs='+str(v.count(chr(92)))); print(repr(v))",
            ],
            capture_output=True, text=True, timeout=30,
        )
    finally:
        try:
            os_remove(path)
        except Exception:
            pass
    lines = [x.strip() for x in (r.stdout or "").splitlines() if x.strip()]
    print("probe_rc=" + str(r.returncode))
    print("probe_out=" + " | ".join(lines[-6:]))
    if r.returncode != 0 and r.stderr:
        print("probe_err=" + r.stderr.strip().splitlines()[-1])
    # 这台 systemd 不把引号里的 \n 变成换行，但会去掉引号并保留反斜杠。
    # 无引号时反斜杠会被吃掉。保留下来的 \n 由 config.mjs 再还原成换行。
    joined = " ".join(lines)
    return r.returncode == 0 and "len=7" in joined and "bs=2" in joined and "nl=0" in joined


def os_remove(path: str) -> None:
    import os
    os.remove(path)


def sign_ok(pem: str) -> bool:
    r = subprocess.run(
        ["node", "-e", "const c=require('crypto'); let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>{ try { c.createSign('RSA-SHA256').update('ping').end().sign(s,'base64'); console.log('ok') } catch(e) { console.log('fail') } })"],
        input=pem, text=True, capture_output=True, timeout=20,
    )
    return "ok" in (r.stdout or "")


def main() -> int:
    print("mode=" + ("apply" if APPLY else "dry"))
    if not probe_systemd():
        print("[x] 双引号没能保住换行转义，未改 env")
        return 2
    print("probe=ok")
    original = open(ENV_FILE, encoding="utf-8").read()
    before = parse_map(original)
    for k in GUARDS:
        print(f"guard {k} {fp(before.get(k, ''))}")
    new_text = quote_lines(original)
    after = parse_map(new_text)
    if [before.get(k, "") for k in GUARDS] != [after.get(k, "") for k in GUARDS]:
        print("[x] 红线键被碰到，中止")
        return 3
    changed = [k for k in KEYS if before.get(k) != after.get(k)]
    print("will_quote=" + ",".join(changed) if changed else "will_quote=none")
    if not APPLY:
        print("dry-run，未改文件")
        return 0
    if not changed:
        print("已经是带引号的写法")
    else:
        ts = time.strftime("%Y%m%d-%H%M%S")
        bak = f"/etc/dbee/.bak-alipay-quote-{ts}"
        subprocess.check_call(["install", "-d", "-m", "0750", "-o", "root", "-g", "dbee", bak])
        subprocess.check_call(["cp", "-a", ENV_FILE, bak + "/gateway.env"])
        print("backup=" + bak)
        tmp = "/tmp/dbee-gateway.env.quoted"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(new_text)
        subprocess.check_call(["install", "-m", "0640", "-o", "root", "-g", "dbee", tmp, ENV_FILE])
        os_remove(tmp)
        checked = parse_map(open(ENV_FILE, encoding="utf-8").read())
        if [checked.get(k, "") for k in GUARDS] != [before.get(k, "") for k in GUARDS]:
            subprocess.check_call(["cp", "-a", bak + "/gateway.env", ENV_FILE])
            print("[x] 回读红线键变化，已还原")
            return 3
        for k in KEYS:
            if not (checked.get(k, "").startswith('"') and checked.get(k, "").endswith('"')):
                subprocess.check_call(["cp", "-a", bak + "/gateway.env", ENV_FILE])
                print("[x] " + k + " 未加上引号，已还原")
                return 3
    print("restart")
    subprocess.check_call(["systemctl", "restart", "dbee-gateway"])
    time.sleep(6)
    hz = subprocess.run(
        ["curl", "-sS", "-m", "15", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:8080/.cloud/healthz"],
        capture_output=True, text=True,
    )
    print("healthz=" + (hz.stdout or "").strip())
    pid = subprocess.check_output(["systemctl", "show", "-p", "MainPID", "--value", "dbee-gateway"], text=True).strip()
    blob = open("/proc/" + pid + "/environ", "rb").read()
    env = {}
    for item in blob.split(b"\0"):
        if b"=" in item:
            k, v = item.split(b"=", 1)
            env[k.decode()] = v.decode("utf-8", "replace")
    file_map = parse_map(open(ENV_FILE, encoding="utf-8").read())
    ok = True
    for k in KEYS:
        got = env.get(k, "")
        got_pem = got.replace("\\n", "\n")
        expect = systemd_value(file_map.get(k, ""))
        match = pem_body(got_pem) == pem_body(expect) and "\\n" in got
        print(f"{k} bs_n={got.count(chr(92)+'n')} body_match={match} begin={'BEGIN' in got}")
        env[k] = got_pem
        if not match:
            ok = False
    if not sign_ok(env.get("ALIPAY_PRIVATE_KEY", "")):
        print("sign=fail")
        ok = False
    else:
        print("sign=ok")
    if not ok:
        print("[x] 进程里的密钥仍然不可用。env 已是带引号的版本，需要人工看备份")
        return 3
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
