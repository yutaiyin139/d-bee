/**
 * 在生产机上对支付宝网关做只读验签探测。
 * 调用 alipay.trade.query，订单号不存在，不会扣款、不会建支付单。
 * 只打印 code / sub_code / sub_msg 和密钥形态，不打印私钥、签名、完整单号。
 */
import { readFileSync } from 'node:fs'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { rsaSign, rsaVerify, alipayEncode, alipayTimestamp } from '/opt/dbee-gateway/lib/apppay.mjs'

function loadEnv(path) {
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    const i = t.indexOf('=')
    const k = t.slice(0, i)
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[k] = v
  }
  return out
}

function signContent(params, includeSignType) {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && (includeSignType || k !== 'sign_type'))
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
}

function buildBody(params, pem, includeSignType) {
  const sign = rsaSign(pem, signContent(params, includeSignType))
  const pairs = Object.entries(params).map(([k, v]) => `${alipayEncode(k)}=${alipayEncode(v)}`)
  pairs.push(`sign=${alipayEncode(sign)}`)
  return pairs.join('&')
}

function summarize(text) {
  const start = text.indexOf('{')
  if (start < 0) return `nonjson len=${text.length}`
  try {
    const data = JSON.parse(text.slice(start))
    const r = data.alipay_trade_query_response
      || data.alipay_trade_app_pay_response
      || data.error_response
      || data
    return `code=${r.code || ''} msg=${r.msg || ''} sub_code=${r.sub_code || ''} sub_msg=${String(r.sub_msg || '').slice(0, 80)}`
  } catch {
    return `parse_fail len=${text.length}`
  }
}

function pemBody(s) {
  return String(s).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
}

const env = loadEnv('/etc/dbee/gateway.env')
const appId = (env.ALIPAY_APP_ID || '').trim()
const pem = (env.ALIPAY_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim()
const storedPub = (env.ALIPAY_PUBLIC_KEY || '').replace(/\\n/g, '\n').trim()
const head = pem.startsWith('-----BEGIN PRIVATE KEY-----') ? 'PKCS8'
  : pem.startsWith('-----BEGIN RSA PRIVATE KEY-----') ? 'PKCS1' : 'UNKNOWN'
let bits = 'unreadable'
let derivedBody = ''
let derivedPem = ''
try {
  const key = createPrivateKey(pem)
  bits = String(key.asymmetricKeyDetails?.modulusLength || 'unknown')
  const pub = createPublicKey(key)
  derivedPem = pub.export({ type: 'spki', format: 'pem' })
  derivedBody = pemBody(derivedPem)
} catch {
  bits = 'unreadable'
}
const names = Object.keys(env).filter((k) => k.startsWith('ALIPAY')).map((k) => `${k}:${String(env[k]).length}`)
console.log(`appId_len=${appId.length} appId_tail=${appId.slice(-4)} pem=${head} bits=${bits}`)
console.log(`env_keys=${names.join(',')}`)
console.log(`derived_equals_stored_public=${derivedBody !== '' && derivedBody === pemBody(storedPub)}`)
console.log(`derived_pub_len=${derivedBody.length}`)

const params = {
  app_id: appId,
  method: 'alipay.trade.query',
  format: 'JSON',
  charset: 'utf-8',
  sign_type: 'RSA2',
  timestamp: alipayTimestamp(),
  version: '1.0',
  biz_content: JSON.stringify({ out_trade_no: 'DIAGPROBE0001' }),
}

const content = signContent(params, true)
const sign = rsaSign(pem, content)
console.log(`local_verify=${derivedPem ? rsaVerify(derivedPem, content, sign) : false}`)

for (const include of [true]) {
  const label = include ? 'sign_type_in' : 'sign_type_out'
  const resp = await fetch('https://openapi.alipay.com/gateway.do', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: buildBody(params, pem, include),
  })
  const text = await resp.text()
  console.log(`${label} http=${resp.status} ${summarize(text)}`)
}

const appParams = {
  app_id: appId,
  method: 'alipay.trade.app.pay',
  format: 'JSON',
  charset: 'utf-8',
  sign_type: 'RSA2',
  timestamp: alipayTimestamp(),
  version: '1.0',
  notify_url: 'https://d-bee.cn/.cloud/payment/alipay/notify',
  biz_content: JSON.stringify({
    out_trade_no: 'DIAGPROBE0002',
    total_amount: '0.01',
    subject: 'diag',
    product_code: 'QUICK_MSECURITY_PAY',
  }),
}
const appResp = await fetch('https://openapi.alipay.com/gateway.do', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
  body: buildBody(appParams, pem, true),
})
const appBuf = Buffer.from(await appResp.arrayBuffer())
const appText = new TextDecoder('gbk').decode(appBuf)
const title = (appText.match(/<title>([^<]{0,80})<\/title>/) || [])[1] || ''
const phrases = [...appText.matchAll(/[\u4e00-\u9fff，。！]{6,40}/g)].map((m) => m[0]).slice(0, 8)
console.log(`app_pay http=${appResp.status} len=${appBuf.length} title=${title}`)
console.log(`app_pay phrases=${phrases.join(' | ')}`)

const form = new URLSearchParams()
for (const [k, v] of Object.entries(params)) form.append(k, v)
form.append('sign', sign)
const formResp = await fetch('https://openapi.alipay.com/gateway.do', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
  body: form.toString(),
})
console.log(`form_plus http=${formResp.status} ${summarize(await formResp.text())}`)
