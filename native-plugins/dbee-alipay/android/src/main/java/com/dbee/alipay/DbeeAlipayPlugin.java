package com.dbee.alipay;

import android.app.Activity;
import android.util.Log;

import com.alipay.sdk.app.PayTask;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * D-Bee 支付宝 App 支付插件（路线①自写本地插件，2026-11-20）。
 *
 * ── 为什么自写而不用社区插件 @foskym/capacitor-alipay（四条实证理由）──────
 *  ① 注册名不可控：该插件 `@CapacitorPlugin(name = "Alipay")`，而本项目适配层
 *     `src/lib/payment/alipay.ts` 鸭子探测的是 `Plugins.DbeeAlipay`（原 `CapacitorAlipay`，
 *     本次随自写插件统一改为 Dbee* 命名体系，与 DbeeHealth / DbeeIap 一致）。
 *     装上社区插件 → 探测名不匹配 → `getPlugin()` 返回 null → 支付宝**静默不可用**，
 *     构建 exit 0、无任何警告（与 .env 缺键同一类静默失效，最难查）。
 *  ② 入参字段不一致：社区插件收 `orderInfo`，本项目全链路（网关 apppay/prepay →
 *     alipay.ts → types.ts）统一叫 `orderStr`，需要额外写适配层做字段改名。
 *  ③ 多余的 register 步骤：社区插件要求先 `register({appId})`；而原生 SDK 的
 *     `payV2(orderStr, true)` **不需要** appId —— appId 已由服务端签进 orderStr
 *     （javap 实证 PayTask 构造签名只有 `PayTask(Activity)`，无任何 appId 入参）。
 *     多这一步等于多一处「忘了调就失败」的坑。
 *  ④ 供应链风险：社区插件的 SDK 依赖写成 `com.alipay.sdk:alipaysdk-android:+@aar`
 *     —— 动态版本 `+` 意味着每次构建可能拉到不同二进制，产物不可复现。
 *     本插件钉死精确版本（见 android/variables.gradle 的 alipaySdkVersion）。
 *
 * ── 契约（与 src/lib/payment/alipay.ts 逐字对齐，改任一侧都要同步）─────────
 *   入参  : { orderStr: string }         ← 服务端统一下单返回的完整 orderStr
 *   返回  : { resultStatus: string, result: string, memo: string }
 *           resultStatus: 9000 成功 / 8000 处理中 / 6001 用户取消 / 4000 失败
 *
 * 🔴 本插件**不判断**成功失败、**不重试**、**不补单**：原样透传 SDK 返回的三字段，
 *    由适配层决定语义（9000/8000 都交服务端异步通知 + 网关查单兜底确认，
 *    绝不因客户端返回 9000 就直接发权益 —— 与 Apple IAP / 微信支付同一安全模型）。
 *
 * 🔴 零假成功（铁律 #13 / D7）：任何异常路径都如实上报 4000 + 具体 memo 原因，
 *    绝不把「SDK 抛异常 / Activity 不可用 / 返回 Map 缺字段」伪装成支付成功。
 */
@CapacitorPlugin(name = "DbeeAlipay")
public class DbeeAlipayPlugin extends Plugin {

    private static final String TAG = "d-bee-alipay";

    /**
     * 🔴 payV2 必须在后台线程：它是**阻塞调用**（内部走网络，且会拉起支付宝 App
     *    并等待用户操作完成后才返回），而 Capacitor 的 @PluginMethod 跑在**主线程**
     *    → 直接调用必 ANR（与 dbee-health 的 HC 授权同一类隐患，那边 2026-11-18
     *    已在小米 15 Ultra 真机实测踩过）。
     *    用单线程串行 executor：同一时刻只允许一笔支付在飞，避免用户连点造成并发下单。
     */
    private ExecutorService executor;

