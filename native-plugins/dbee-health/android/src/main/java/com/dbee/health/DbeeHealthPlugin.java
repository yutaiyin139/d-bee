package com.dbee.health;

import android.app.Activity;
import android.content.Intent;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * DbeeHealth —— D-Bee 运动健康插件（Android 侧）。
 *
 * 与 iOS 侧 DbeeHealthPlugin.swift 接口逐条对齐（前端 src/lib/health/android.ts、
 * connect.ts 鸭子类型探测 window.Capacitor.Plugins.DbeeHealth，接口一致、平台无感知）：
 *
 *   ── 厂商通道（华为 Health Kit / 小米运动健康）────────────────────
 *   - requestAuthorization({ read }) → { completed, reason }
 *   - fetchToday()                   → { steps, activeKcal, status }
 *
 *   ── Health Connect 通道（HC-2，2026-11-18 起真实装）─────────────
 *   - healthConnectStatus()               → { available, sdkStatus, ...诊断字段 }
 *   - requestHealthConnectAuthorization() → { completed, reason? }
 *   - fetchHealthConnectToday()           → { steps, activeKcal, status, ... }
 *
 * 两条通道并存：门面（src/lib/health/index.ts）在 Android 上 **HC 优先 → 厂商 SDK 兜底**。
 * HC 是跨品牌系统统一层（一次授权通吃各家穿戴设备），厂商 SDK 只覆盖自家设备且依赖资质。
 *
 * ── 厂商通道现状（阶段 3a：骨架 + 反射探测，零编译依赖）──────────────
 * 华为/小米完整授权依赖「开发者账号 + 服务申请 + 签名配置 + 资质审核」，且华为要求
 * 应用先上架华为应用市场（被 App 备案死锁）。故厂商通道保持诚实降级：
 *   - requestAuthorization 返回 completed=false + reason='not_ready'
 *   - fetchToday           返回 status='not_ready'（**不是** 0 步）
 * 前端据此提示「接入中」，不误导用户以为今天没运动，也不影响手动记录。
 *
 * ── 🔴 零假功能（铁律 #13 / D7）───────────────────────────────────
 * 任何「读不到」都如实上报状态，绝不把 unavailable / denied / not_ready 伪装成 0 步。
 * 真机验收前，前端目录里的 health_connect 行保持 in_progress（护栏钉死，不得改 available）。
 */
@CapacitorPlugin(name = "DbeeHealth")
public class DbeeHealthPlugin extends Plugin {

    private static final String TAG = "d-bee-health";

    /** HC 授权 Activity 的回调名（startActivityForResult → @ActivityCallback 方法名） */
    private static final String HC_AUTH_CALLBACK = "healthConnectAuthResult";

    /** 华为 Health Kit 核心类全限定名（反射探测 HMS 是否可用，避免硬依赖） */
    private static final String HMS_HEALTH_CLASS = "com.huawei.hms.hihealth.HuaweiHiHealth";

    /**
     * HMS Core / Health Kit 运行时是否可用（反射探测，零编译依赖）。
     * 仅用于诊断日志与降级判断，不决定最终授权结果。
     */
    private boolean isHmsAvailable() {
        try {
            Class.forName(HMS_HEALTH_CLASS);
            return true;
        } catch (ClassNotFoundException e) {
            return false;
        }
    }

    /* ══════════════════════════════════════════════════════════════
     * Health Connect 通道（HC-2）
     * ══════════════════════════════════════════════════════════════ */

    /**
     * HC 运行时可用性 + HC-0 真机诊断信息。
     *
     * 前端 `probeHealthConnectAvailability()` 只读 `available` 一个布尔（跨进程查询
     * 一次后缓存，不进轮询热路径）；其余字段是 **HC-0 覆盖率矩阵**的原始素材 ——
     * 用户在华为/小米真机上各跑一次，把「诊断」文本贴回来即可判定该机型能否走 HC，
     * 无需连 adb 看 logcat。
     *
     * 🔴 不返回任何健康数值（步数/卡路里属敏感个人信息，不进非必要字段、不落日志）。
     */
    @PluginMethod
    public void healthConnectStatus(PluginCall call) {
        try {
            HealthConnectReader.checkAvailability(getContext(), (HashMap<String, Object> data) -> {
                JSObject ret = toJSObject(data);
                // 供前端在「连接失败」时把原始诊断摊给用户（真机排查的唯一线索）
                ret.put("diagnostics", diagnosticsText(data));
                call.resolve(ret);
            });
        } catch (Throwable t) {
            // 🔴 兜底也如实报「不可用」，绝不谎报 available=true
            Log.w(TAG, "healthConnectStatus failed: " + t.getClass().getSimpleName());
            JSObject ret = new JSObject();
            ret.put("available", false);
            ret.put("reason", "probe_failed:" + t.getClass().getSimpleName());
            call.resolve(ret);
        }
    }

