package com.dbee.health;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * DbeeHealth —— D-Bee 厂商运动健康插件（Android 侧）。
 *
 * 与 iOS 侧 DbeeHealthPlugin.swift 接口逐条对齐（前端 src/lib/health/android.ts
 * 鸭子类型探测 window.Capacitor.Plugins.DbeeHealth，接口一致、平台无感知）：
 *   - requestAuthorization({ read }) → { completed }
 *   - fetchToday()                  → { steps, activeKcal }
 *
 * 覆盖两类厂商（运行时由品牌识别分派，本插件接口统一）：
 *   - 华为 Health Kit（com.huawei.hms:health）
 *   - 小米运动健康数据服务 SDK（readTodaySummation 等）
 *
 * ── 阶段 3a 说明（当前状态：骨架 + 反射探测）──────────────────────────────
 * 华为 Health Kit / 小米运动健康数据服务的完整授权均依赖「开发者账号 + 服务申请 +
 * 签名配置 + 资质审核」，见 docs/健康数据源方案.md 与 docs/华为HealthKit接入方案.md。
 *
 * 为避免在无资质、无真机的阶段引入无法验证的厂商 SDK 依赖（破坏主构建 / 打包），
 * 本文件当前只做「接口占位 + 反射探测 HMS 能力」，**零新增编译依赖**：
 *   - requestAuthorization 返回 completed=false（真授权待资质后接厂商 SDK）
 *   - fetchToday           返回 0（真读数据待资质后接 readTodaySummation）
 * 前端据此降级为「引导」提示，不影响手动运动（与 Apple 端「拿不到数据不影响」一致）。
 *
 * ── 真实现路径（资质就绪后替换本方法体）──────────────────────────────
 * 1. build.gradle 加对应厂商 Maven 仓库 + SDK 依赖
 *    （华为 health / 小米 healthkit）
 * 2. 授权：厂商账号授权 + Scope（步数/卡路里）
 * 3. 读步数：DataController.readTodaySummation（步数类型）
 * 4. 读活动能量：卡路里类型（语义对齐待真机确认，默认只同步步数）
 */
@CapacitorPlugin(name = "DbeeHealth")
public class DbeeHealthPlugin extends Plugin {

    private static final String TAG = "d-bee-health";

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
        Log.d(TAG, "fetchToday: 华为 Health Kit 待资质接入，返回 0");
        JSObject ret = new JSObject();
        ret.put("steps", 0);
        ret.put("activeKcal", 0);
        call.resolve(ret);
    }
}
