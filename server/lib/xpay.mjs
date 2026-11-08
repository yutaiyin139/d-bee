/**
 * C2 · 微信小程序虚拟支付（xpay / 米大师 Midas）签名、发货推送与查单兜底。
 *
 * ── 为什么不是普通微信支付 ──────────────────────────────────────────────
 *   会员订阅是**虚拟商品**。微信 2026-02-27《小程序虚拟支付业务管理规范更新
 *   公告》：2026-04-01 起全终端强制走虚拟支付；用 wx.requestPayment(JSAPI)
 *   卖虚拟商品真机报「支付能力已被限制」且判定违规。src/lib/payment/
 *   wechatPay.ts（JSAPI 适配器）服务的是 Android/Web 实物场景，与这里无关。
 *   详见 db/migrations/0046 头注与 docs/P1-D在线支付实装前置清单-2026-11-03.md。
 *
 * ── 端点（挂在 /.cloud/payment/wechat 前缀，app.mjs 装配）───────────────
 *   POST /.cloud/payment/wechat/params   下单后取 wx.requestVirtualPayment
 *                                        所需 {mode, signData, paySig, signature}
 *   GET  /.cloud/payment/wechat/notify   推送配置 URL 握手（echostr）
 *   POST /.cloud/payment/wechat/notify   xpay_goods_deliver_notify（发货，权威）
 *                                        xpay_refund_notify（退款→回收权益）
 *   POST /.cloud/payment/wechat/query    主动查单兜底（推送丢失时客户端轮询）
 *
 * ── 🔴 推模式（与 Apple IAP 拉模式的根本差异，P1-D §二-A 既定决策）──────
 *   客户端 wx.requestVirtualPayment success **只代表用户付完了钱**；
 *   权益发放的权威信号是服务端异步收到的 xpay_goods_deliver_notify。
 *   → params 只发签名不发权益；notify 才调 settle_xpay_purchase；
 *   → verify_payment_order（0046 已改为查单语义）+ /query 兜底解决
 *     「回调未到、前端以为失败」的窗口；窗口内前端提示「到账中」绝不报错。
 *
 * ── 签名（官方公式，两个来源逐字核实过）────────────────────────────────
 *   前端支付签名   paySig    = hex(hmac_sha256(appKey,     'requestVirtualPayment' + '&' + signData))
 *   前端用户态签名 signature = hex(hmac_sha256(session_key, signData))
 *   服务端接口签名 pay_sig   = hex(hmac_sha256(appKey,     uri + '&' + post_body))   ← uri 不带 query
 *   🔴 signData 必须是「服务端序列化的那个字符串」原样透传：前端拿到后
 *      JSON.parse 再 stringify 会改字段顺序 → paySig/signature 验签必失败
 *      （错误码 -15005/-15006）。故 params 返回 signData 为 string，
 *      前端**禁止重新序列化**，原样塞进 wx.requestVirtualPayment。
 *
 * ── 推送验签（微信「消息推送」标准协议，明文/安全两模式都支持）──────────
 *   GET  握手：signature == sha1(sort(token, timestamp, nonce)) → 原样回 echostr
 *   POST 明文模式：同 GET 算法验 query.signature，body 即事件（XML 或 JSON）
 *   POST 安全模式：验 query.msg_signature == sha1(sort(token,timestamp,nonce,Encrypt))，
 *      再用 EncodingAESKey 做 AES-256-CBC/PKCS#7 解密；明文布局
 *      random(16B) + msg_len(4B 大端) + msg + appid，appid 必须等于本小程序。
 *   响应格式必须与推送格式一致（XML 推 XML、JSON 推 JSON），或回 "success"。
 *   处理失败也要应答成功语义吗？—— 不：业务失败回非 0 ErrCode 让微信重试
 *   （最多 15 次），这**正是**「推送丢失自愈」机制；但验签失败回 400
 *   （不是微信发的，重试也没用），未知事件回成功（不认识的不要挡微信的路）。
 *
 * ── 🔴 安全边界（继承 iap.mjs 五条 + xpay 特有）─────────────────────────
 *   1. params/query 必须带网关 Bearer JWT（含 token_version 校验，同 iap）；
 *   2. 下单金额/商品以 payment_orders（create_payment_order 服务端查价）为
 *      唯一事实源：客户端只报 order_no，price/product 一律查库，改不了；
 *   3. signature 用的 session_key 只从 wechatSession.loadSessionKey 读
 *      （AES-GCM 密文 + appid 绑定 + TTL），失败 → 409 要求重新登录，
 *      **绝不**把「session_key 不可用」静默降级成不带签名下单；
 *   4. notify 的发货字段全部取推送报文（ProductId/Quantity/ActualPrice），
 *      客户端回传的任何字段不作为信任依据；
 *   5. 幂等键 = out_trade_no（我方业务单号，见 0046 头注「差异 1」），
 *      settle/revoke 函数内 UNIQUE 兜底，重复推送是常态不是异常；
 *   6. session_key / appKey / EncodingAESKey 一律不进日志、不下发前端。
 *
 * ── 订单状态（/xpay/query_order 返回 order.status，数字枚举）────────────
 *   0 初始化失败 · 1 已创建待支付 · 2 已支付待发货（→ 查单兜底据此发货）
 *   3 发货中 · 4 已发货（幂等跳过）· 5 已退款 · 6 已关闭 · 7 退款失败
 *   8 用户退款完成（→ revoke）
 */
import { createHmac, createHash, createDecipheriv } from 'node:crypto'
import { verifyJwt, bearerFrom } from './jwt.mjs'
import { cloudError, readBody } from './http.mjs'
import { getTokenVersion } from './identity.mjs'
import { loadSessionKey, safeStrEqual } from './wechatSession.mjs'

// ── 签名工具（纯函数，导出供自测正/负用例）──────────────────────────────

const hmacSha256Hex = (key, msg) => createHmac('sha256', key).update(msg, 'utf8').digest('hex')

/** 前端 paySig：uri 固定 'requestVirtualPayment'（官方签名详解原文）。 */
export function calcPaySig(appKey, signData, uri = 'requestVirtualPayment') {
  return hmacSha256Hex(appKey, `${uri}&${signData}`)
}

