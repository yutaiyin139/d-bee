import { registerPlugin } from '@capacitor/core'

/**
 * 原生侧按 @CapacitorPlugin(name = "DbeeAlipay") 注入。
 * 业务代码不 import 本文件，付费墙用 window.Capacitor.Plugins.DbeeAlipay 做鸭子探测。
 * 三处名字必须相同：本文件、DbeeAlipayPlugin.java、src/lib/payment/alipay.ts。
 */
const DbeeAlipay = registerPlugin('DbeeAlipay')

export { DbeeAlipay }
