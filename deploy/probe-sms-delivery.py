#!/usr/bin/env python3
"""只读探针 ②：查阿里云「发送详情」，定性 139****1170 验证码到底卡在哪一段。

为什么需要：probe-sms-fail.py 已证明服务端 5 次 SendSms 全部 Code=OK（阿里云已受理），
  所以失败只可能在「阿里云 → 运营商 → 手机」这一段。QuerySendDetails 是唯一权威证据：
    SendStatus  1=等待回执  2=发送失败  3=发送成功
    ErrCode     运营商侧原因（黑名单 / 空号 / 关机 / 内容关键词拦截 / 频次限制 …）

安全约束（遵 MEMORY.md 铁律）：
  · 签名脚本 base64 后在服务器内执行 —— AK/SK 不出服务器、不落盘、不打印
  · 服务器上不写任何文件（脚本经 stdin 喂给 node，用完即散）
  · 手机号明文只存在于 base64 载荷内部；所有输出一律掩码（139****1170）
  · 全程只读：只调 QuerySendDetails（查询类 API，不产生短信、不改配置）

用法：python deploy/probe-sms-delivery.py
"""

from __future__ import annotations

import base64
import os
import sys

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(REPO, ".env")

# ── 服务器内执行的 Node 脚本（CommonJS，零依赖，用 node:https 手写 RPC 签名）──
# 与 server/lib/sms.mjs 的 aliyunRpcRequest 同一套签名规则（HMAC-SHA1 + Base64）。
NODE_SCRIPT = r"""
const https = require('https');
const crypto = require('crypto');

const AK = process.env.SMS_ALIYUN_ACCESS_KEY_ID || '';
const SK = process.env.SMS_ALIYUN_ACCESS_KEY_SECRET || '';
const HOST = (process.env.SMS_ALIYUN_ENDPOINT || 'dysmsapi.aliyuncs.com').replace(/^https?:\/\//, '');

if (!AK || !SK) { console.log('  [跳过] 服务器 env 缺 SMS_ALIYUN_ACCESS_KEY_ID/SECRET'); process.exit(0); }

const enc = (v) => encodeURIComponent(String(v))
  .replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');

function rpc(biz) {
  const p = Object.assign({
    Format: 'JSON', Version: '2017-05-25', AccessKeyId: AK,
    SignatureMethod: 'HMAC-SHA1',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Action: 'QuerySendDetails',
  }, biz);
  const canon = Object.keys(p).sort().map((k) => `${enc(k)}=${enc(p[k])}`).join('&');
  const sts = `GET&${enc('/')}&${enc(canon)}`;
  const sig = crypto.createHmac('sha1', SK + '&').update(sts).digest('base64');
  const path = `/?${canon}&Signature=${enc(sig)}`;
  return new Promise((resolve) => {
    const req = https.request({ host: HOST, path, method: 'GET', timeout: 15000,
      headers: { Host: HOST, Accept: 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf.slice(0, 300) }); } });
    });
    req.on('error', (e) => resolve({ Code: 'LOCAL_ERROR', Message: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ Code: 'LOCAL_TIMEOUT', Message: '15s' }); });
    req.end();
  });
}

const mask = (n) => (n && n.length >= 7 ? n.slice(0, 3) + '****' + n.slice(-4) : '(未知)');
const STATUS = { 1: '1=等待回执', 2: '2=发送失败', 3: '3=发送成功' };

// 待查号码（明文只在此载荷内部，输出一律掩码）；由本地注入
const PHONES = __PHONES__;
const DATE = '__DATE__';

(async () => {
  for (const ph of PHONES) {
    const r = await rpc({ PhoneNumber: ph, SendDate: DATE, PageSize: '20', CurrentPage: '1' });
    console.log(`── ${mask(ph)}  SendDate=${DATE} ──`);
    if (r.Code !== 'OK') {
      console.log(`   API 返回非 OK: Code=${r.Code} Message=${r.Message || ''} RequestId=${r.RequestId || ''}`);
      if (r.raw) console.log(`   raw=${r.raw}`);
      console.log('');
      continue;
    }
    const list = (r.SmsSendDetailDTOs && r.SmsSendDetailDTOs.SmsSendDetailDTO) || [];
    console.log(`   TotalCount=${r.TotalCount} 返回条数=${list.length}`);
    if (!list.length) console.log('   (无记录 —— 该号当天没有任何发送详情)');
    for (const it of list) {
      console.log(`   · SendStatus=${STATUS[it.SendStatus] || it.SendStatus} ErrCode=${it.ErrCode || '-'} `
        + `模板=${it.TemplateCode || '-'} 发出=${it.SendDate || '-'} 送达=${it.ReceiveDate || '-'}`);
      if (it.ErrCode && it.ErrCode !== 'OK' && it.ErrCode !== 'DELIVERED') {
        console.log(`     ↳ 运营商/通道错误码 ${it.ErrCode} 需对照阿里云错误码表定性`);
      }
    }
    console.log('');
  }
})();
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


def main() -> int:
    env = load_env()
    host = env.get("DBEE_HOST") or env.get("SSH_HOST") or ""
    user = env.get("USER") or "ubuntu"
    pwd = env.get("SSH_PWD") or ""
    if not host or not pwd:
        print("[x] .env 缺 DBEE_HOST / USER / SSH_PWD")
        return 2

    import json
    # 日志时间戳是北京时间 14:2x~14:5x，SendDate 用当天（yyyyMMdd）
    send_date = os.environ.get("PROBE_DATE") or "20261101"
    phones = ["13911111170", "18611114399", "18611104728"]
    # 号码与日期直接嵌进脚本再 base64 —— 服务器侧无需额外环境变量，
    # 明文号码只存在于 base64 载荷内部，所有输出一律掩码。
    script = (NODE_SCRIPT
              .replace("__PHONES__", json.dumps(phones))
              .replace("__DATE__", send_date))
    payload = base64.b64encode(script.encode()).decode()

    print(f"目标: {user}@{host}  查询日期={send_date}  号码数={len(phones)}（输出掩码）\n")

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        cli.connect(host, username=user, password=pwd, timeout=25,
                    banner_timeout=25, auth_timeout=25)
    except Exception as exc:  # noqa: BLE001
        print(f"[x] SSH 连接失败: {type(exc).__name__}: {exc}")
        return 3
    tr = cli.get_transport()
    if tr:
        tr.set_keepalive(30)

    def run(title: str, cmd: str, limit: int = 60) -> None:
        print(f"───── {title} ─────")
        _, so, se = cli.exec_command(cmd, timeout=90)
        out = so.read().decode("utf-8", "replace").strip()
        err = se.read().decode("utf-8", "replace").strip()
        for line in (out.splitlines()[:limit] if out else []):
            print("  " + line)
        for line in (err.splitlines()[:6] if err else []):
            print("  [stderr] " + line)
        if not out and not err:
            print("  (无输出)")
        print()

    # 0) 视觉链路生效配置（模型名/base url 非敏感；密钥只报存在性）
    run(
        "LLM / 视觉链路生效配置（密钥只报存在性）",
        "sudo -n sh -c 'for k in LLM_BASE_URL LLM_MODEL_TEXT LLM_MODEL_VISION "
        "LLM_VISION_BASE_URL LLM_VISION_MODEL LLM_IMAGE_DETAIL LLM_TIMEOUT_MS; do "
        "v=$(grep -E \"^${k}=\" /etc/dbee/gateway.env 2>/dev/null | head -1 | cut -d= -f2-); "
        "echo \"$k=${v:-(未设置)}\"; done; "
        "for k in LLM_API_KEY LLM_VISION_API_KEY; do "
        "v=$(grep -E \"^${k}=\" /etc/dbee/gateway.env 2>/dev/null | head -1 | cut -d= -f2-); "
        "if [ -n \"$v\" ]; then echo \"$k 已配置 len=${#v}\"; else echo \"$k (未设置)\"; fi; done' 2>&1",
    )

    # 1) 发送详情查询（决定性证据）
    run(
        "阿里云 QuerySendDetails：三个号码的送达详情",
        "sudo -n sh -c 'set -a; . /etc/dbee/gateway.env; set +a; "
        f"echo {payload} | base64 -d | /usr/local/bin/node' 2>&1",
    )

    # 2) 今天全部 [llm] 记录（看识别耗时/次数，对应「识别超 1 分钟」）
    run(
        "今日全部 [llm] 调用记录（含 reasoning_tokens）",
        "sudo -n sh -c 'journalctl -u dbee-gateway --since today --no-pager 2>/dev/null "
        "| grep -E \"\\[llm\\]\" | tail -20' 2>&1",
    )

    cli.close()
    print("探针结束（全程只读：仅查询类 API，未发短信、未改配置、未写文件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