    /**
     * 发起 HC 读授权（拉起系统 HC 授权页）。
     *
     * 🔴 与 HealthKit 同构的诚实语义：`completed` 只表示「授权流程走完」，
     *    **不代表用户同意**（用户可能全拒）。是否真有数据以 fetchHealthConnectToday
     *    的 status 为准（denied = 一项都没授）。
     *
     * 🔴🔴 必须用 `createPermissionIntentAsync`（2026-11-18 复查发现的 ANR 隐患）：
     *    原先同步调 `createPermissionIntent()`，而它内部有 `getSdkStatus()` 与
     *    `getOrCreate()` 两个**跨进程阻塞调用**；Capacitor 的 @PluginMethod 跑在
     *    **主线程** → 阻塞即 ANR（用户观感：点「连接」后界面卡死、系统弹「应用无响应」）。
     *    异步版在 IO 线程执行、各步 6s 超时、结果回主线程再 `startActivityForResult`
     *    （启动 Activity 本身必须在主线程），彻底消除主线程阻塞。
     *    回调**必定**触发（成功给 Intent、任何失败给 null），绝不让前端 Promise 永驻。
     */
    @PluginMethod
    public void requestHealthConnectAuthorization(PluginCall call) {
        try {
            HealthConnectReader.createPermissionIntentAsync(getContext(), intent -> {
                try {
                    if (intent == null) {
                        // 本机没有 HC（或 provider 需更新 / 查询超时）→ 如实告知，前端转引导文案
                        JSObject ret = new JSObject();
                        ret.put("completed", false);
                        ret.put("reason", "unavailable");
                        ret.put("message", "当前设备未安装 Health Connect 或版本过旧");
                        call.resolve(ret);
                        return;
                    }
                    startActivityForResult(call, intent, HC_AUTH_CALLBACK);
                } catch (Throwable t) {
                    // 🔴 回调跑在主线程，任何逃逸都会闪退；如实转 system_error
                    Log.w(TAG, "HC auth callback failed: " + t.getClass().getSimpleName());
                    call.resolve(hcFailure("system_error", String.valueOf(t.getMessage())));
                }
            });
        } catch (Throwable t) {
            Log.w(TAG, "requestHealthConnectAuthorization failed: " + t.getClass().getSimpleName());
            call.resolve(hcFailure("system_error", String.valueOf(t.getMessage())));
        }
    }

    /** 统一的失败返回体（避免三处重复构造，且保证字段齐全不会漏 reason） */
    private JSObject hcFailure(String reason, String message) {
        JSObject ret = new JSObject();
        ret.put("completed", false);
        ret.put("reason", reason);
        ret.put("message", message);
        return ret;
    }