    @Override
    public void load() {
        executor = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "dbee-alipay-pay");
            t.setDaemon(true);
            return t;
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
    }

    /**
     * 拉起支付宝收银台。
     *
     * 🔴 回调**必定**触发（每条路径都 resolve/reject），绝不让前端 Promise 永驻 ——
     *    永驻的后果是付费墙转圈不消失，用户以为卡死（dbee-health 同款纪律）。
     *
     * ⚠️ 已知固有限制（支付宝 SDK 设计，非本插件缺陷）：payV2 阻塞期间若 App 被系统
     *    回收重建，该 PluginCall 丢失、前端 Promise 不会 resolve。故权益发放**不依赖**
     *    此返回值：服务端异步通知 + 前端重新拉取权益为权威路径（见 alipay.ts 注释）。
     */
    @PluginMethod
    public void pay(PluginCall call) {
        final String orderStr = call.getString("orderStr");
        if (orderStr == null || orderStr.trim().isEmpty()) {
            call.reject("orderStr 不能为空（应由服务端统一下单返回）");
            return;
        }

        final Activity activity = getActivity();
        if (activity == null) {
            // 诚实上报，不伪装成功
            resolveOnMain(call, result("4000", "", "activity_unavailable"));
            return;
        }

        final ExecutorService exec = executor;
        if (exec == null || exec.isShutdown()) {
            resolveOnMain(call, result("4000", "", "plugin_destroyed"));
            return;
        }

        final String order = orderStr.trim();
        try {
            exec.execute(() -> {
                Map<String, String> raw;
                try {
                    // javap 实证签名（alipaysdk-android 15.8.42）：
                    //   public synchronized Map<String,String> payV2(String, boolean)
                    // 第二参 = 是否显示 SDK 自带 loading；传 true 让用户知道正在处理。
                    raw = new PayTask(activity).payV2(order, true);
                } catch (Throwable t) {
                    // 🔴 捕获 Throwable：支付宝 SDK 内部有大量反射与跨进程调用，
                    //    历史上会抛 Error 子类（如 NoClassDefFoundError / 混淆冲突），
                    //    只 catch Exception 会让异常逃逸到 executor → 前端 Promise 永驻。
                    Log.w(TAG, "payV2 threw: " + t.getClass().getSimpleName());
                    resolveOnMain(call, result("4000", "", "sdk_exception:" + t.getClass().getSimpleName()));
                    return;
                }
                resolveOnMain(call, fromRawMap(raw));
            });
        } catch (Throwable t) {
            // executor 已关闭等极端情况：仍须给前端一个明确结果
            Log.w(TAG, "submit failed: " + t.getClass().getSimpleName());
            resolveOnMain(call, result("4000", "", "submit_failed:" + t.getClass().getSimpleName()));
        }
    }

    /**
     * SDK 版本查询（真机排查用：确认打进包里的到底是哪版 SDK，
     * 对应 variables.gradle 钉死的 alipaySdkVersion）。
     */
    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            String v = new PayTask(getActivity()).getVersion();
            JSObject ret = new JSObject();
            ret.put("version", v == null ? "" : v);
            call.resolve(ret);
        } catch (Throwable t) {
            JSObject ret = new JSObject();
            ret.put("version", "");
            ret.put("reason", "probe_failed:" + t.getClass().getSimpleName());
            call.resolve(ret);
        }
    }

    /* ══════════════════════════════════════════════════════════════
     * 内部工具
     * ══════════════════════════════════════════════════════════════ */

    /**
     * 把 payV2 返回的 Map 转成 JSObject。
     *
     * 🔴 三个字段一律兜底为空串而非 null：适配层的 TS 类型是
     *    `{ resultStatus: string; result: string; memo: string }`（非可选），
     *    返回 null 会让 `res.resultStatus === '6001'` 之类的比较静默失效、
     *    并把 null 拼进错误提示文案（用户看到「支付宝支付未完成（null）」）。
     */
    private JSObject fromRawMap(Map<String, String> raw) {
        if (raw == null) {
            return result("4000", "", "sdk_returned_null");
        }
        String resultStatus = nullToEmpty(raw.get("resultStatus"));
        String result = nullToEmpty(raw.get("result"));
        String memo = nullToEmpty(raw.get("memo"));
        // 🔴 SDK 极端情况下会返回空 Map（如进程被打断）：如实标记，不当成功
        if (resultStatus.isEmpty()) {
            memo = memo.isEmpty() ? "sdk_empty_result" : memo;
            resultStatus = "4000";
        }
        return result(resultStatus, result, memo);
    }

    private static JSObject result(String resultStatus, String result, String memo) {
        JSObject ret = new JSObject();
        ret.put("resultStatus", nullToEmpty(resultStatus));
        ret.put("result", nullToEmpty(result));
        ret.put("memo", nullToEmpty(memo));
        return ret;
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }

    /**
     * 回主线程 resolve。
     *
     * 已实证 Capacitor 8.5.3 的 `PluginCall.resolve()` → `MessageHandler.sendResponseMessage()`
     * 内部走 `javaScriptReplyProxy.postMessage()` 或 `webView.post()`，理论上可从后台线程调用；
     * 但仍统一切回主线程 —— 与 dbee-health 的 `withContext(Dispatchers.Main)` 纪律一致，
     * 且规避 legacy bridge 分支下的时序不确定性。
     * Activity 已销毁时降级为直接 resolve（宁可时序略偏，也绝不让 Promise 永驻）。
     */
    private void resolveOnMain(final PluginCall call, final JSObject data) {
        final Activity a = getActivity();
        if (a == null) {
            call.resolve(data);
            return;
        }
        a.runOnUiThread(() -> call.resolve(data));
    }
}