/** 前端/服务端用户态签名：hmac(session_key, signData 或 post_body)。 */
export function calcSignature(sessionKey, signData) {
  return hmacSha256Hex(sessionKey, signData)
}

/**
 * signData 构造（道具直购 short_series_goods）。
 * 🔴 返回的是**序列化后的字符串**，前端必须原样透传（见文件头）。
 * 字段顺序固定 = 与官方示例一致；goodsPrice 单位是**分**。
 */
export function buildSignData({ offerId, buyQuantity, env, productId, goodsPrice, outTradeNo, attach }) {
  return JSON.stringify({
    offerId: String(offerId),
    buyQuantity: Number(buyQuantity) || 1,
    env: Number(env) || 0,
    currencyType: 'CNY',
    productId: String(productId),
    goodsPrice: Number(goodsPrice) || 0,
    outTradeNo: String(outTradeNo),
    attach: String(attach ?? ''),
  })
}

// ── 推送验签 / 解密（微信消息推送标准协议）──────────────────────────────

/** sha1(sort(token, timestamp, nonce[, encrypt])) —— GET 握手与明文 POST 共用。 */
export function calcPushSignature(token, timestamp, nonce, encrypt = '') {
  const parts = encrypt ? [token, timestamp, nonce, encrypt] : [token, timestamp, nonce]
  parts.sort()
  return createHash('sha1').update(parts.join(''), 'utf8').digest('hex')
}

/**
 * 安全模式消息体解密。EncodingAESKey(43 位) + '=' 后 base64 → 32 字节 AES key；
 * iv = key 前 16 字节（微信标准，别问为什么，协议如此）。
 * 明文布局 random(16) + msg_len(4, BE) + msg + appid。
 * @returns {{msg:string, appid:string}|null} 任何异常/篡改/appid 不符 → null
 */
export function decryptPushMsg(encryptB64, encodingAesKey, expectAppid) {
  try {
    const key = Buffer.from(`${encodingAesKey}=`, 'base64')
    if (key.length !== 32) return null
    const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
    decipher.setAutoPadding(true) // PKCS#7
    const plain = Buffer.concat([decipher.update(Buffer.from(encryptB64, 'base64')), decipher.final()])
    const msgLen = plain.readUInt32BE(16)
    const msg = plain.subarray(20, 20 + msgLen).toString('utf8')
    const appid = plain.subarray(20 + msgLen).toString('utf8')
    if (expectAppid && appid && !safeStrEqual(appid, expectAppid)) return null
    return { msg, appid }
  } catch {
    return null
  }
}

/**
 * 极简 XML → JS 对象（只服务微信推送这一种形态：<Tag>text</Tag> 平铺 +
 * 一层嵌套 Object + CDATA）。不引第三方依赖（网关零依赖纪律）。
 *
 * 实现要点（第一版用「__pending 回填」写错过：CDATA 的 `<![CDATA[` 以 `<`
 * 开头会被标签正则误匹配 → 改为**先切 token 再状态机消费**，CDATA 整段
 * 归入文本 token，结构上不可能被当成标签）：
 *   · token 正则一次扫描出：注释/声明、开标签、闭标签、自闭合、文本（含 CDATA）
 *   · 栈式解析；文本写入栈顶对象「最后打开且未收到文本」的键
 *   · 空元素（<Tag></Tag> 或 <Tag/>）= 空串
 *   · 纯整数字符串转 number；**11 位以上不转**（商户单号是长数字串，
 *     转 number 会丢精度 → 保持 string）
 * 🔴 只用于**验签通过后**的解析，不承担安全职责（安全在 sha1/AES 两层）。
 */
export function parseWxXml(xml) {
  const decodeEntities = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&') // &amp; 必须最后替换，防双重解码

  // 一次扫描切 token：CDATA / 注释 / XML 声明 / 闭标签 / 开标签(含自闭合) / 文本。
  // 属性组用 \s+[^>]*? 吃掉（微信推送的属性我们不需要，但必须跳过以免污染标签名）。
  const TOKEN_RE = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[^>]*?)?)(\/?)>|([^<]+)/g

  const root = {}
  // 每帧 = { node, pendingKey }。pendingKey = 「本帧里，下一个文本 token 要写进哪个键」。
  // 🔴 关键不变量：文本 token 到达时，栈顶是**该文本所属元素的帧**，而要写入的
  //   位置在**父帧**的 pendingKey 上（因为开标签时我们已经先把父帧的键设成了 {}，
  //   现在要用文本把这个空对象**整体替换**掉）。
  const stack = [{ node: root, pendingKey: null }]

  const writeText = (text) => {
    if (stack.length < 2) return // 根之外的裸文本（缩进/换行），忽略
    const parent = stack[stack.length - 2]
    const key = parent.pendingKey
    if (!key) return
    const cur = parent.node[key]
    // 只在该键仍是「刚创建的空对象」时替换为文本：防混合内容反复覆盖，
    // 也防子元素已填充后被后来的空白文本冲掉。
    if (cur && typeof cur === 'object' && Object.keys(cur).length === 0) {
      parent.node[key] = text
    }
  }

  let m
  while ((m = TOKEN_RE.exec(xml)) !== null) {
    const top = stack[stack.length - 1]
    if (m[1] !== undefined) {
      writeText(m[1]) // CDATA：内容原样，不解实体（CDATA 语义就是不解析）
    } else if (m[2] !== undefined) {
      // 闭标签：出栈。若本帧对象自始至终没被填充 → 父帧该键归一为空串
      if (stack.length > 1) {
        const frame = stack.pop()
        const parent = stack[stack.length - 1]
        const key = parent.pendingKey
        // 用**引用同一性**判断「父帧那个键还指向本帧对象」：
        // 若已被 writeText 替换成字符串，同一性不成立 → 不能覆盖成空串。
        if (key && parent.node[key] === frame.node && Object.keys(frame.node).length === 0) {
          parent.node[key] = ''
        }
        parent.pendingKey = null
      }
    } else if (m[3] !== undefined) {
      if (m[5] === '/') {
        top.node[m[3]] = '' // 自闭合 <Tag/>
        top.pendingKey = null
      } else {
        top.node[m[3]] = {}
        top.pendingKey = m[3]
        stack.push({ node: top.node[m[3]], pendingKey: null })
      }
    } else if (m[6] !== undefined) {
      const text = decodeEntities(m[6]).trim()
      if (text) writeText(text)
    }
    // m[0] 命中注释/XML 声明（第 2、3 分支）时所有捕获组均 undefined → 自然跳过
  }

  // 数字启发式转换（CreateTime/Env/Quantity/OrigPrice 等）。
  // 🔴 11 位以上纯数字串**不转**：商户单号/交易单号是长数字串，转 number 会丢精度。
  const conv = (o) => {
    for (const k of Object.keys(o)) {
      const v = o[k]
      if (typeof v === 'object' && v !== null) {
        if (Object.keys(v).length === 0) o[k] = '' // 防御：畸形未闭合标签留下的空对象
        else conv(v)
      } else if (typeof v === 'string' && /^-?\d+$/.test(v) && v.replace('-', '').length < 11) {
        o[k] = Number(v)
      }
    }
  }
  conv(root)
  return root.xml ?? root
}

