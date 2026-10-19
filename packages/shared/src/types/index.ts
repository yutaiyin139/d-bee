/**
 * 多端共享的会员权益类型。
 * 注意：这里只放「无环境依赖」的纯类型，供 Web / iOS / Android / 小程序共用。
 */

export type UserPlan = 'free' | 'pro' | 'lifetime'

export interface Entitlement {
  id?: number
  plan: UserPlan
  pro_until: string | null
  redeemed_code: string | null
  /** 支付来源：redeem(兑换码) / wechat / alipay / apple / google */
  source?: string | null
  updated_at?: string
}
