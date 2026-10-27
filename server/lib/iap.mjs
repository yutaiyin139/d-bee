/**
 * C1 · Apple IAP 验签与核销（App Store）。
 *
 * ── 为什么在 Node 网关做（而不是数据库 RPC）─────────────────────────────
 *   0029 曾试图用 pg_net 在 verify_payment_order 里直接外呼 Apple，
 *   但服务器 PG17.11 无 pg_net（实测 count=0），该迁移已标 void。
 *   10-22 决策 #6 拍板：验签落在 Node 网关。数据库只保留两个
 *   SECURITY DEFINER 函数（settle_apple_purchase / revoke_apple_purchase，
 *   见迁移 0037）负责**原子落库**，网关负责**外呼 Apple + 报文校验**。
 *
 * ── 端点 ────────────────────────────────────────────────────────────────
 *   POST /.cloud/payment/apple/verify         客户端购买/恢复后回传收据 → 验签 → 核销
 *   POST /.cloud/payment/apple/notifications  App Store Server Notifications V2（webhook）
 *
 * ── verify 的安全边界（每一条都对应一个真实攻击面）──────────────────────
 *   1. 必须带网关签发的 Bearer JWT —— 权益发给「当前登录用户」，不发给收据持有者；
 *   2. 收据必须过 Apple verifyReceipt（status=0），**绝不**信任客户端自报的
 *      product_id / transaction_id —— 一律以 Apple 返回报文为准；
 *   3. receipt.bundle_id 必须等于 APPLE_BUNDLE_ID —— 防止拿别家 App 的
 *      合法收据来换本 App 会员（verifyReceipt 对任何 App 的收据都返 0）；
 *   4. transaction_id 在 apple_transactions 里 UNIQUE —— 同一笔交易全服只能
 *      核销一次；换账号重放同一收据会被「已归属他人」拒绝；
 *   5. 沙盒/生产自动切换（21007/21008），提审期间沙盒账号可正常购买。
 *
 * ── webhook（V2 通知）──────────────────────────────────────────────────
 *   Apple POST { signedPayload: "<JWS>" }。JWS 头里的 x5c 是三级证书链，
 *   校验步骤（对照 App Store Server API 官方文档）：
 *     ① 链尾必须逐字节等于仓库内置的 AppleRootCA-G3（sha256 指纹钉扎，
 *        见 server/assets/AppleRootCA-G3.cer，2026-10-23 从
 *        apple.com/certificateauthority 下载，指纹 63343abf…3e9179）；
 *     ② leaf/intermediate 逐级验签 + 有效期检查；
 *     ③ leaf 必须含 Apple 专用扩展 OID 1.2.840.113635.100.6.11.1；
 *     ④ ES256 验 signedPayload 本体；
 *     ⑤ payload.data.signedTransactionInfo 是嵌套 JWS，同样流程再验一次。
 *   处理的通知类型：SUBSCRIBED / DID_RENEW（续订核销）、REFUND / REVOKE
 *   （撤销权益）、其余仅落库留痕（apple_notifications）。
 *   永远尽力返回 200：处理失败也先落库，Apple 收到非 200 会重试造成堆积。
 *   验签失败除外（400，那不是 Apple 发的）。
 */
import { createHash, createVerify, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyJwt, bearerFrom } from './jwt.mjs'
import { cloudError } from './http.mjs'
import { getTokenVersion } from './identity.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Apple Root CA - G3（DER）。webhook JWS 的 x5c 链尾必须与它逐字节一致。 */
export const APPLE_ROOT_CA_DER = readFileSync(resolve(HERE, '../assets/AppleRootCA-G3.cer'))
const APPLE_ROOT_CA_SHA256 = createHash('sha256').update(APPLE_ROOT_CA_DER).digest('hex')

/** leaf 证书必须携带的 Apple 专用扩展 OID 1.2.840.113635.100.6.11.1 的 DER 编码 */
const APPLE_OID_DER = Buffer.from('060a2a864886f76364 060b01'.replace(/\s+/g, ''), 'hex')

const VERIFY_URL_PROD = 'https://buy.itunes.apple.com/verifyReceipt'
const VERIFY_URL_SANDBOX = 'https://sandbox.itunes.apple.com/verifyReceipt'

/** 外呼 Apple 的超时。verifyReceipt 常规 <2s，跨境网络抖动留足余量。 */
const APPLE_TIMEOUT_MS = 20_000

