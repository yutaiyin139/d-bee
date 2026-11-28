/**
 * 在生产机上跑：查今晚这笔已支付虚拟订单的平台状态。
 * 状态 2/3（已支付待发货、发货中）时调用发货确认，然后再查一次。
 * 只打印状态码和金额，不打印单号、openid、密钥。
 */
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

const STATUS = {
  0: '未创建成功',
  1: '已创建未支付',
  2: '已支付待发货',
  3: '发货中',
  4: '已发货',
  5: '退款中（商户已扣款）',
  6: '已关闭',
  7: '退款失败',
  8: '已退款',
}

function loadEnv(path) {
  const env = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#') || !s.includes('=')) continue
    const i = s.indexOf('=')
    let v = s.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    env[s.slice(0, i)] = v
  }
  return env
}

function parseSecrets(raw) {
  const map = new Map()
  for (const part of String(raw || '').split(',')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const appid = part.slice(0, i).trim()
    const secret = part.slice(i + 1).trim()
    if (appid && secret) map.set(appid, secret)
  }
  return map
}

function paySig(appKey, uri, body) {
  return createHmac('sha256', appKey).update(`${uri}&${body}`, 'utf8').digest('hex')
}

async function api(env, token, uri, bodyObj) {
  const body = JSON.stringify(bodyObj)
  const sig = paySig(env.XPAY_APP_KEY, uri, body)
  const url = `https://api.weixin.qq.com${uri}?` + new URLSearchParams({
    access_token: token,
    pay_sig: sig,
  })
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(15000),
  })
  return resp.json().catch(() => null)
}

function line(order) {
  const st = Number(order?.status)
  const provide = Number(order?.provide_time) || 0
  return [
    `status=${st}`,
    `label=${STATUS[st] || '未知'}`,
    `order_type=${order?.order_type ?? ''}`,
    `paid_fee=${order?.paid_fee ?? ''}`,
    `order_fee=${order?.order_fee ?? ''}`,
    `provide_time=${provide > 0 ? 'yes' : 'no'}`,
    `sett_state=${order?.sett_state ?? ''}`,
  ].join(' ')
}

const env = loadEnv('/etc/dbee/gateway.env')
const secrets = parseSecrets(env.WECHAT_MINI_SECRETS)
const appid = env.XPAY_APPID || (secrets.size === 1 ? [...secrets.keys()][0] : '')
const secret = appid ? secrets.get(appid) : ''
if (!appid || !secret || !env.XPAY_APP_KEY) {
  console.log('missing_credential')
  process.exit(2)
}

const raw = execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-d', 'dbee', '-tA', '-c', `
SELECT order_no || E'\\t' || owner_id
  FROM public.payment_orders
 WHERE provider = 'wechat_xpay' AND status = 'paid'
   AND created_at > now() - interval '8 hours'
 ORDER BY created_at DESC
 LIMIT 1
`], { encoding: 'utf8' }).trim()
if (!raw || !raw.includes('\t')) {
  console.log('no_paid_order')
  process.exit(2)
}
const [orderNo, ownerId] = raw.split('\t')
const openid = ownerId.startsWith('wx:') ? ownerId.slice(3) : ''
if (!openid) {
  console.log('no_openid')
  process.exit(2)
}
console.log(`tail=${orderNo.slice(-4)}`)

const tokenUrl = 'https://api.weixin.qq.com/cgi-bin/token?' + new URLSearchParams({
  grant_type: 'client_credential',
  appid,
  secret,
})
const tokenResp = await fetch(tokenUrl, { signal: AbortSignal.timeout(15000) })
const tokenJson = await tokenResp.json().catch(() => null)
if (!tokenJson?.access_token) {
  console.log(`token_fail errcode=${tokenJson?.errcode ?? '?'}`)
  process.exit(2)
}

const before = await api(env, tokenJson.access_token, '/xpay/query_order', {
  openid, env: 0, order_id: orderNo,
})
if (!before || before.errcode !== 0 || !before.order) {
  console.log(`query_fail errcode=${before?.errcode ?? '?'} errmsg=${String(before?.errmsg ?? '').slice(0, 80)}`)
  process.exit(2)
}
console.log(`before ${line(before.order)}`)

const st = Number(before.order.status)
const isApple = Number(before.order.order_type) === 7
const allowConfirm = process.argv.includes('--confirm')
if ((st === 2 || st === 3) && !isApple && allowConfirm) {
  const notified = await api(env, tokenJson.access_token, '/xpay/notify_provide_goods', {
    order_id: orderNo, env: 0,
  })
  const ok = !!notified && notified.errcode === 0
  console.log(`notify=${ok ? 'ok' : 'fail'} errcode=${notified?.errcode ?? '?'}`)
  const after = await api(env, tokenJson.access_token, '/xpay/query_order', {
    openid, env: 0, order_id: orderNo,
  })
  if (!after || after.errcode !== 0 || !after.order) {
    console.log(`requery_fail errcode=${after?.errcode ?? '?'}`)
    process.exit(1)
  }
  console.log(`after ${line(after.order)}`)
} else if ((st === 2 || st === 3) && !isApple) {
  console.log('notify=not_run status_needs_confirm')
} else {
  console.log('notify=skipped')
}
