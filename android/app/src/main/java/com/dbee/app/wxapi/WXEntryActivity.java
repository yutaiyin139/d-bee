package com.dbee.app.wxapi;

import ee.forgr.plugin.capacitor_wechat.WechatResponseActivity;

/**
 * 微信登录 / 分享的回调入口。
 *
 * 微信 SDK 硬性要求回调 Activity 必须位于 `<应用包名>.wxapi.WXEntryActivity`，
 * 且 exported=true —— 微信是个外部应用，它要把结果用显式 Intent 发回来。
 * 这里不写任何逻辑，全部交给插件基类处理（它会解析 Intent 并把结果
 * 分发给 WebView 侧等待中的 Promise）。
 *
 * 包名与 AndroidManifest 里的 package / applicationId 必须严格一致，
 * 改名（applicationId 变更）后这个目录也要同步改名，否则回调永远收不到。
 */
public class WXEntryActivity extends WechatResponseActivity {}