/** verifyReceipt 状态码 → 用户可读文案（只列需要区分的；其余走通用文案） */
const RECEIPT_STATUS_MESSAGES = {
  21000: 'App Store 读取请求失败，请稍后重试',
  21002: '收据数据损坏，请重新购买或恢复',
  21003: '收据校验未通过',
  21004: '共享密钥不匹配（服务端配置问题）',
  21005: '收据服务暂不可用，请稍后重试',
  21006: '收据有效但订阅已过期',
  21009: '内部数据访问错误，请稍后重试',
  21010: '收据有效但交易已退款或被撤销',
}

// ── 基础工具 ────────────────────────────────────────────────────────────

const b64uDecode = (s) => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')

/** 收据可能很大（几十 KB base64），库里只存摘要，全文留在 Apple 侧 */
const receiptDigest = (receipt) => sha256Hex(Buffer.from(String(receipt)))

/**
 * 调 Apple verifyReceipt。
 * @param {object} cfg
 * @param {string} receiptData base64 收据
 * @param {string} url 生产或沙盒地址
 * @param {typeof globalThis.fetch} [fetchImpl] 可注入（自测用）
 * @returns {Promise<{httpStatus:number, body:object}>}
 */
async function callVerifyReceipt(cfg, receiptData, url, fetchImpl) {
  const doFetch = fetchImpl ?? globalThis.fetch
  const resp = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      'receipt-data': receiptData,
      // 自动续期订阅商品必须带共享密钥，否则返 21004
      password: cfg.appleSharedSecret || undefined,
      'exclude-old-transactions': true,
    }),
    signal: AbortSignal.timeout(APPLE_TIMEOUT_MS),
  })
  const text = await resp.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw Object.assign(new Error('Apple 返回了非 JSON 响应'), { status: 502, detail: text.slice(0, 200) })
  }
  return { httpStatus: resp.status, body }
}

/**
 * 生产/沙盒自动切换的完整验签流程。
 * 起点由 cfg.appleSandbox 决定；无论起点是哪个，遇到 21007（沙盒收据发到生产）
 * 或 21008（生产收据发到沙盒）都自动换边重验一次 —— 这是 Apple 官方推荐做法，
 * 保证提审期（审核员用沙盒账号）与上架后（真实用户）共用同一段代码。
 */
async function verifyReceiptWithFallback(cfg, receiptData, fetchImpl) {
  const first = cfg.appleSandbox ? VERIFY_URL_SANDBOX : VERIFY_URL_PROD
  const second = cfg.appleSandbox ? VERIFY_URL_PROD : VERIFY_URL_SANDBOX
  let r = await callVerifyReceipt(cfg, receiptData, first, fetchImpl)
  const st = Number(r.body?.status)
  if ((st === 21007 && first === VERIFY_URL_PROD) || (st === 21008 && first === VERIFY_URL_SANDBOX)) {
    r = await callVerifyReceipt(cfg, receiptData, second, fetchImpl)
  }
  return r
}

/**
 * 从 verifyReceipt 响应里挑出本次要核销的那笔交易。
 *
 * 候选来源两处：
 *   · latest_receipt_info —— 自动续期订阅的交易列表（新→旧）
 *   · receipt.in_app      —— 非消耗型/非续期商品（dbee_lifetime 在这）
 * 选择优先级：
 *   ① 客户端回传的 transaction_id 精确命中（正常购买路径）
 *   ② 订单的 product_id 命中里取最新一笔（客户端丢 txn id 时兜底）
 *   ③ 全列表最新一笔（恢复购买：客户端本来就不知道具体哪笔）
 */
function pickTransaction(body, wantTxnId, wantProductId) {
  const list = []
  if (Array.isArray(body?.latest_receipt_info)) list.push(...body.latest_receipt_info)
  if (Array.isArray(body?.receipt?.in_app)) list.push(...body.receipt.in_app)
  if (!list.length) return null
  if (wantTxnId) {
    const hit = list.find((t) => String(t.transaction_id ?? '') === String(wantTxnId))
    if (hit) return hit
  }
  if (wantProductId) {
    const hits = list.filter((t) => t.product_id === wantProductId)
    if (hits.length) return hits[0] // latest_receipt_info 新→旧；in_app 也是新→旧
  }
  return list[0]
}

// ── JWS（App Store Server Notifications V2）────────────────────────────