    /**
     * 授权页返回后的回调。
     *
     * 🔴🔴 签名必须是 `(PluginCall, ActivityResult)` —— 这是 Capacitor 3+ 的 @ActivityCallback 契约。
     *    已实证 Capacitor 8.5.3 的 `Plugin.triggerActivityCallback()`：
     *        method.setAccessible(true);
     *        method.invoke(this, savedCall, result);      ← 只传 2 个参数
     *    若沿用旧版 `(PluginCall, int, Intent)` 三参签名，反射调用会抛
     *    `IllegalArgumentException: wrong number of arguments`，而该方法的 catch 只捕获
     *    IllegalAccessException / InvocationTargetException → **异常逃逸到主线程的
     *    activity-result 分发链 → App 闪退**。
     *    这就是「点连接运动健康 → 闪退」的确定性根因（2026-11-18 小米 15 Ultra 实测）。
     *
     * 🔴 以 HC contract 解析出的**实际授予集合**为准，不看 resultCode ——
     *    HC 授权页在用户全拒时也可能返回 RESULT_OK，只看 resultCode 会把
     *    「已拒绝」谎报成「已授权」。
     */
    @ActivityCallback
    private void healthConnectAuthResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        try {
            int resultCode = result != null ? result.getResultCode() : Activity.RESULT_CANCELED;
            Intent data = result != null ? result.getData() : null;
            Set<String> granted = HealthConnectReader.parsePermissionResult(resultCode, data);
            int wantCount = HealthConnectReader.READ_PERMISSIONS.size();
            int grantedCount = 0;
            for (String p : granted) {
                if (HealthConnectReader.READ_PERMISSIONS.contains(p)) grantedCount++;
            }

            JSObject ret = new JSObject();
            ret.put("completed", true);
            ret.put("grantedCount", grantedCount);
            ret.put("wantCount", wantCount);
            // 只勾距离、或一项都没勾：读数端用不上，不能当成已连接
            if (!HealthConnectReader.grantsStepsOrCalories(granted)) {
                ret.put("reason", "no_types");
                ret.put("message", "已打开授权页，但未授予步数或活动能量");
            } else if (grantedCount < wantCount) {
                ret.put("message", "已授权 " + grantedCount + "/" + wantCount
                        + " 项读取权限（部分指标不会同步）");
            }
            call.resolve(ret);
        } catch (Throwable t) {
            // 🔴 Throwable：这里是主线程回调，任何逃逸都会直接闪退
            Log.w(TAG, "healthConnectAuthResult failed: " + t.getClass().getSimpleName());
            JSObject ret = new JSObject();
            ret.put("completed", false);
            ret.put("reason", "system_error");
            ret.put("message", String.valueOf(t.getMessage()));
            call.resolve(ret);
        }
    }

    /**
     * 读当天步数 + 活动能量（HC `aggregate` 聚合读，自动多源去重）。
     *
     * status 与 iOS 侧 7 态逐条对齐：ok / empty / denied / error / unavailable。
     * 🔴 设备无 HC → `unavailable`（**不是** 0 步）；一项权限都没授 → `denied`；
     *    今天真没样本（如没戴表）→ `empty`。三者引导文案完全不同，不得混淆。
     */
    /**
     * 打开健康连接的安装页或设置页。
     * target=install：Android 13 及以下还没装健康连接时，去应用商店安装。
     * target=settings：已安装时打开系统页，让用户核对步数共享。
     */
    @PluginMethod
    public void openHealthConnect(PluginCall call) {
        String target = call.getString("target", "settings");
        if (!"install".equals(target)) target = "settings";
        android.content.Context ctx = getActivity() != null ? getActivity() : getContext();
        try {
            HealthConnectReader.openSetup(ctx, target, (HashMap<String, Object> data) -> call.resolve(toJSObject(data)));
        } catch (Throwable t) {
            Log.w(TAG, "openHealthConnect failed: " + t.getClass().getSimpleName());
            JSObject ret = new JSObject();
            ret.put("opened", false);
            ret.put("reason", t.getClass().getSimpleName());
            call.resolve(ret);
        }
    }

    /** 读取秤、跳绳、营养、血糖写入健康连接的当天样本。数值不进日志。 */
    @PluginMethod
    public void fetchHealthDevices(PluginCall call) {
        try {
            HealthConnectReader.fetchDevices(getContext(), (HashMap<String, Object> data) -> {
                Log.d(TAG, "fetchHealthDevices: status=" + data.get("status"));
                call.resolve(toJSObject(data));
            });
        } catch (Throwable t) {
            Log.w(TAG, "fetchHealthDevices failed: " + t.getClass().getSimpleName());
            JSObject ret = new JSObject();
            ret.put("status", "error");
            ret.put("message", String.valueOf(t.getMessage()));
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void fetchHealthConnectToday(PluginCall call) {
        try {
            HealthConnectReader.fetchToday(getContext(), false, (HashMap<String, Object> data) -> {
                // 🔴 日志只记 status，不记数值（健康明细属敏感个人信息）。
                // 从 HashMap 取而非 ret.get()：JSObject.get 声明了受检异常 JSONException，
                // 而 data 本来就在手边，没必要为打一行日志去包 try。
                Log.d(TAG, "fetchHealthConnectToday: status=" + data.get("status"));
                call.resolve(toJSObject(data));
            });
        } catch (Throwable t) {
            Log.w(TAG, "fetchHealthConnectToday failed: " + t.getClass().getSimpleName());
            JSObject ret = new JSObject();
            ret.put("steps", 0);
            ret.put("activeKcal", 0);
            ret.put("status", "error");
            ret.put("message", String.valueOf(t.getMessage()));
            call.resolve(ret);
        }
    }

    /**
     * HashMap → JSObject。
     * 🔴 必须按类型分派：JSObject 没有通用的 put(Object)，直接塞 Object 会全部退化成
     *    toString() → 前端拿到的 `available` 变成字符串 "false"，而 `"false"` 在 JS 里
     *    是 **truthy** → 把「设备不支持 HC」误判成「支持」，静默产生假功能。
     */
    private JSObject toJSObject(HashMap<String, Object> data) {
        JSObject ret = new JSObject();
        for (Map.Entry<String, Object> e : data.entrySet()) {
            Object v = e.getValue();
            if (v == null) continue;
            String k = e.getKey();
            if (v instanceof Boolean) {
                ret.put(k, (Boolean) v);
            } else if (v instanceof Integer) {
                ret.put(k, (Integer) v);
            } else if (v instanceof Long) {
                ret.put(k, ((Long) v).intValue());
            } else if (v instanceof Double) {
                ret.put(k, (Double) v);
            } else if (v instanceof Float) {
                ret.put(k, ((Float) v).doubleValue());
            } else {
                ret.put(k, String.valueOf(v));
            }
        }
        return ret;
    }

    /**
     * 把诊断字段拼成一行人话，供前端在 HC 不可用时展示（真机排查唯一线索）。
     * 🔴 只拼设备/状态元信息，不含任何健康数值。
     */
    private String diagnosticsText(HashMap<String, Object> data) {
        StringBuilder sb = new StringBuilder();
        sb.append("HC=").append(data.get("sdkStatusLabel"))
          .append(" sdkStatus=").append(data.get("sdkStatus"))
          .append(" API=").append(data.get("androidApi"))
          .append(" 品牌=").append(data.get("brand"))
          .append("/").append(data.get("manufacturer"))
          .append(" 型号=").append(data.get("model"))
          .append(" 设置页可解析=").append(data.get("hcSettingsResolvable"));
        Object reason = data.get("reason");
        if (reason != null) sb.append(" reason=").append(reason);
        Object gc = data.get("grantedCount");
        if (gc != null) {
            sb.append(" 已授权=").append(gc).append('/')
              .append(HealthConnectReader.READ_PERMISSIONS.size());
        }
        return sb.toString();
    }

    /* ══════════════════════════════════════════════════════════════
     * 厂商通道（华为 Health Kit / 小米运动健康）—— 资质就绪前诚实降级
     * ══════════════════════════════════════════════════════════════ */

    @PluginMethod
    public void requestAuthorization(PluginCall call) {
        boolean hms = isHmsAvailable();
        Log.d(TAG, "requestAuthorization: hms=" + hms
                + "（厂商健康 SDK 完整授权待资质接入，当前降级）");
        JSObject ret = new JSObject();
        // 阶段 3a：完整授权（厂商 Account Kit Activity）待资质接入，恒返回 false + reason=not_ready。
        // 前端据此区分「资质未就绪」与「用户拒绝授权」，给出诚实引导
        // （资质就绪后接真实 SDK，去掉 reason，按真实结果返回 completed）。
        ret.put("completed", false);
        ret.put("reason", "not_ready");
        call.resolve(ret);
    }

    @PluginMethod
    public void fetchToday(PluginCall call) {
        Log.d(TAG, "fetchToday: 华为 Health Kit 待资质接入，返回 not_ready");
        JSObject ret = new JSObject();
        ret.put("steps", 0);
        ret.put("activeKcal", 0);
        // 与 iOS 侧 status 字段逐条对齐（前端只认 status，不再按「0 就是没数据」推断）。
        // 厂商资质未就绪 → not_ready，前端据此提示「接入中」而非「今天 0 步」。
        ret.put("status", "not_ready");
        call.resolve(ret);
    }
}
