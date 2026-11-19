package com.dbee.health

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.time.LocalDate

/**
 * Health Connect 读数器（HC-2，2026-11-18）。
 *
 * 职责：把 HC 的 Kotlin suspend API 封装成「回调式」方法，供 Java 侧
 * [DbeeHealthPlugin] 直接桥接（Java 不能调 suspend 函数，故用 callback 而非协程穿透）。
 *
 * ── 🔴 读数三铁律（踩了会静默错数据，见 docs/Android运动健康-现状梳理与实施计划 §4 P2）──
 * 1. 用 `aggregate()` **不用** `readRecords()`：前者按用户在 HC 里设定的应用优先级
 *    **自动多源去重**。用 readRecords 再自己累加 → 华为运动 + 手环 + Google Fit 同一段
 *    步数被重复计入，步数虚高。
 * 2. **禁写死 `dataOriginFilter` 包名**：2026-06 起设备本地步数的 DataOrigin 从
 *    `android` 包名改为 device-specific SPN。按包名过滤 → 设备自记步数**静默漏计**
 *    （表现为「戴了表但步数是 0」）。故本类 aggregate 的 dataOriginFilter 恒为**空集**。
 * 3. 时间窗用**设备本地时区当天零点**（`LocalDate.now().atStartOfDay()`）：
 *    用 UTC 会让「今天」在东八区错开 8 小时 → 跨时区步数错位。
 *
 * ── 🔴 零假功能（铁律 #13 / D7）────────────────────────────────────
 * 任何「读不到」的情形都如实上报状态，**绝不把 unavailable / denied 伪装成 0 步**：
 *   sdkStatus != SDK_AVAILABLE → `unavailable`（设备没有 HC 或 provider 需更新）
 *   读权限一项都没授          → `denied`（引导用户去 HC 应用勾权限）
 *   aggregate 返回 null       → `empty`（今天真没样本，如没戴表）
 *   抛异常                    → `error`（附原始 message，便于真机定位）
 *
 * ── 性能（用户明确要求「注意系统性能」）──────────────────────────────
 * · HC client 是**跨进程连接**，用 @Volatile + 双检锁做进程内单例，不每次读都新建。
 * · 所有 HC 调用在 [Dispatchers.IO] 上执行，**绝不阻塞主线程**（WebView 渲染线程）。
 * · 每次读前复查 `getGrantedPermissions()`（一次跨进程调用）：用户可能在 HC 应用里
 *   撤销过权限，缓存授权态会导致「明明撤了还显示旧步数」的假象。
 * · 日志**不落健康明细数值**（步数/卡路里属敏感个人信息），只记状态与异常类型。
 */
internal object HealthConnectReader {

    private const val TAG = "d-bee-health-hc"

    /**
     * 只申**读**权限：步数 / 活动能量 / 距离。
     * 🔴 不申 WRITE_*（D-Bee 只读不写用户健康数据）、不申历史/后台权限（最小必要原则，
     *    也是 Play Health apps declaration 审核能过的前提）。
     */
    @JvmField
    val READ_PERMISSIONS: Set<String> = setOf(
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
        HealthPermission.getReadPermission(DistanceRecord::class),
    )

    /** 回调式结果（Java 侧看到的是 HashMap<String, Object>） */
    fun interface ResultCallback {
        fun onResult(data: HashMap<String, Any?>)
    }

    /** 进程内单例：getOrCreate 会建立跨进程连接，重复创建有开销 */
    @Volatile
    private var cachedClient: HealthConnectClient? = null

    /**
     * 取（或建）HC 客户端。返回 null = 本机不具备 HC 运行条件。
     * 🔴 必须先过 getSdkStatus 再 getOrCreate：SDK 不可用时 getOrCreate 可能抛异常。
     */
    private fun client(context: Context): HealthConnectClient? {
        cachedClient?.let { return it }
        return synchronized(this) {
            cachedClient ?: try {
                HealthConnectClient.getOrCreate(context.applicationContext).also {
                    cachedClient = it
                }
            } catch (e: Throwable) {
                // 🔴 Throwable 而非 Exception：getOrCreate 在 14+ 走 framework 路径，
                //    ROM 差异抛的是 Error（NoClassDefFoundError 等），Exception 抓不住。
                Log.w(TAG, "getOrCreate failed: ${e.javaClass.simpleName}")
                null
            }
        }
    }