/**
 * 校验 x5c 证书链并返回 leaf 证书。
 * 钉扎根证书 + 逐级验签 + 有效期 + Apple 专用 OID，一个都不能少：
 * 少了钉扎 = 任何人自签一条链就能伪造通知给你发会员/吊销会员。
 */
function verifyCertChain(x5c) {
  if (!Array.isArray(x5c) || x5c.length < 2) {
    throw new Error('x5c 证书链缺失或过短')
  }
  const ders = x5c.map((b64) => Buffer.from(String(b64), 'base64'))
  // ① 根证书钉扎（逐字节 sha256）
  const rootDer = ders[ders.length - 1]
  if (sha256Hex(rootDer) !== APPLE_ROOT_CA_SHA256) {
    throw new Error('x5c 链尾不是钉扎的 Apple Root CA - G3')
  }
  const certs = ders.map((d) => new X509Certificate(d))
  const now = Date.now()
  // ② 逐级：issuer 签发校验 + 签名验证 + 有效期
  for (let i = 0; i < certs.length; i++) {
    const c = certs[i]
    if (now < c.validFrom.getTime() || now > c.validTo.getTime()) {
      throw new Error(`x5c[${i}] 不在有效期内`)
    }
    if (i + 1 < certs.length) {
      const issuer = certs[i + 1]
      if (!c.checkIssued(issuer) || !c.verify(issuer.publicKey)) {
        throw new Error(`x5c[${i}] 未通过上级证书验签`)
      }
    }
  }
  // ③ leaf 必须带 Apple 的 App Store Server Notification 扩展 OID
  const leaf = certs[0]
  if (!leaf.raw.includes(APPLE_OID_DER)) {
    throw new Error('leaf 证书缺少 Apple 专用扩展 OID（1.2.840.113635.100.6.11.1）')
  }
  return leaf
}

/**
 * 验证并解码一个 JWS（ES256 + x5c）。失败抛异常，成功返回 payload 对象。
 * 只接受 ES256 —— 与 jwt.mjs 拒 alg 混淆同理，不接受报文自报的其他算法。
 * （导出给 tools/iap-selftest.mjs 做证书链正/负用例）
 */
