# DbeeAlipay 插件自身混淆规则（consumerProguardFiles，随 AAR/模块传递给宿主）。
#
# 🔴 支付宝 SDK 的 AAR **自带** consumerProguardFiles（已解包确认 proguard.txt 内注明
#    「AAR 包的使用者在其应用进行 ProGuard 混淆时，将自动附加下列规则」），
#    故 SDK 内部类（PayTask / IAlixPay / apmobilesecuritysdk / utdid2 等）的 keep
#    规则**无需在此重复** —— 重复声明只会增加维护面与冲突风险。
#
# 本文件只 keep **本插件自己**暴露给 WebView JS 调用的类：
#    · DbeeAlipayPlugin —— Capacitor 靠 @CapacitorPlugin(name="DbeeAlipay") 反射注册，
#      被混淆改名 → JS 侧 Plugins.DbeeAlipay 探测失败 → 支付宝静默不可用。
#    · @PluginMethod 标注的 pay / getVersion 由 Capacitor 反射按方法名调用，必须保名。
#
# ⚠️ 当前宿主 android/app/build.gradle 为 minifyEnabled false，本规则暂不生效；
#    此处先行声明是为「日后开启混淆」兜底 —— 那属于静默失效类事故（构建成功、功能消失），
#    必须提前防住。
-keep class com.dbee.alipay.DbeeAlipayPlugin { *; }
