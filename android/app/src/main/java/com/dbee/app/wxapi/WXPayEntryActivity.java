package com.dbee.app.wxapi;

import ee.forgr.plugin.capacitor_wechat.WechatResponseActivity;

/**
 * 微信支付回调入口。
 *
 * 与 WXEntryActivity 同理，微信要求支付结果必须回到 `<包名>.wxapi.WXPayEntryActivity`。
 * 当前 App 的支付走应用商店内购（Apple 3.1.1 / 国内渠道），并不使用微信支付，
 * 但这个 Activity 必须存在 —— 微信 SDK 初始化后会检查它，缺失会导致 SDK 行为异常。
 * 将来若接入微信支付（阶段 3 的 Web/安卓渠道方案），逻辑同样由插件基类承担。
 */
public class WXPayEntryActivity extends WechatResponseActivity {}