export function verifyJws(jws) {
  const parts = String(jws).split('.')
  if (parts.length !== 3) throw new Error('JWS 段数不是 3')
  let header
  try {
    header = JSON.parse(b64uDecode(parts[0]).toString('utf8'))
  } catch {
    throw new Error('JWS header 不是合法 JSON')
  }
  if (header?.alg !== 'ES256') throw new Error(`JWS alg=${header?.alg}，只接受 ES256`)
  const leaf = verifyCertChain(header.x5c)
  // ES256 的 JWS 签名是 raw r||s（ieee-p1363），不是 DER
  const sig = b64uDecode(parts[2])
  const ok = createVerify('SHA256')
    .update(`${parts[0]}.${parts[1]}`)
    .verify({ key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, sig)
  if (!ok) throw new Error('JWS 签名验证失败')
  return JSON.parse(b64uDecode(parts[1]).toString('utf8'))
}

// ── 处理器工厂 ──────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {object} deps.cfg     loadConfig() 产物（读 appleBundleId/appleSharedSecret/appleSandbox）
 * @param {object} deps.pool    业务角色连接池（dbee_app；调 0037 的 definer 函数）
 * @param {object} deps.logger
 * @param {typeof globalThis.fetch} [deps.fetchImpl] 自测注入（Apple verifyReceipt 外呼）
 * @param {(jws:string)=>object} [deps.verifyJwsImpl] 自测注入（webhook JWS 验签）。
 *        默认用真实的 x5c 证书链验证；自测里注入它可跳过「伪造 Apple 证书链」
 *        这一不可能步骤，专测 SUBSCRIBED/DID_RENEW/REFUND 的处理分支。
 */
export function createIapHandlers(deps) {
  const { cfg, pool, logger, gatewayPool } = deps
  const fetchImpl = deps.fetchImpl
  const jwsVerify = deps.verifyJwsImpl ?? verifyJws

  /** 未配 APPLE_BUNDLE_ID 时端点整体不可用（对齐 gateway.env.template 的承诺） */
  function notConfigured(res) {
    return cloudError(res, 503, 'Apple IAP 未配置（缺少 APPLE_BUNDLE_ID）', 'iap_not_configured')
  }

  /** 取并校验 Bearer → ownerId；失败返回 null（🔴 安全审计①：带 token_version 校验） */
  async function authOwnerId(req) {
    const token = bearerFrom(req.headers)
    if (!token) return null
    const v = verifyJwt(token, cfg.jwtSecret)
    if (!v) return null
    const sub = v?.payload?.sub
    if (typeof sub !== 'string' || !sub) return null
    if (gatewayPool && Number.isInteger(v.payload.ver)) {
      try {
        const cur = await getTokenVersion(gatewayPool, sub)
        if (cur == null || cur !== v.payload.ver) return null
      } catch (err) {
        logger.error(`[iap] token_version 查询失败，跳过版本校验: ${err?.message || err}`)
      }
    }
    return sub
  }

  return {
    /**
     * POST /.cloud/payment/apple/verify
     * body: { receipt: string, order_no?: string, provider_txn_id?: string }
     *   · receipt 必填（base64 App Store 收据）
     *   · order_no 可选；`restore-…` 前缀 = 恢复购买（无订单，只核销交易）
     *   · provider_txn_id 可选；仅用于在收据的多笔交易里定位，**不作为信任依据**
     * 返回: { settled: true, plan, pro_until, duplicate } 或 CloudError 形状
     */
    async verify(req, res, body) {
      if (!cfg.appleBundleId) return notConfigured(res)
      const ownerId = await authOwnerId(req)
      if (!ownerId) return cloudError(res, 401, '未登录或登录已过期', 'unauthorized')

      const receipt = typeof body?.receipt === 'string' ? body.receipt.trim() : ''
      if (!receipt) return cloudError(res, 400, '缺少收据数据', 'missing_receipt')
      const orderNo = typeof body?.order_no === 'string' && body.order_no.trim() ? body.order_no.trim() : null
      const isRestore = !!orderNo && orderNo.startsWith('restore-')
      const clientTxnId = typeof body?.provider_txn_id === 'string' ? body.provider_txn_id.trim() : ''

      // ① 外呼 Apple 验签（沙盒/生产自动切换）
      let apple
      try {
        apple = await verifyReceiptWithFallback(cfg, receipt, fetchImpl)
      } catch (err) {
        logger.error(`[iap] verifyReceipt 外呼失败: ${err?.message || err}`)
        return cloudError(res, 502, 'Apple 收据服务暂不可用，请稍后重试', 'apple_unreachable')
      }

      // ② 状态码判定
      const st = Number(apple.body?.status)
      if (apple.httpStatus !== 200 || st !== 0) {
        // 21006（订阅过期）在「恢复购买」场景是常态，不算错误但也无可核销
        const msg = RECEIPT_STATUS_MESSAGES[st] || '支付校验失败，请稍后重试或联系客服'
        logger.warn(`[iap] verifyReceipt status=${st} http=${apple.httpStatus} owner=${ownerId}`)
        return cloudError(res, 402, msg, `apple_status_${st}`)
      }

      // ③ bundle_id 钉扎：防「别家 App 的合法收据换本 App 会员」
      const bundleId = apple.body?.receipt?.bundle_id
      if (bundleId !== cfg.appleBundleId) {
        logger.warn(`[iap] bundle_id 不匹配: got=${bundleId} want=${cfg.appleBundleId} owner=${ownerId}`)
        return cloudError(res, 402, '收据不属于本应用', 'bundle_mismatch')
      }

      // ③b 🔴 环境白名单（0039）：上架后拒绝 Sandbox 收据。
      //   沙盒收据是 Apple 签发的**真**收据（验签必过），但对应的是假钱购买；
      //   不校验 environment = 任何沙盒账号都能白拿会员。
      //   提审期（APPLE_SANDBOX=true）白名单含 Sandbox，审核员不受影响。
      const env_ = String(apple.body?.environment ?? '')
      if (!cfg.appleAllowedEnvs?.has(env_)) {
        logger.warn(`[iap] environment 不在白名单: got=${env_ || '<缺失>'} want=${[...(cfg.appleAllowedEnvs ?? [])].join('/')} owner=${ownerId}`)
        return cloudError(res, 402, '收据环境与当前服务不符', 'environment_mismatch')
      }

      // ④ 有订单则读订单（product_id 用于交易定位；owner 不符只警告不阻断 ——
      //    收据是真的，权益发给当前登录用户即可，订单侧保持 pending 留痕）
      let orderProductId = null
      if (orderNo && !isRestore) {
        try {
          const { rows } = await pool.query(
            'SELECT owner_id, product_id, status FROM public.payment_orders WHERE order_no = $1',
            [orderNo],
          )
          const order = rows[0]
          if (order) {
            orderProductId = order.product_id
            if (order.owner_id !== ownerId) {
              logger.warn(`[iap] 订单归属不符 order=${orderNo} order_owner=${order.owner_id} jwt=${ownerId}`)
            }
          } else {
            logger.warn(`[iap] 订单不存在 order=${orderNo} jwt=${ownerId}`)
          }
        } catch (err) {
          // 订单查询失败不阻断核销（收据真实性已由 Apple 背书），只留痕
          logger.error(`[iap] 订单查询失败 order=${orderNo}: ${err?.message || err}`)
        }
      }

      // ⑤ 以 Apple 报文为准挑交易（绝不信任客户端自报的 product_id）
      const txn = pickTransaction(apple.body, clientTxnId, orderProductId)
      if (!txn) {
        logger.warn(`[iap] 收据里没有可核销的交易 owner=${ownerId} order=${orderNo}`)
        return cloudError(res, 402, '收据中未找到有效交易', 'no_transaction')
      }

      // ⑥ 原子核销（幂等 + 权益落库都在 0037 的 definer 函数里）
      const { rows } = await pool.query(
        `SELECT public.settle_apple_purchase($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r`,
        [
          ownerId,
          orderNo,
          String(txn.product_id ?? ''),
          String(txn.transaction_id ?? ''),
          String(txn.original_transaction_id ?? txn.transaction_id ?? ''),
          txn.expires_date_ms != null ? String(txn.expires_date_ms) : null,
          txn.purchase_date_ms != null ? String(txn.purchase_date_ms) : null,
          String(apple.body?.environment ?? ''),
          receiptDigest(receipt),
        ],
      )
      const r = rows[0]?.r
      if (!r || r.error) {
        const code = r?.error ?? 'settle_failed'
        // 「交易已归属他人」是重放攻击特征，warn 级留痕便于事后追查
        logger.warn(`[iap] 核销被拒 owner=${ownerId} txn=${txn.transaction_id} code=${code}`)
        const status = code === 'txn_taken_by_other' ? 409 : 402
        return cloudError(res, status, code === 'txn_taken_by_other' ? '该交易已被其他账号核销' : '支付核销失败，请联系客服', code)
      }

      logger.info(
        `[iap] 核销成功 owner=${ownerId} txn=${txn.transaction_id} product=${txn.product_id}` +
        ` plan=${r.plan} dup=${!!r.duplicate} env=${apple.body?.environment ?? '?'}`,
      )
      return {
        status: 200,
        body: {
          settled: true,
          duplicate: !!r.duplicate,
          plan: r.plan ?? 'free',
          pro_until: r.pro_until ?? null,
          transaction_id: String(txn.transaction_id ?? ''),
        },
      }
    },

    /**
     * POST /.cloud/payment/apple/notifications —— App Store Server Notifications V2。
     * 无 Bearer（Apple 直发）；安全完全依赖 JWS x5c 链验证（见文件头）。
     */
    async notifications(req, res, body) {
      if (!cfg.appleBundleId) return notConfigured(res)
      const signedPayload = typeof body?.signedPayload === 'string' ? body.signedPayload : ''
      if (!signedPayload) return cloudError(res, 400, '缺少 signedPayload', 'missing_payload')

      // ① 外层 JWS 验签（失败 = 不是 Apple 发的，400 拒收）
      let payload
      try {
        payload = jwsVerify(signedPayload)
      } catch (err) {
        logger.warn(`[iap] 通知 JWS 验签失败: ${err?.message || err}`)
        return cloudError(res, 400, 'signedPayload 验签失败', 'invalid_signature')
      }

      const type = String(payload?.notificationType ?? 'UNKNOWN')
      const bundleId = payload?.data?.bundleId
      if (bundleId && bundleId !== cfg.appleBundleId) {
        logger.warn(`[iap] 通知 bundleId 不匹配: got=${bundleId} type=${type}`)
        return cloudError(res, 400, 'bundleId 不匹配', 'bundle_mismatch')
      }

      // ② 解出交易信息（嵌套 JWS，同样要验签）
      let txn = null
      if (typeof payload?.data?.signedTransactionInfo === 'string') {
        try {
          txn = jwsVerify(payload.data.signedTransactionInfo)
        } catch (err) {
          logger.warn(`[iap] signedTransactionInfo 验签失败 type=${type}: ${err?.message || err}`)
        }
      }
      const txnId = txn?.transactionId != null ? String(txn.transactionId) : null
      const origTxnId = txn?.originalTransactionId != null ? String(txn.originalTransactionId) : null

      // ③ 分类型处理。任何业务失败都不给 Apple 回错误码（避免无限重试），
      //    统一落库 apple_notifications 留痕，processed=false + error 说明原因。
      let processed = false
      let procError = null
      try {
        if (type === 'SUBSCRIBED' || type === 'DID_RENEW') {
          // 新购/续订：与客户端 verify 同一个核销函数（按 transaction_id 幂等）。
          // 续订通知是权益顺延的**权威来源** —— 客户端不在线也能续上。
          //
          // 环境白名单（与 verify 路径同口径）：通知虽由 Apple JWS 验签背书，
          // 但沙盒环境同样会发 DID_RENEW —— APPLE_SANDBOX=false 的生产部署
          // 若照单全收，TestFlight/审核员的沙盒订阅就能在生产白拿真权益。
          // 注意：REFUND/REVOKE 分支**刻意不校验** —— 撤销权益是防御性动作，
          // 宁可多撤不可漏撤，沙盒退款通知也应生效。
          const nEnv = String(payload?.data?.environment ?? '')
          if (!cfg.appleAllowedEnvs?.has(nEnv)) {
            // 不抛错、仍走下方统一落库：processed=false + err 留痕，
            // 且按协议给 Apple 回 200（避免它无限重投同一通知）。
            procError = 'environment_mismatch'
            logger.warn(`[iap] 通知 environment 不在白名单: type=${type} got=${nEnv || '<缺失>'} want=${[...(cfg.appleAllowedEnvs ?? [])].join('/')} txn=${txnId ?? '-'}`)
          } else {
            if (!txn?.productId) throw new Error('通知缺少交易信息')
            const { rows } = await pool.query(
              `SELECT public.settle_apple_purchase($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r`,
              [
                // 通知里没有「我们的用户」概念：owner 以首次核销该
                // original_transaction_id 的记录为准（settle 函数内按
                // original_txn 反查；查不到说明用户从未在客户端核销过，
                // 落库为待认领状态，等客户端下次 verify 时对齐）。
                null,
                null,
                String(txn.productId),
                txnId,
                origTxnId,
                txn.expiresDate != null ? String(txn.expiresDate) : null,
                txn.purchaseDate != null ? String(txn.purchaseDate) : null,
                nEnv,
                null,
              ],
            )
            const r = rows[0]?.r
            if (r?.error === 'owner_unresolved') {
              // 用户还没在客户端核销过这笔订阅 → 只记通知，不发权益（没人可发）
              procError = 'owner_unresolved'
            } else if (r?.error) {
              throw new Error(String(r.error))
            }
            processed = !procError
          }
        } else if (type === 'REFUND' || type === 'REVOKE') {
          const { rows } = await pool.query(
            `SELECT public.revoke_apple_purchase($1,$2,$3) AS r`,
            [txnId, origTxnId, type.toLowerCase()],
          )
          processed = !!rows[0]?.r?.revoked
          if (!processed) procError = 'txn_not_found'
        } else {
          // EXPIRED / DID_CHANGE_RENEWAL_STATUS / GRACE_PERIOD 等：
          // 权益过期由 pro_until 自然驱动，无需写库；留痕即可。
          processed = true
        }
      } catch (err) {
        procError = err?.message || String(err)
        logger.error(`[iap] 通知处理失败 type=${type} txn=${txnId}: ${err?.stack || err}`)
      }

      // ④ 全量落库（无论成败，便于对账与重放）
      try {
        await pool.query(`SELECT public.log_apple_notification($1,$2,$3,$4,$5)`, [
          JSON.stringify(payload),
          txnId,
          origTxnId,
          processed,
          procError,
        ])
      } catch (err) {
        logger.error(`[iap] 通知落库失败 type=${type}: ${err?.message || err}`)
      }

      logger.info(`[iap] 通知 type=${type} sub=${payload?.subtype ?? '-'} txn=${txnId ?? '-'} processed=${processed}${procError ? ` err=${procError}` : ''}`)
      return { status: 200, body: { ok: true, processed } }
    },
  }
}
