package com.dbee.health

/**
 * 构建链探针（HC-2 前置验证用）。
 *
 * 已于 2026-11-18 完成 Kotlin 侧符号名验证，结论固化在 [HealthConnectReader] 注释中：
 *   · `Energy.inKilocalories` / `Length.inMeters`（@JvmName 改名为 getXxx，javap 会骗人）
 *   · `HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS`（同上）
 *   · `PermissionController.createRequestPermissionResultContract()` 用**无参重载**
 *     （带 tag 的重载需要 internal 的 HEALTH_CONNECT_CLIENT_TAG，宿主不可访问）
 *
 * 保留本文件是为了下次升级 connect-client 版本时能再次用「编译器裁决」快速验名：
 * 往这里加候选写法跑一次 compileDebugKotlin，未报错者即真名（比读文档/反编译可靠）。
 */
internal object HealthConnectProbe {
    val marker: String = "probe"
}