// ── access_token 缓存（只有查单兜底用；下单/推送不需要）─────────────────

function createTokenCache(cfg, fetchImpl, logger) {
  let token = ''
  let expiresAt = 0
  let inflight = null

  const appidSecret = () => {
    // 显式 XPAY_APPID 优先；否则 wechatMiniSecrets 只有一组时自动用它
    const appid = cfg.xpayAppid || (cfg.wechatMiniSecrets?.size === 1 ? [...cfg.wechatMiniSecrets.keys()][0] : '')
    const secret = appid ? cfg.wechatMiniSecrets?.get(appid) : ''
    return appid && secret ? { appid, secret } : null
  }

  async function fetchNew() {
    const cred = appidSecret()
    if (!cred) throw Object.assign(new Error('缺少 appid/secret（配 XPAY_APPID 或 WECHAT_MINI_SECRETS）'), { code: 'no_credential' })
    const url = `${cfg.xpayApiBase}/cgi-bin/token?` + new URLSearchParams({
      grant_type: 'client_credential', appid: cred.appid, secret: cred.secret,
    }).toString()
    const resp = await (fetchImpl ?? globalThis.fetch)(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(cfg.xpayTimeoutMs ?? 10_000),
    })
    const data = await resp.json().catch(() => null)
    if (!data?.access_token) {
      // 🔴 绝不把 URL（含 secret）写进日志
      throw Object.assign(new Error(`token 接口失败 errcode=${data?.errcode ?? '?'} errmsg=${String(data?.errmsg ?? '').slice(0, 80)}`), { code: 'token_failed' })
    }
    token = data.access_token
    // 提前 5 分钟过期，防边界失效
    expiresAt = Date.now() + Math.max(60, (Number(data.expires_in) || 7200) - 300) * 1000
    return token
  }

  return {
    async get(force = false) {
      if (!force && token && Date.now() < expiresAt) return token
      if (!inflight) {
        inflight = fetchNew().finally(() => { inflight = null })
      }
      return inflight
    },
    /** 单实例假设：systemd 一进程一实例（deploy-gateway 格局），进程内缓存足够。
     *  若将来多实例，须换 redis/DB 共享缓存，否则互相刷新踢 token。 */
  }
}

// ── 处理器工厂（同构 iap.mjs）──────────────────────────────────────────

/**
 * @param {object} deps
 * @param {object} deps.cfg          loadConfig() 产物
 * @param {object} deps.pool         业务池 dbee_app（调 0046 definer 函数 + 读 payment_orders）
 * @param {object} deps.gatewayPool  身份池（token_version 校验 + 读 session_key 密文）
 * @param {object} deps.logger
 * @param {typeof globalThis.fetch} [deps.fetchImpl] 自测注入（query_order / cgi-bin/token 外呼）
 */