    /** SDK 状态：1=不可用 2=provider 需更新 3=可用（常量值已 javap 实证） */
    private fun sdkStatus(context: Context): Int = try {
        HealthConnectClient.getSdkStatus(context)
    } catch (e: Throwable) {
        // 🔴 Throwable：同上，且这里是**第一道**触碰 HC SDK 的调用 ——
        //    若它抛 Error 而没被抓住，用户「点连接」的瞬间就闪退。
        Log.w(TAG, "getSdkStatus failed: ${e.javaClass.simpleName}")
        HealthConnectClient.SDK_UNAVAILABLE
    }

    private fun sdkStatusLabel(status: Int): String = when (status) {
        HealthConnectClient.SDK_AVAILABLE -> "available"
        HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "provider_update_required"
        else -> "unavailable"
    }

    /**
     * HC 入口是否可解析（用于 HC-0 诊断）。
     * 🔴 不靠写死包名判断：Android 14+ 的 HC provider 是**系统内置**的，包名不是
     *    `com.google.android.apps.healthdata`；自己查包会在 14+ 上误判为「未安装」。
     *    改为问系统「谁能处理 HC 设置页 Intent」，跨版本都可靠。
     */
    private fun hcSettingsResolvable(context: Context): Boolean = try {
        // 🔴 Kotlin 侧真名是大写常量 `ACTION_HEALTH_CONNECT_SETTINGS`（编译器裁决：
        //    getter 形式 getHealthConnectSettingsAction() 与 camelCase 属性名都 Unresolved）。
        //    同样是 @JvmName 改名：JVM 名 = getHealthConnectSettingsAction()，
        //    值 = androidx.health.ACTION_HEALTH_CONNECT_SETTINGS（AAR 常量池实证）。
        val intent = Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)
        context.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) != null
    } catch (e: Exception) {
        false
    }

    /**
     * 同步探测 HC 是否可用（供 `healthConnectStatus`）。
     *
     * 返回字段刻意做成「HC-0 真机覆盖率矩阵」的原始素材：用户在华为/小米上各跑一次，
     * 把这串贴回来即可判定该机型能否走 HC，无需连 adb 看 logcat。
     * 🔴 不含任何健康数值（敏感个人信息不落日志、不进非必要字段）。
     */
    @JvmStatic
    fun checkAvailability(context: Context, callback: ResultCallback) {
        val app = context.applicationContext
        // 🔴 必须挂 CoroutineExceptionHandler：Dispatchers.IO 上的协程若抛出**未捕获**异常，
        //    会直达线程的默认 uncaughtExceptionHandler → **整个进程崩溃**（用户看到闪退）。
        //    这里兜底成「如实上报 error 状态」，绝不让 HC 的任何问题连累 App 存活。
        val scope = CoroutineScope(Dispatchers.IO + crashGuard(callback, "checkAvailability"))
        scope.launch {
            // 🔴 整体包 Throwable：Android 14+ 的 HC 走 framework 路径
            //    （HealthConnectClientUpsideDownImpl → android.health.connect.HealthConnectManager），
            //    厂商 ROM（小米 HyperOS 等）与 AOSP 有差异时抛的是 **Error**
            //    （NoSuchMethodError / NoClassDefFoundError / AbstractMethodError），
            //    `catch (Exception)` 抓不住 → 逃逸 → 闪退。必须用 Throwable。
            try {
                val out = HashMap<String, Any?>()
                // 🔴 sdkStatus/client 全部走超时保护版：getSdkStatus 是链路第一道跨进程调用，
                //   挂住会让 callback 永不触发 → 前端 hcReady 不翻转 → 连按钮都出不来。
                val status = sdkStatusWithTimeout("probe_sdk_status", app)
                val available = status == HealthConnectClient.SDK_AVAILABLE
                out["available"] = available
                out["sdkStatus"] = status
                out["sdkStatusLabel"] = sdkStatusLabel(status)
                out["androidApi"] = Build.VERSION.SDK_INT
                out["manufacturer"] = Build.MANUFACTURER
                out["brand"] = Build.BRAND
                out["model"] = Build.MODEL
                out["hcSettingsResolvable"] = hcSettingsResolvable(app)

                if (available) {
                    val c = clientWithTimeout("probe_client_create", app)
                    if (c == null) {
                        // SDK 报可用但建不起连接 → 如实降级为不可用（不假装成功）
                        out["available"] = false
                        out["reason"] = "client_create_failed"
                    } else {
                        try {
                            // 🔴 套分段超时：getGrantedPermissions 与 aggregate 同为跨进程调用，
                            //    在厂商 ROM 上同样可能挂住。probe 挂起会让 hcReady 永不翻转 →
                            //    UI 连「连接系统健康」按钮都出不来（比读数挂起更难排查）。
                            val granted = withStageTimeout("probe_permission_query") {
                                c.permissionController.getGrantedPermissions()
                            }
                            val want = READ_PERMISSIONS
                            out["grantedCount"] = granted.count { it in want }
                            out["grantedSteps"] = granted.contains(HealthPermission.getReadPermission(StepsRecord::class))
                            out["grantedActiveCalories"] = granted.contains(HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class))
                            out["grantedDistance"] = granted.contains(HealthPermission.getReadPermission(DistanceRecord::class))
                        } catch (e: HcTimeoutException) {
                            // probe 超时 ≠ 设备不支持 HC：available 保持 true（SDK 已确认可用），
                            // 只标记 reason，让前端/真机排查知道是「权限查询卡住」而非「无 HC」。
                            Log.w(TAG, "checkAvailability timeout at ${e.stage}")
                            out["reason"] = "timeout:${e.stage}"
                        } catch (e: Throwable) {
                            out["reason"] = "permission_query_failed:${e.javaClass.simpleName}"
                        }
                    }
                } else {
                    out["reason"] = sdkStatusLabel(status)
                }

                withContext(Dispatchers.Main) { callback.onResult(out) }
            } catch (t: Throwable) {
                // 整体兜底：把任何 Throwable 如实转成 error 状态回前端，进程存活
                Log.w(TAG, "checkAvailability failed: ${t.javaClass.simpleName}")
                val out = HashMap<String, Any?>()
                out["available"] = false
                out["reason"] = "probe_error:${t.javaClass.simpleName}"
                // 🔴 Kotlin 里没有 String.valueOf（那是 Java 的写法）：t.message 已是 String?
                out["message"] = t.message ?: t.javaClass.simpleName
                withContext(Dispatchers.Main) { callback.onResult(out) }
            }
        }
    }

    /**
     * 协程进程级崩溃兜底：任何逃逸到协程作用域的 Throwable 都在这里被吞掉并如实回调，
     * 而不是触发默认 uncaughtExceptionHandler 让 App 闪退。
     * 🔴 这是「零假功能 + 零闪退」的最后一道闸：HC 出问题最多让健康数据不可用，
     *    绝不能连累整个 App（用户正在打卡、记体重）。
     */
    private fun crashGuard(callback: ResultCallback, where: String) = CoroutineExceptionHandler { _, t ->
        Log.w(TAG, "$where uncaught: ${t.javaClass.name}: ${t.message}")
        val out = HashMap<String, Any?>()
        out["available"] = false
        out["status"] = "error"
        out["steps"] = 0
        out["activeKcal"] = 0
        out["reason"] = "crash_guarded:${t.javaClass.simpleName}"
        out["message"] = "Health Connect 在本机异常（${t.javaClass.simpleName}），已降级为手动记录"
        try {
            callback.onResult(out)
        } catch (ignore: Throwable) {
            // 回调本身再失败也不能崩：静默吞掉，进程存活优先
        }
    }

    /**
     * 构造 HC 授权 Intent（Java 侧交给 Capacitor `startActivityForResult`）。
     * 返回 null = 本机不可用，调用方应直接降级。
     *
     * 🔴 **不得在主线程调用**：内含 `sdkStatus()` 与 `client()` 两个跨进程阻塞调用。
     *   Java 侧 `requestHealthConnectAuthorization` 原先直接在插件方法里同步调它 ——
     *   而 Capacitor 的 @PluginMethod **跑在主线程**，阻塞调用一旦挂住就是 ANR
     *   （「点连接 → 界面无响应 → 系统弹『应用无响应』」）。
     *   请改用 [createPermissionIntentAsync]（后台执行 + 超时 + 回主线程回调）。
     */
    @JvmStatic
    fun createPermissionIntent(context: Context): Intent? {
        val app = context.applicationContext
        if (sdkStatus(app) != HealthConnectClient.SDK_AVAILABLE) return null
        // 建不起客户端就别拉起授权页（否则用户点完无反应，属假功能）
        client(app) ?: return null
        return buildPermissionIntent(app)
    }

    /**
     * 🔴 [createPermissionIntent] 的**非阻塞版**（唯一应被 Java 插件调用的入口）。
     *
     * 在 [Dispatchers.IO] 上做「查 SDK 状态 → 建客户端 → 造 Intent」，两步阻塞调用各自
     * 套 6s 超时；结果（Intent 或 null）切回**主线程**回调，供 Java 侧直接交给
     * `startActivityForResult`（Activity 启动必须在主线程）。
     *
     * 为什么必须异步：主线程阻塞 = ANR。为什么必须回主线程：`startActivityForResult`
     * 与 Capacitor 的 call 生命周期都要求在主线程操作。
     *
     * 失败一律回调 null（调用方降级为「本机不支持」提示），**绝不抛异常**、
     * 绝不静默不回调（不回调 = 前端 Promise 永驻，正是本次要根治的病）。
     */
    @JvmStatic
    fun createPermissionIntentAsync(context: Context, callback: IntentCallback) {
        val app = context.applicationContext
        val scope = CoroutineScope(Dispatchers.IO + CoroutineExceptionHandler { _, t ->
            // 🔴 进程级兜底：协程内任何未捕获 Throwable 都在这里吞掉并回调 null，
            //   而不是逃逸到默认 handler 让 App 闪退（用户正在打卡，不能被 HC 连累）。
            Log.w(TAG, "createPermissionIntentAsync uncaught: ${t.javaClass.simpleName}")
            deliverIntent(callback, null)
        })
        scope.launch {
            val intent = try {
                if (sdkStatusWithTimeout("intent_sdk_status", app) != HealthConnectClient.SDK_AVAILABLE) {
                    null
                } else if (clientWithTimeout("intent_client_create", app) == null) {
                    null
                } else {
                    buildPermissionIntent(app)
                }
            } catch (e: HcTimeoutException) {
                // 🔴 超时如实带上 stage：这是真机排查的唯一线索（没有 adb 时靠这句话定位）
                Log.w(TAG, "createPermissionIntentAsync timeout at ${e.stage}")
                null
            } catch (t: Throwable) {
                Log.w(TAG, "createPermissionIntentAsync failed: ${t.javaClass.simpleName}")
                null
            }
            withContext(Dispatchers.Main) {
                try {
                    callback.onResult(intent)
                } catch (ignore: Throwable) {
                    // 回调本身失败也不能崩：进程存活优先
                }
            }
        }
    }

    /** 主线程投递 Intent 结果（回调可能从多处触发，收口成一个函数防漏） */
    private fun deliverIntent(callback: IntentCallback, intent: Intent?) {
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        handler.post {
            try {
                callback.onResult(intent)
            } catch (ignore: Throwable) {
                // 静默吞掉，进程存活优先
            }
        }
    }

    /** Intent 回调（Java 侧看到的是 `Intent?`） */
    fun interface IntentCallback {
        fun onResult(intent: Intent?)
    }

    /** 真正造 Intent 的部分（不含阻塞调用，可在任意线程执行） */
    private fun buildPermissionIntent(app: Context): Intent? = try {
        // 🔴 必须用**无参重载**：1.1.0 里 HEALTH_CONNECT_CLIENT_TAG 是 internal，
        //    宿主模块无法访问（编译器已裁决 "it is internal in ...Companion"）。
        //    无参重载内部自带默认 tag，行为等价。
        val contract = PermissionController.createRequestPermissionResultContract()
        contract.createIntent(app, READ_PERMISSIONS)
    } catch (e: Throwable) {
        Log.w(TAG, "buildPermissionIntent failed: ${e.javaClass.simpleName}")
        null
    }

    /**
     * 解析授权 Activity 的结果，返回**实际被授予**的读权限集合。
     * 🔴 HC 授权与 HealthKit 一样「用户可能全拒」，故以解析结果为准，不看 resultCode。
     */
    @JvmStatic
    fun parsePermissionResult(resultCode: Int, data: Intent?): Set<String> = try {
        // 🔴 同上：用无参重载（HEALTH_CONNECT_CLIENT_TAG 是 internal）。
        //    解析用的 contract 必须与 createIntent 用的同一个，否则 parseResult 拿不到结果。
        val contract = PermissionController.createRequestPermissionResultContract()
        contract.parseResult(resultCode, data)
    } catch (e: Exception) {
        Log.w(TAG, "parsePermissionResult failed: ${e.javaClass.simpleName}")
        emptySet()
    }

    /**
     * 🔴 单个 HC 调用的硬超时（6s）。为什么必须有：`getSdkStatus()` / `getOrCreate()` /
     * `getGrantedPermissions()` / `aggregate()` 都可能**跨进程阻塞**，厂商 ROM（小米
     * HyperOS 等）上可能永不返回。CoroutineExceptionHandler 只能兜「抛异常」，兜不住
     * 「一直挂起」→ 协程泄漏 + 前端 Promise 不 settle → UI 永停在「正在读取今天的步数」
     * （2026-11-18 小米 15 Ultra 实测）。
     *
     * 为什么**按调用**分段超时而不是整体一个：分段后 message 会指明卡在哪一步
     * （sdk_status / client_create / permission_query / aggregate），这是真机排查的唯一
     * 线索 —— 没有 adb 时，用户贴回的一句话就能区分是哪个子系统卡住。
     *
     * 6s < 前端 8s：让原生先给出带阶段的诚实结论，前端超时只是最后一道兜底。
     *
     * ⚠️ **诚实的能力边界**（不夸大修复效果）：`withTimeout` 依赖协程取消，而
     *   `getSdkStatus` / `getOrCreate` / `synchronized` 都是**不响应取消的阻塞调用**。
     *   超时后本函数会立即抛出、让 callback/前端拿到诚实结论，但底层那个阻塞调用
     *   仍会在原线程上跑完（`synchronized` 块内阻塞时锁也仍被持有，后续调用者会等锁）。
     *   这已是纯客户端侧能做到的上限 —— 关键收益是「不再永驻、不再 ANR」，
     *   而不是「真正杀掉了那个卡住的系统调用」。
     */
    private const val CALL_TIMEOUT_MS = 6_000L

    /**
     * 带阶段标签的超时包装。超时 → 抛 [HcTimeoutException]（含 stage），由调用方转成 error。
     * 🔴 TimeoutCancellationException 是 CancellationException 子类，会被宽泛 catch 误吞，
     *    故这里显式转成自定义异常，保证「超时」与「其它异常」在 message 里可区分。
     */
    private class HcTimeoutException(val stage: String) :
        Exception("HC call timeout after ${CALL_TIMEOUT_MS}ms at $stage")

    private suspend fun <T> withStageTimeout(stage: String, block: suspend () -> T): T = try {
        withTimeout(CALL_TIMEOUT_MS) { block() }
    } catch (e: TimeoutCancellationException) {
        throw HcTimeoutException(stage)
    }

    /**
     * 超时保护版 SDK 状态查询。
     * 🔴 为什么必须包：`getSdkStatus` 是 HC 链路的**第一道**调用，它挂住的话
     *   checkAvailability / fetchToday 的 callback 永不触发 → 前端 probe 不 settle →
     *   `hcReady` 永不翻转 → 连「连接」按钮都出不来（比读数挂起更难排查）。
     */
    private suspend fun sdkStatusWithTimeout(stage: String, context: Context): Int = try {
        withStageTimeout(stage) {
            // withContext(IO)：阻塞调用不能占着协程的调度线程
            withContext(Dispatchers.IO) { sdkStatus(context) }
        }
    } catch (e: HcTimeoutException) {
        Log.w(TAG, "sdkStatus timeout at ${e.stage}")
        throw e
    }

    /**
     * 超时保护版客户端创建。
     * 🔴 为什么必须包：`getOrCreate` 建立跨进程连接，是最可能挂住的一步；且它内部有
     *   `synchronized` 双检锁，挂住会**持锁**，连带其它调用者一起卡。
     */
    private suspend fun clientWithTimeout(stage: String, context: Context): HealthConnectClient? = try {
        withStageTimeout(stage) {
            withContext(Dispatchers.IO) { client(context) }
        }
    } catch (e: HcTimeoutException) {
        Log.w(TAG, "client create timeout at ${e.stage}")
        throw e
    }

    /**
     * 读当天步数 + 活动能量（`aggregate` 聚合读，自动多源去重）。
     *
     * @param wantDistance 是否一并读距离（诊断用；正式口径仍以步数/活动能量为主）
     */
    @JvmStatic
    @JvmOverloads
    fun fetchToday(context: Context, wantDistance: Boolean = false, callback: ResultCallback) {
        val app = context.applicationContext
        // 🔴 同 checkAvailability：挂 CoroutineExceptionHandler，绝不让协程内异常
        //    逃逸到默认 uncaughtExceptionHandler 而闪退整个 App。
        val scope = CoroutineScope(Dispatchers.IO + crashGuard(callback, "fetchToday"))
        scope.launch {
            val out = HashMap<String, Any?>()
            out["steps"] = 0
            out["activeKcal"] = 0

            // 🔴 sdkStatus / client 移进 try 块内（2026-11-18 复查发现的遗漏）：
            //   原先它们在 try 之外，且是**无超时保护**的阻塞调用 —— 挂住时既不抛异常
            //   （CoroutineExceptionHandler 兜不住「一直挂起」）也不走到 catch，
            //   callback 永不触发 → 前端 Promise 不 settle → UI 永驻「正在读取」。
            //   现改用超时保护版并纳入 try，超时会上报带 stage 标签的 error。
            try {
                val status = sdkStatusWithTimeout("sdk_status", app)
                if (status != HealthConnectClient.SDK_AVAILABLE) {
                    // 🔴 设备没有 HC / provider 需更新 → unavailable，**不是** 0 步
                    out["status"] = "unavailable"
                    out["message"] = "Health Connect ${sdkStatusLabel(status)}（SDK status=$status, API=${Build.VERSION.SDK_INT}）"
                    withContext(Dispatchers.Main) { callback.onResult(out) }
                    return@launch
                }

                val c = clientWithTimeout("client_create", app)
                if (c == null) {
                    out["status"] = "unavailable"
                    out["message"] = "Health Connect 客户端创建失败"
                    withContext(Dispatchers.Main) { callback.onResult(out) }
                    return@launch
                }

                // 每次读前复查授权：用户可能刚在 HC 应用里撤销
                // 🔴 套分段超时：这一步就可能在厂商 ROM 上挂住（见 CALL_TIMEOUT_MS）
                val granted = withStageTimeout("permission_query") {
                    c.permissionController.getGrantedPermissions()
                }
                val canSteps = granted.contains(HealthPermission.getReadPermission(StepsRecord::class))
                val canKcal = granted.contains(HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class))
                if (!canSteps && !canKcal) {
                    out["status"] = "denied"
                    out["message"] = "未授予 Health Connect 读取权限（步数与活动能量均未勾选）"
                    withContext(Dispatchers.Main) { callback.onResult(out) }
                    return@launch
                }

                // 🔴 铁律 3：设备本地时区当天零点 → 次日零点（不用 UTC）
                val today = LocalDate.now()
                val range = TimeRangeFilter.between(
                    today.atStartOfDay(),
                    today.plusDays(1).atStartOfDay(),
                )

                // 🔴 铁律 1+2：aggregate 聚合读（自动多源去重），dataOriginFilter 传**空集**
                val metrics = buildSet {
                    if (canSteps) add(StepsRecord.COUNT_TOTAL)
                    if (canKcal) add(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL)
                    if (wantDistance && granted.contains(HealthPermission.getReadPermission(DistanceRecord::class))) {
                        add(DistanceRecord.DISTANCE_TOTAL)
                    }
                }
                // 🔴 同样套分段超时：aggregate 是最可能挂起的一步（跨进程 + 多源聚合）
                val result = withStageTimeout("aggregate") {
                    c.aggregate(AggregateRequest(metrics, range, emptySet()))
                }

                val steps = result.get(StepsRecord.COUNT_TOTAL)
                val kcal = result.get(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL)

                if (steps != null) out["steps"] = steps
                // 🔴 activeKcal 是否含 BMR 须真机与厂商 App 对照（计划文档 §4 P2）；
                //    此处如实回传 HC 原值，并同时给出「有无样本」标记供对照判断。
                // 🔴 单位属性名是 `inKilocalories` 不是 `kilocalories`（编译器裁决 + javap -v 实证）：
                //    Kotlin 属性真名 = inKilocalories，被 @JvmName 改名为 getKilocalories()。
                //    所以 javap 只看得到 getter、Kotlin 却必须用属性名 —— 反编译结论会骗人，
                //    凡 Kotlin 侧 API 一律再过一遍编译器（Length.meters 同理 → inMeters）。
                if (kcal != null) out["activeKcal"] = kcal.inKilocalories

                // aggregate 返回 null = 该指标今天没有样本（≠ 0 步）
                out["hasStepsSample"] = steps != null
                out["hasKcalSample"] = kcal != null
                out["grantedSteps"] = canSteps
                out["grantedActiveCalories"] = canKcal
                out["partialPermission"] = canSteps != canKcal

                if (wantDistance) {
                    // 同上：Length 的 Kotlin 属性名是 inMeters（JVM 名才是 getMeters）
                    result.get(DistanceRecord.DISTANCE_TOTAL)?.let { out["distanceMeters"] = it.inMeters }
                }

                out["status"] = if (steps == null && kcal == null) "empty" else "ok"
                Log.d(TAG, "fetchToday: status=${out["status"]} partial=${out["partialPermission"]}")
            } catch (e: HcTimeoutException) {
                // 🔴 放在 SecurityException 之前：超时是最需要如实上报的一类（真机排查线索）
                Log.w(TAG, "fetchToday timeout at ${e.stage}")
                out["status"] = "error"
                out["reason"] = "timeout:${e.stage}"
                out["message"] = "Health Connect 读数超时（卡在 ${e.stage}，${CALL_TIMEOUT_MS / 1000}s 未响应）"
            } catch (e: SecurityException) {
                out["status"] = "denied"
                out["message"] = "Health Connect 权限不足：${e.message}"
            } catch (e: Exception) {
                out["status"] = "error"
                out["message"] = "${e.javaClass.simpleName}: ${e.message}"
            } catch (t: Throwable) {
                // 🔴 必须放在 Exception 之后：Android 14+ 走 framework 路径
                //    （HealthConnectClientUpsideDownImpl → android.health.connect.HealthConnectManager），
                //    厂商 ROM 差异抛的是 **Error**（NoSuchMethodError / NoClassDefFoundError /
                //    AbstractMethodError），上面的 catch(Exception) 抓不住 → 逃逸 → 闪退。
                Log.w(TAG, "fetchToday failed: ${t.javaClass.name}: ${t.message}")
                out["status"] = "error"
                out["message"] = "${t.javaClass.simpleName}: ${t.message}"
            }

            withContext(Dispatchers.Main) { callback.onResult(out) }
        }
    }
}
