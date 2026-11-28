"""只检查本地支付宝私钥是否已换成新的一把。不打印密钥正文。"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys

_spec = importlib.util.spec_from_file_location(
    "apply_alipay_env",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "apply-alipay-env.py"),
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
CONFIRMED_APP_TAIL = _mod.CONFIRMED_APP_TAIL
load_dotenv = _mod.load_dotenv
pem_body = _mod.pem_body

OLD_APP_PUBLIC = (
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAgHWjCjq26CTnQmM5Ntg+"
    "AeEN4RNuSSH9wVI1PdNBRxC6TURYzBbgHkqqxheAB8DAJjBDL0qCJGoKahQNkpRX"
    "wbqKvm0BhJRsMijNb5XCLmDtO5vrI+qSaADOAIr5RYe/Ltzr5jEd99UgIIiU03Zb"
    "CjRyUYlHqwCwAzlAKJdWtRZT5ZFPxQFcZR4TsuTDsDZUacDxnW5Y226Na3zKoJ6a"
    "Lri3EfKkStvyn5HzE7Ya6XKR3LywNFD8jxuYMZY3UlI6GvpbtIbFPt7oXtzOZllM"
    "5zTVnx/I8fSJ9Qcm0P+9v4T53LXEJKNepWfi8FPN94xUeya6hHz7J/buSzX+Uif9"
    "7wIDAQAB"
)


def arg_value(flag: str) -> str:
    if flag not in sys.argv:
        return ""
    i = sys.argv.index(flag)
    return sys.argv[i + 1] if i + 1 < len(sys.argv) else ""


def main() -> int:
    src = arg_value("--from")
    if not src or not os.path.isfile(src):
        print("[x] 找不到凭据文件")
        return 2
    dot = load_dotenv(src)
    private = pem_body(dot.get("ALIPAY_PRIVATE_KEY", ""))
    public = pem_body(dot.get("ALIPAY_PUBLIC_KEY", ""))
    app_id = (dot.get("ALIPAY_APP_ID") or dot.get("VITE_ALIPAY_APPID") or "").strip()
    print(f"app_id_ok={len(app_id) == 16 and app_id.endswith(CONFIRMED_APP_TAIL)} private_body_len={len(private)} public_body_len={len(public)}")
    print(f"public_prefix={public[:16]} public_suffix={public[-8:]}")
    script = r"""
const { createPrivateKey, createPublicKey } = require('crypto')
let raw = ''
process.stdin.on('data', c => { raw += c })
process.stdin.on('end', () => {
  const payload = JSON.parse(raw)
  const key = createPrivateKey('-----BEGIN PRIVATE KEY-----\n' + payload.private + '\n-----END PRIVATE KEY-----\n')
  const derived = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')
  let pubErr = ''
  function tryPub(pem) {
    try { return createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64') }
    catch (e) { pubErr = String(e.message || e).split('\n')[0].slice(0, 160); return '' }
  }
  const pub = payload.public
  const asSpki = tryPub('-----BEGIN PUBLIC KEY-----\n' + pub + '\n-----END PUBLIC KEY-----\n')
  const asPkcs1 = tryPub('-----BEGIN RSA PUBLIC KEY-----\n' + pub + '\n-----END RSA PUBLIC KEY-----\n')
  const stored = asSpki || asPkcs1
  const format = asSpki ? 'spki' : (asPkcs1 ? 'pkcs1' : 'invalid')
  console.log([
    'parse=ok',
    'bits=' + (key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength),
    'same_as_old=' + (derived === payload.oldPublic),
    'public_format=' + format,
    'public_js_len=' + pub.length,
    'stored_is_app_public=' + (stored !== '' && stored === derived),
    'public_err=' + pubErr,
  ].join(' '))
})
"""
    proc = subprocess.run(
        ["node", "-e", script],
        input=json.dumps({"private": private, "public": public, "oldPublic": OLD_APP_PUBLIC}),
        text=True,
        capture_output=True,
        timeout=20,
    )
    print(proc.stdout.strip() or proc.stderr.strip()[:180])
    return 0 if proc.returncode == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