export function createXpayHandlers(deps) {
  const { cfg, pool, gatewayPool, logger } = deps
  const fetchImpl = deps.fetchImpl
  const tokenCache = createTokenCache(cfg, fetchImpl, logger)

  const configured = () => !!(cfg.xpayOfferId && cfg.xpayAppKey && cfg.wechatSessionEncKey)
  const appKeyFor = (env) => (Number(env) === 1 ? cfg.xpaySandboxAppKey : cfg.xpayAppKey) || cfg.xpayAppKey

  function notConfigured(res) {
    return cloudError(res, 503, '微信支付未配置', 'xpay_not_configured')
  }

  /** Bearer → ownerId（带 token_version 校验，同 iap.mjs authOwnerId） */
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
        logger.error(`[xpay] token_version 查询失败，跳过版本校验: ${err?.message || err}`)
      }
    }
    return sub
  }

  /**
   * 按 order_no 读订单（pool=dbee_app，0046 已显式 GRANT SELECT）。
   * 返回 { order } 或 { error: {status,message,code} }。
   */
  async function loadOrder(orderNo, ownerId) {
    // 🔴 列名严格对齐 0021 的 payment_orders 建表定义：**没有 quantity 列**
    //   （本项目一单一件，份数由 signData.buyQuantity 固定 1 表达）。
    //   多写一列 = 生产报 column does not exist → 下单全挂。
    const { rows } = await pool.query(
      `SELECT order_no, owner_id, product_id, plan, amount_cents, status, provider
         FROM public.payment_orders
        WHERE order_no = $1`,
      [orderNo],
    )
    const order = rows[0]
    if (!order) {
      return { error: { status: 404, message: '订单不存在', code: 'order_not_found' } }
    }
    if (order.owner_id !== ownerId) {
      // 拿别人的单号来签名 = 越权尝试，warn 留痕 + 403
      logger.warn(`[xpay] 订单归属不符 order=${orderNo} order_owner=${order.owner_id} jwt=${ownerId}`)
      return { error: { status: 403, message: '订单不属于当前用户', code: 'order_forbidden' } }
    }
    return { order }
  }

  /**
   * xpay 系列服务端 API 的通用外呼。
   *
   * 统一在此实现三件容易写错的事（两个接口共用，避免各写一份而漂移）：
   *   ① `pay_sig = hmac_sha256(appKey, uri + '&' + body)` —— uri 是**接口路径**
   *      （如 `/xpay/query_order`），不带 query；body 必须与实际发送字节**逐字一致**
   *      （故先 stringify 一次，签名与发送共用同一字符串）；
   *   ② access_token 走进程内缓存（提前 5 分钟过期 + inflight 去重）；
   *   ③ token 失效（40001 无效 / 42001 过期）→ 强刷一次重试，**只重试一次**防死循环。
   *
   * @param {string} uri 接口路径，如 '/xpay/query_order'
   * @param {object} bodyObj 请求体对象
   * @param {number} env 0 现网 / 1 沙箱（决定用哪把 AppKey）
   * @returns {Promise<object|null>} 解析后的响应（解析失败为 null）
   */
  async function callXpayApi(uri, bodyObj, env) {
    const body = JSON.stringify(bodyObj)
    const paySig = calcPaySig(appKeyFor(env), body, uri)
    const doFetch = fetchImpl ?? globalThis.fetch
    const timeoutMs = cfg.xpayTimeoutMs ?? 10_000

    const send = async (accessToken) => {
      const url = `${cfg.xpayApiBase}${uri}?` + new URLSearchParams({
        access_token: accessToken, pay_sig: paySig,
      }).toString()
      const resp = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body, // 🔴 必须与参与签名的字符串逐字节一致
        signal: AbortSignal.timeout(timeoutMs),
      })
      return resp.json().catch(() => null)
    }

    const data = await send(await tokenCache.get())
    // pay_sig 与 body 绑定、与 token 无关，故重试沿用同一个 paySig
    if (data && (data.errcode === 40001 || data.errcode === 42001)) {
      return send(await tokenCache.get(true))
    }
    return data
  }

  /** 调 /xpay/query_order（POST，pay_sig 走 uri+'&'+原始 body）。 */
  async function callQueryOrder({ openid, env, orderNo }) {
    const e = Number(env) || 0
    return callXpayApi('/xpay/query_order', { openid, env: e, order_id: orderNo }, e)
  }

  /**
   * 调 /xpay/notify_provide_goods —— 通知平台「我方已发货完成」。
   *
   * 🔴 为什么必须有这一步（**资金结算级**，2026-11-08 补）：
   *   官方文档原文：「正常通过 xpay_goods_deliver_notify 消息推送返回成功**就不需要**
   *   调用这个 api 接口。这个接口用于**异常情况推送不成功时**手动将单改成已发货状态。」
   *   微信开放社区官方答复亦确认：「如果不发货的话，应该会影响结算状态。」
   *
   *   即：虚拟商品的订单闭环是「已支付待发货(status=2) → 已发货(status=4)」，
   *   只有走到 4 才算履约完成、资金才会结算给我方。推送路径下我方回 ErrCode=0
   *   就是发货确认，平台自动置 4；但**查单兜底路径**（推送丢失/我方当时回了非 0
   *   导致 15 次重试耗尽）里，我方只在本地发了权益，平台侧仍停在 2/3 ——
   *   用户拿到了会员，我方却收不到钱。这正是「推送丢失」场景下最隐蔽的资损。
   *
   * 调用纪律：
   *   · 只在平台侧 status 为 2（已支付待发货）或 3（发货中）时调 —— status=4 已是
   *     已发货，重复调毫无意义；且以「平台当前状态」为判据天然幂等（成功后下次查单即 4）。
   *   · 只通知**现金单**（官方限制），Apple 渠道（order_type=7）不调 ——
   *     Apple 侧结算链路独立，我方无权替其确认发货。
   *   · 失败**不影响用户权益**（权益已落库），只 warn + 留痕；下次 reconcile 查单会再试。
   *
   * @returns {Promise<boolean>} 平台是否已确认（errcode 0 = 成功）
   */
  async function callNotifyProvideGoods({ orderNo, env }) {
    const e = Number(env) || 0
    const data = await callXpayApi('/xpay/notify_provide_goods', { order_id: orderNo, env: e }, e)
    const ok = !!data && data.errcode === 0
    if (!ok) {
      logger.error(
        `[xpay] notify_provide_goods 失败 order=${orderNo} errcode=${data?.errcode} ` +
        `errmsg=${String(data?.errmsg ?? '无响应').slice(0, 80)} —— 订单可能停在「已支付待发货」，` +
        '影响资金结算，需用 reconcile=true 重跑查单或人工处理',
      )
    }
    return ok
  }

  /** 用推送/查单报文核销（两条路径共用；幂等在 settle 函数内）。 */
  async function settleFromPayload(p, source) {
    const goods = p.goods ?? {}
    const pay = p.wechatPay ?? {}
    const { rows } = await pool.query(
      `SELECT public.settle_xpay_purchase($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS r`,
      [
        p.outTradeNo,          // p_out_trade_no（幂等键）
        null,                  // p_owner_id：推送/查单路径都传 NULL，由 openid 确定性解析
        p.openid,              // p_openid
        String(goods.productId ?? ''),
        pay.providerTxnId ?? null,
        Number(goods.quantity) || 1,
        goods.origPrice != null ? Number(goods.origPrice) : null,
        goods.actualPrice != null ? Number(goods.actualPrice) : null,
        p.channel ?? 'wechat',
        p.env != null ? Number(p.env) : null,
        // 🔴 用 Number 而非 BigInt：node-pg 的 prepareValue 不认识 BigInt，
        //   会走到 JSON.stringify 抛「Do not know how to serialize a BigInt」。
        //   PaidTime 是秒级时间戳（~1.7e9），远在 MAX_SAFE_INTEGER(9e15) 内。
        pay.paidTime != null ? Number(pay.paidTime) : null,
        goods.attach ?? null,
      ],
    )
    const r = rows[0]?.r
    if (!r || r.error) {
      logger.warn(`[xpay] ${source} 核销被拒 out_trade_no=${p.outTradeNo} code=${r?.error ?? 'settle_failed'}`)
      return { ok: false, code: r?.error ?? 'settle_failed' }
    }
    logger.info(
      `[xpay] ${source} 核销成功 owner=${r.owner_id} out_trade_no=${p.outTradeNo}` +
      ` product=${goods.productId} plan=${r.plan} dup=${!!r.duplicate} channel=${p.channel ?? 'wechat'}`,
    )
    return { ok: true, result: r }
  }

  // ── 推送事件解析（XML/JSON 双形态归一成同一形状）─────────────────────

  /** 把微信事件报文（对象）归一成 {event, openid, outTradeNo, env, goods, wechatPay, channel}。 */
  function normalizeEvent(msg) {
    const goodsInfo = msg.GoodsInfo ?? {}
    const wxPay = msg.WeChatPayInfo ?? {}
    // iOS 走 Apple 通道：推送可能带 AppleSubscriptionInfo / order_type=7，
    // 且 WeChatPayInfo 可能整体缺失（0046 头注「差异 1」的由来）。
    const isApple = !!(msg.AppleSubscriptionInfo || msg.ApplePayInfo)
    return {
      event: String(msg.Event ?? ''),
      openid: String(msg.OpenId ?? ''),
      outTradeNo: String(msg.OutTradeNo ?? ''),
      env: msg.Env != null ? Number(msg.Env) : 0,
      channel: isApple ? 'apple' : 'wechat',
      goods: {
        productId: goodsInfo.ProductId != null ? String(goodsInfo.ProductId) : '',
        quantity: goodsInfo.Quantity != null ? Number(goodsInfo.Quantity) : 1,
        origPrice: goodsInfo.OrigPrice != null ? Number(goodsInfo.OrigPrice) : null,
        actualPrice: goodsInfo.ActualPrice != null ? Number(goodsInfo.ActualPrice) : null,
        attach: goodsInfo.Attach != null ? String(goodsInfo.Attach) : null,
      },
      wechatPay: {
        providerTxnId: wxPay.MchOrderNo != null ? String(wxPay.MchOrderNo)
          : (wxPay.TransactionId != null ? String(wxPay.TransactionId) : null),
        paidTime: wxPay.PaidTime != null ? Number(wxPay.PaidTime) : null,
      },
    }
  }

  return {
    /**
     * POST /.cloud/payment/wechat/params —— 生成 wx.requestVirtualPayment 参数。
     * body: { order_no: string, appid: string }
     *   · order_no = create_payment_order 返回的订单号（= outTradeNo）
     *   · appid 必须与登录时一致（session_key 与 appid 绑定，0046 列）
     * 返回: { mode:'short_series_goods', signData:<string>, paySig, signature, env }
     * 🔴 signData 是字符串，前端原样透传，禁止 parse 后重新 stringify。
     */
    async params(req, res, body) {
      if (!configured()) return notConfigured(res)
      const ownerId = await authOwnerId(req)
      if (!ownerId) return cloudError(res, 401, '未登录或登录已过期', 'unauthorized')

      const orderNo = typeof body?.order_no === 'string' ? body.order_no.trim() : ''
      const appid = typeof body?.appid === 'string' ? body.appid.trim() : ''
      if (!orderNo) return cloudError(res, 400, '缺少 order_no', 'invalid_request')
      if (!appid) return cloudError(res, 400, '缺少 appid', 'invalid_request')
      // outTradeNo 约束（官方）：8-32 位，数字/字母/_-|*@，不能 _ 开头
      if (!/^[A-Za-z0-9|*@-][A-Za-z0-9_|*@-]{7,31}$/.test(orderNo)) {
        return cloudError(res, 400, '订单号格式不符合微信支付要求', 'invalid_request')
      }

      let order
      try {
        const r = await loadOrder(orderNo, ownerId)
        if (r.error) return cloudError(res, r.error.status, r.error.message, r.error.code)
        order = r.order
      } catch (err) {
        logger.error(`[xpay] 订单查询失败 order=${orderNo}: ${err?.message || err}`)
        return cloudError(res, 500, '订单查询失败，请稍后重试', 'db_error')
      }
      if (order.status === 'paid') {
        // 已核销订单再要签名：幂等友好返回（前端可能重进支付页），但不再产生新支付。
        // 微信侧同单号重复下单会 -15002，与其让用户撞错误码不如直接告知已完成。
        return { status: 200, body: { already_paid: true } }
      }

      const sessionKey = await loadSessionKey(gatewayPool, {
        ownerId,
        appid,
        keyHex: cfg.wechatSessionEncKey,
        ttlHours: cfg.xpaySessionKeyTtlHours ?? 72,
        logger,
      })
      if (!sessionKey) {
        // 红线 3：绝不降级成「无 signature 下单」（微信必拒 -15005），直接要求重新登录
        logger.warn(`[xpay] session_key 不可用（缺失/过期/appid 不符）owner=${ownerId} appid=${appid}`)
        return cloudError(res, 409, '登录状态已过期，请重新登录后再支付', 'session_key_expired')
      }

      const env = cfg.xpayEnv // 0 现网 / 1 沙箱（config.validate 已拦「生产开沙箱」）
      const signData = buildSignData({
        offerId: cfg.xpayOfferId,
        // 🔴 payment_orders 无 quantity 列（0021），本项目一单一件 → 恒 1。
        //   「买一年」由商品 dbee_pro_yearly（months=12）表达，不是 quantity=12。
        buyQuantity: 1,
        env,
        productId: order.product_id,
        goodsPrice: Number(order.amount_cents) || 0, // 🔴 服务端查库价，客户端改不了
        outTradeNo: order.order_no,
        attach: order.order_no, // 透传我方单号，推送回来可对账
      })

      return {
        status: 200,
        body: {
          mode: 'short_series_goods',
          signData, // string，原样透传
          paySig: calcPaySig(appKeyFor(env), signData),
          signature: calcSignature(sessionKey, signData),
          env,
        },
      }
    },

    /**
     * GET /.cloud/payment/wechat/notify —— 推送配置 URL 握手。
     * query: signature, timestamp, nonce, echostr（明文/安全模式握手算法相同）
     * 验签通过 → 原样返回 echostr（text/plain）；失败 → 400。
     * 🔴 此处理器**自己写 res**（非 JSON），不走 app.mjs 的 wrap()。
     */
    async notifyVerify(req, res, ctx) {
      if (!cfg.xpayPushToken) return cloudError(res, 503, '推送未配置', 'xpay_not_configured')
      const q = ctx?.url?.searchParams ?? new URLSearchParams()
      const signature = String(q.get('signature') ?? '')
      const timestamp = String(q.get('timestamp') ?? '')
      const nonce = String(q.get('nonce') ?? '')
      const echostr = String(q.get('echostr') ?? '')
      const expect = calcPushSignature(cfg.xpayPushToken, timestamp, nonce)
      if (!signature || !safeStrEqual(signature, expect)) {
        logger.warn(`[xpay] 握手验签失败 ip=${req.socket?.remoteAddress ?? '?'}`)
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('invalid signature')
      }
      logger.info('[xpay] 推送 URL 握手验证通过')
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end(echostr)
    },

    /**
     * POST /.cloud/payment/wechat/notify —— 发货/退款推送。
     * 🔴 此处理器**自己读原始字节 + 自己写 res**：
     *   · 验签依赖「原始 body 字节」，JSON.parse 再 stringify 会破坏安全模式的
     *     msg_signature 校验（Encrypt 字段虽是 base64 不怕，但明文 XML 的空白
     *     字符会变）→ 必须用 readBody 而不是 wrap() 的 readJson；
     *   · 响应格式须与推送格式一致（XML→XML / JSON→JSON），或 "success"。
     * 返回非 0 ErrCode = 请微信重试（最多 15 次）→ 这是推送自愈机制的一部分；
     * 验签失败例外（400，重试也没用）。
     */
    async notify(req, res, ctx) {
      if (!cfg.xpayPushToken) return cloudError(res, 503, '推送未配置', 'xpay_not_configured')
      const q = ctx?.url?.searchParams ?? new URLSearchParams()
      const timestamp = String(q.get('timestamp') ?? '')
      const nonce = String(q.get('nonce') ?? '')
      const msgSignature = String(q.get('msg_signature') ?? '')
      const encryptType = String(q.get('encrypt_type') ?? '')
      const plainSignature = String(q.get('signature') ?? '')

      const raw = await readBody(req, cfg.bodyLimitBytes ?? 1024 * 1024)
      const rawStr = raw.toString('utf8')
      const isXml = rawStr.trimStart().startsWith('<')

      // 应答格式与推送一致（协议要求）
      const reply = (errCode, errMsg = 'success') => {
        if (isXml) {
          res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
          return res.end(`<xml><ErrCode>${errCode}</ErrCode><ErrMsg><![CDATA[${errMsg}]]></ErrMsg></xml>`)
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ErrCode: errCode, ErrMsg: errMsg }))
      }

      // ── ① 解析出事件明文（安全模式先解密）──
      let msgStr = rawStr
      if (encryptType === 'aes' || msgSignature) {
        // 安全模式：body 是 {"Encrypt":"...","ToUserName":"..."} 或 XML 等价形态
        let encrypt = ''
        try {
          encrypt = isXml ? String(parseWxXml(rawStr)?.Encrypt ?? '') : String(JSON.parse(rawStr)?.Encrypt ?? '')
        } catch { /* 下面统一按空处理 → 验签失败 */ }
        const expectMsgSig = calcPushSignature(cfg.xpayPushToken, timestamp, nonce, encrypt)
        if (!msgSignature || !safeStrEqual(msgSignature, expectMsgSig)) {
          logger.warn(`[xpay] 推送 msg_signature 验签失败（安全模式）`)
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          return res.end('invalid msg_signature')
        }
        if (!cfg.xpayPushAesKey) {
          logger.error('[xpay] 收到安全模式推送但未配 XPAY_PUSH_AES_KEY')
          return reply(1, 'server misconfigured')
        }
        const appid = cfg.xpayAppid || (cfg.wechatMiniSecrets?.size === 1 ? [...cfg.wechatMiniSecrets.keys()][0] : '')
        const dec = decryptPushMsg(encrypt, cfg.xpayPushAesKey, appid)
        if (!dec) {
          logger.warn('[xpay] 推送解密失败（AESKey 不符或密文损坏或 appid 不匹配）')
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          return res.end('decrypt failed')
        }
        msgStr = dec.msg
      } else {
        // 明文模式：验 query.signature（同握手算法）
        const expect = calcPushSignature(cfg.xpayPushToken, timestamp, nonce)
        if (!plainSignature || !safeStrEqual(plainSignature, expect)) {
          logger.warn('[xpay] 推送 signature 验签失败（明文模式）')
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          return res.end('invalid signature')
        }
      }

      // ── ② 解析事件 ──
      let msg
      try {
        msg = msgStr.trimStart().startsWith('<') ? parseWxXml(msgStr) : JSON.parse(msgStr)
      } catch (err) {
        logger.error(`[xpay] 推送体解析失败: ${err?.message || err}`)
        return reply(1, 'bad payload') // 让微信重试：可能只是我方瞬时解析问题
      }
      const ev = normalizeEvent(msg)

      // ── ③ 分发 ──
      let processed = false
      let procError = null
      let replyCode = 0
      try {
        if (ev.event === 'xpay_goods_deliver_notify') {
          if (!ev.outTradeNo || !ev.goods.productId) {
            procError = 'missing_fields'
            replyCode = 1 // 缺关键字段：重试也不会变好，但按协议回非 0 + 留痕人工介入
          } else {
            const r = await settleFromPayload(ev, 'deliver_notify')
            processed = r.ok
            if (!r.ok) {
              procError = r.code
              // unknown_product（道具未上表）值得人工介入 → 回 0 停止重试防 15 次轰炸？
              // 不：unknown_product 可能是「新商品迁移还没跑」，跑完重试就能成 → 回非 0 让它重试。
              // order_taken_by_other 是攻击特征 → 回 0（重试无意义）+ warn 已在 settle 内留痕。
              replyCode = r.code === 'order_taken_by_other' ? 0 : 1
            }
          }
        } else if (ev.event === 'xpay_refund_notify') {
          const { rows } = await pool.query(
            `SELECT public.revoke_xpay_purchase($1,$2,$3) AS r`,
            [ev.outTradeNo || null, ev.wechatPay.providerTxnId || null, 'refund'],
          )
          const r = rows[0]?.r
          processed = !!r?.revoked
          procError = r?.error ?? null
          // txn_not_found：退款先于发货推送到达（乱序是分布式常态）→ 回非 0 让微信
          // 重试，等发货推送落库后下一次重试就能命中 revoke。
          replyCode = processed ? 0 : 1
          logger.info(`[xpay] refund_notify out_trade_no=${ev.outTradeNo} revoked=${processed}${procError ? ` err=${procError}` : ''}`)
        } else if (ev.event === 'xpay_subscribe_ios_refund_query_notify') {
          // iOS 退款问询：3 秒内应答 result_code（0 同意退款 / 1 拒绝）。
          // 我方虚拟道具「已发货即已消耗权益」，但退款决策涉及客服口径 ——
          // 骨架期一律建议退款（0）：拒错一笔的投诉成本 > 白退一笔的资损，
          // 且 Apple 侧用户申诉成功率本来就高。留痕供对账。
          processed = true
          res.writeHead(200, { 'content-type': isXml ? 'application/xml; charset=utf-8' : 'application/json; charset=utf-8' })
          if (isXml) {
            return res.end('<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg><IosRefundQueryResponse><result_code>0</result_code><evidence><![CDATA[virtual goods refund policy: approve]]></evidence><result_info><![CDATA[approved]]></result_info></IosRefundQueryResponse></xml>')
          }
          return res.end(JSON.stringify({ ErrCode: 0, ErrMsg: 'success', IosRefundQueryResponse: { result_code: 0, evidence: 'virtual goods refund policy: approve', result_info: 'approved' } }))
        } else {
          // xpay_complaint_notify / xpay_wxpay_callback_notify / 未知事件：
          // 只留痕，回成功（不认识的不要挡微信的路，也别让它重试轰炸）
          processed = true
        }
      } catch (err) {
        procError = err?.message || String(err)
        replyCode = 1
        logger.error(`[xpay] 推送处理异常 event=${ev.event} out_trade_no=${ev.outTradeNo}: ${err?.stack || err}`)
      }

      // ── ④ 全量留痕（验签通过的推送无论成败都落库，对账与人工重放的唯一依据）──
      try {
        await pool.query(`SELECT public.log_xpay_notification($1,$2,$3,$4,$5,$6,$7)`, [
          JSON.stringify(msg),
          ev.event || null,
          ev.outTradeNo || null,
          ev.wechatPay.providerTxnId || null,
          ev.openid || null,
          processed,
          procError,
        ])
      } catch (err) {
        logger.error(`[xpay] 推送留痕失败 event=${ev.event}: ${err?.message || err}`)
        // 留痕失败不影响应答：业务已处理成功时绝不能因留痕挂了让微信重推（会重复核销，
        // 虽然 settle 幂等能兜住，但无谓重试是噪音）
      }

      logger.info(`[xpay] 推送 event=${ev.event || 'unknown'} out_trade_no=${ev.outTradeNo || '-'} processed=${processed}${procError ? ` err=${procError}` : ''}`)
      return reply(replyCode, replyCode === 0 ? 'success' : (procError || 'failed'))
    },

    /**
     * POST /.cloud/payment/wechat/query —— 主动查单兜底（推送丢失时客户端轮询）。
     * body: { order_no: string, reconcile?: boolean }
     * 语义（对齐 0046 verify_payment_order 的「查单」改造）：
     *   · 本地订单已 paid 且 reconcile≠true → { settled:true }（推送已处理过，
     *     幂等；**不外呼**，省 access_token 配额并避开 268490015 频率限制）
     *   · 本地 pending（或 reconcile=true 的 paid）→ 外呼 /xpay/query_order：
     *       status 2/3 → 推送该来没来：直接按查单报文 settle（发货兜底）
     *       status 4   → 已发货但本地没核销：同样 settle 补齐（幂等 duplicate）
     *       status 5/8 → 已退款 → revoke（防御：退款推送也可能丢）
     *       status 1/0/6 → 未支付/已关闭 → { settled:false, paid:false }
     *   · 外呼失败 → { settled:false, retry_later:true }（前端继续有限重试，绝不报错）
     *
     * 🔴 reconcile 开关的由来（自测揪出的真实缺陷）：
     *   若对 paid 订单一律提前返回，则「退款推送丢失」永远无法被发现 ——
     *   本地 status 停在 paid，而平台早已 status=5/8，用户退款了却还留着权益
     *   （或反过来：我们以为发了货）。此时 status 5/8 分支就是**死代码**。
     *   故 reconcile=true 时强制外呼对账（供运维脚本/定时任务调用）；
     *   前端支付后的轮询**不要**传 reconcile（只关心「到账了没」，不关心退款）。
     */
    async query(req, res, body) {
      // 🔴 守卫比 params 宽松：查单只依赖 appKey（pay_sig）+ access_token，
      //   不需要 session_key/encKey —— 用户 session_key 过期时下单不可用，
      //   但「已付订单查单补发货」必须仍然可用（否则推送丢失 + session 过期
      //   双故障时用户的钱彻底悬空）。
      if (!cfg.xpayOfferId || !cfg.xpayAppKey) return notConfigured(res)
      const ownerId = await authOwnerId(req)
      if (!ownerId) return cloudError(res, 401, '未登录或登录已过期', 'unauthorized')

      const orderNo = typeof body?.order_no === 'string' ? body.order_no.trim() : ''
      if (!orderNo) return cloudError(res, 400, '缺少 order_no', 'invalid_request')
      const reconcile = body?.reconcile === true

      let order
      try {
        const r = await loadOrder(orderNo, ownerId)
        if (r.error) return cloudError(res, r.error.status, r.error.message, r.error.code)
        order = r.order
      } catch (err) {
        logger.error(`[xpay] query 订单查询失败 order=${orderNo}: ${err?.message || err}`)
        return cloudError(res, 500, '订单查询失败，请稍后重试', 'db_error')
      }
      // 已退款是终态，无需外呼（平台不会再变）
      if (order.status === 'refunded') return { status: 200, body: { settled: false, paid: false, refunded: true } }
      // 已支付：默认提前返回（见上方 reconcile 说明）
      if (order.status === 'paid' && !reconcile) {
        return { status: 200, body: { settled: true, paid: true } }
      }

      // openid = owner_id 去掉 wx: 前缀（0043 确定性形态）
      const openid = ownerId.startsWith('wx:') ? ownerId.slice(3) : ''
      if (!openid) return cloudError(res, 409, '当前账号无法查单，请重新登录', 'invalid_owner')

      let data
      try {
        data = await callQueryOrder({ openid, env: cfg.xpayEnv, orderNo })
      } catch (err) {
        logger.warn(`[xpay] query_order 外呼失败 order=${orderNo}: ${err?.message || err}`)
        return { status: 200, body: { settled: false, paid: false, retry_later: true } }
      }
      if (!data || data.errcode !== 0 || !data.order) {
        logger.warn(`[xpay] query_order 返回异常 order=${orderNo} errcode=${data?.errcode} errmsg=${String(data?.errmsg ?? '').slice(0, 80)}`)
        return { status: 200, body: { settled: false, paid: false, retry_later: true } }
      }

      const st = Number(data.order.status)
      if (st === 2 || st === 3 || st === 4) {
        // 已支付：按查单报文补发货（与推送同一 settle 函数，幂等键相同不会重复发放）
        //
        // 🔴 字段映射以官方 api_query_order 的 Res.order 为准（2026-10-08 版逐字核对）。
        //   **该返回体里没有 goods_info / wechat_pay_info / openid** —— 只有
        //   order_id/status/order_fee/paid_fee/paid_time/order_type/wxpay_order_id/
        //   channel_order_id/wx_order_id/biz_meta 等扁平字段。若按「推送报文」的
        //   嵌套形状去读，productId 会取到 undefined → settle 报 unknown_product
        //   → 用户已扣款却发不了货（推模式最致命的资损场景）。
        //   → 商品与数量改取**我方订单**（create_payment_order 服务端查价落库的
        //     product_id，本就是唯一事实源），平台报文只提供「付没付、付了多少、
        //   平台单号、支付时间」。这比读平台商品字段更安全：客户端与平台都改不了。
        const o = data.order
        const r = await settleFromPayload({
          openid,                                     // 由 JWT sub 推导（owner_id 去 wx: 前缀）
          outTradeNo: String(o.order_id ?? orderNo),
          env: cfg.xpayEnv,                           // 0/1 语义（注意 o.env_type 是 1 现网/2 沙箱，口径不同，不可混用）
          channel: Number(o.order_type) === 7 ? 'apple' : 'wechat',
          goods: {
            productId: String(order.product_id ?? ''), // 🔴 我方订单，非平台报文
            quantity: 1,                              // 本项目一单一件（payment_orders 无 quantity 列）
            origPrice: o.order_fee != null ? Number(o.order_fee) : null,
            actualPrice: o.paid_fee != null ? Number(o.paid_fee) : null,
            attach: typeof o.biz_meta === 'string' && o.biz_meta ? o.biz_meta : orderNo,
          },
          wechatPay: {
            // 优先级：微信支付交易单号 > 渠道单号（用户支付详情页的商户单号）> 微信内部单号
            providerTxnId: o.wxpay_order_id || o.channel_order_id || o.wx_order_id || null,
            paidTime: o.paid_time != null && Number(o.paid_time) > 0 ? Number(o.paid_time) : null,
          },
        }, 'query_order')

        // 🔴 资金结算闸门（2026-11-08 补，见 callNotifyProvideGoods 文件注）：
        //   走到这里说明「钱已收、我方也发了权益」，但平台侧 status 仍是 2/3
        //   （已支付待发货 / 发货中）—— 即**推送从未成功送达**（或当时我方回了非 0）。
        //   此时必须主动调 notify_provide_goods 把订单置为「已发货」，否则平台认为
        //   我方未履约，订单挂起、资金不结算：用户拿到了会员，我方一分钱收不到。
        //   status=4（已发货）时跳过 —— 平台已确认，重复调无意义。
        //   order_type=7（iOS 走 Apple 支付）时跳过 —— 该接口官方限定「只能通知现金单」，
        //   Apple 侧结算链路独立（自然月结束后 45~60 天），我方无权替其确认。
        //   🔴 判据取「平台当前状态」而非「本地是否刚 settle」，故天然幂等：
        //     重复对账时 status 已是 4 → 不再调；调用失败 → 下次 reconcile 会再试。
        const isApple = Number(o.order_type) === 7
        if ((st === 2 || st === 3) && !isApple) {
          try {
            await callNotifyProvideGoods({ orderNo: String(o.order_id ?? orderNo), env: cfg.xpayEnv })
          } catch (err) {
            // 不影响用户权益（权益已落库）：只留痕，等下次对账重试
            logger.error(`[xpay] notify_provide_goods 异常 order=${orderNo}: ${err?.message || err}`)
          }
        }

        if (r.ok) return { status: 200, body: { settled: true, paid: true, plan: r.result?.plan ?? 'pro' } }
        return { status: 200, body: { settled: false, paid: true, settling: true, code: r.code } }
      }
      if (st === 5 || st === 8) {
        try {
          await pool.query(`SELECT public.revoke_xpay_purchase($1,$2,$3) AS r`, [orderNo, null, 'refund'])
        } catch (err) {
          logger.error(`[xpay] query 路径 revoke 失败 order=${orderNo}: ${err?.message || err}`)
        }
        return { status: 200, body: { settled: false, paid: false, refunded: true } }
      }
      // 0/1/6：未支付或已关闭
      return { status: 200, body: { settled: false, paid: false, status: st } }
    },
  }
}
