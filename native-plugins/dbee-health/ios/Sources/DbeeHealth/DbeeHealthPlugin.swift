import Foundation
import Capacitor
import HealthKit

/**
 * DbeeHealth —— D-Bee 原生 Apple HealthKit 插件（iOS-only）。
 *
 * 职责（与前端 src/lib/health/healthkit.ts 的鸭子类型探测接口逐条对齐）：
 *   1. requestAuthorization  发起授权流程（步数 + 活动能量），流程走完即 completed
 *   2. fetchToday            读当天步数 + 活动能量
 *
 * ⚠️ HealthKit 铁律：读授权状态不可探测。
 *   HKHealthStore.authorizationStatus(for:) 对「读取」类型恒返回 .notDetermined
 *   （苹果不向 App 暴露用户是否允许读取，只暴露写入授权）。因此本插件：
 *   - 不提供 authorizationStatus 查询（旧版实现误用它判断读授权，恒 false，
 *     导致「弹窗走完却报未授权、按钮再点无反应」——2026-10-18 修复）
 *   - 是否真有数据，以 fetchToday 返回值为准；连接状态由前端存云端
 *     （profiles.health_connected），用户可随时在「我的 > 健康数据源」重连/解除。
 *
 * ✅ 2026-11-15 用户确认已真机验证（授权 → 读步数 → 计入活动消耗链路）。
 *    原注释「尚未在 Mac 上编译验证」已过时，按 17:51 拍板更新；详见 docs/智能设备功能梳理-2026-11-15.md §0。
 */

@objc(DbeeHealthPlugin)
public class DbeeHealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DbeeHealthPlugin"
    public let jsName = "DbeeHealth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchToday", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchDeviceReadings", returnType: CAPPluginReturnPromise)
    ]

    private let healthStore = HKHealthStore()

    /// 要读取的数据类型（步数 / 活动能量）
    private var readTypes: Set<HKObjectType> {
        var set = Set<HKObjectType>()
        if let step = HKObjectType.quantityType(forIdentifier: .stepCount) { set.insert(step) }
        if let energy = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) { set.insert(energy) }
        if let weight = HKObjectType.quantityType(forIdentifier: .bodyMass) { set.insert(weight) }
        if let fat = HKObjectType.quantityType(forIdentifier: .bodyFatPercentage) { set.insert(fat) }
        if let glucose = HKObjectType.quantityType(forIdentifier: .bloodGlucose) { set.insert(glucose) }
        if let diet = HKObjectType.quantityType(forIdentifier: .dietaryEnergyConsumed) { set.insert(diet) }
        set.insert(HKObjectType.workoutType())
        return set
    }

    /// 是否可用：HealthKit 只在真实设备可用（模拟器/无健康数据的设备会不可用）
    private func isHealthAvailable() -> Bool {
        return HKHealthStore.isHealthDataAvailable()
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard isHealthAvailable() else {
            // 模拟器 / iPad 等无健康数据能力：给出明确 reason，前端不再显示「授权未完成」
            call.resolve(["completed": false, "reason": "unavailable"])
            return
        }

        let types = readTypes
        guard !types.isEmpty else {
            call.resolve(["completed": false, "reason": "no_types"])
            return
        }

        healthStore.requestAuthorization(toShare: nil, read: types) { success, error in
            if let error = error {
                // 系统层报错（如用户未设置密码）：如实透传给前端，不伪装成「用户拒绝」
                call.resolve([
                    "completed": false,
                    "reason": "system_error",
                    "message": error.localizedDescription
                ])
                return
            }
            // success 只表示「授权流程本身完成」（含用户在弹窗点了允许/取消/拒绝）。
            // 读授权不可探测，completed=true 表示流程走完，真实数据以 fetchToday 为准。
            call.resolve(["completed": success])
        }
    }

    @objc func fetchToday(_ call: CAPPluginCall) {
        guard isHealthAvailable() else {
            // 模拟器 / 无健康能力的设备：明确告知「不可用」，前端不再当「今天 0 步」处理
            call.resolve(["steps": 0, "activeKcal": 0, "status": "unavailable"])
            return
        }

        let now = Date()
        let calendar = Calendar.current
        let startOfDay = calendar.startOfDay(for: now)

        // 步数
        guard let stepType = HKObjectType.quantityType(forIdentifier: .stepCount),
              let energyType = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) else {
            call.resolve(["steps": 0, "activeKcal": 0, "status": "error", "message": "无法构造健康数据类型"])
            return
        }

        let predicate = HKQuery.predicateForSamples(withStart: startOfDay, end: now, options: .strictStartDate)

        // 用 DispatchGroup 并行查步数 + 活动能量
        let group = DispatchGroup()
        var totalSteps: Double = 0
        var totalKcal: Double = 0
        // 分别记录两类查询的错误：只在其中一个类型被拒绝时也要如实上报，
        // 而不是像旧实现那样把 error 丢掉、让前端看到「0 步」误以为用户没运动。
        var stepError: Error?
        var energyError: Error?

        group.enter()
        let stepQuery = HKStatisticsQuery(
            quantityType: stepType,
            quantitySamplePredicate: predicate,
            options: .cumulativeSum
        ) { _, stats, error in
            if let error = error {
                stepError = error
            } else if let sum = stats?.sumQuantity() {
                totalSteps = sum.doubleValue(for: HKUnit.count())
            }
            group.leave()
        }
        healthStore.execute(stepQuery)

        group.enter()
        let energyQuery = HKStatisticsQuery(
            quantityType: energyType,
            quantitySamplePredicate: predicate,
            options: .cumulativeSum
        ) { _, stats, error in
            if let error = error {
                energyError = error
            } else if let sum = stats?.sumQuantity() {
                totalKcal = sum.doubleValue(for: HKUnit.kilocalorie())
            }
            group.leave()
        }
        healthStore.execute(energyQuery)

        group.notify(queue: .main) {
            let steps = Int(totalSteps.rounded())
            let kcal = Int(totalKcal.rounded())

            // 状态判定（优先级从高到低）：
            //   denied      任一查询报授权被拒 → 前端引导去「设置 > 健康 > 数据访问权限」
            //   error       其它错误（数据库损坏 / 内部错误）→ 前端提示稍后重试，不显示为 0
            //   ok          真的读到了数据（steps 或 kcal > 0）
            //   empty       查询成功但今天没有样本。⚠️ 读授权不可探测，
            //               「用户没戴表」与「用户在系统里关了读取但查询未报错」
            //               在 HealthKit 层面无法区分，故用中性的 empty 而非 denied。
            if let denied = [stepError, energyError].compactMap({ $0 }).first(where: { Self.isAuthorizationDenied($0) }) {
                call.resolve([
                    "steps": steps,
                    "activeKcal": kcal,
                    "status": "denied",
                    "message": denied.localizedDescription
                ])
                return
            }
            if let err = stepError ?? energyError {
                call.resolve([
                    "steps": steps,
                    "activeKcal": kcal,
                    "status": "error",
                    "message": err.localizedDescription
                ])
                return
            }
            call.resolve([
                "steps": steps,
                "activeKcal": kcal,
                "status": (steps > 0 || kcal > 0) ? "ok" : "empty"
            ])
        }
    }

    /// 秤、跳绳、饮食能量、血糖的当天读数。没有样本就省略字段。
    @objc func fetchDeviceReadings(_ call: CAPPluginCall) {
        guard isHealthAvailable() else {
            call.resolve(["status": "unavailable"])
            return
        }
        let now = Date()
        let startOfDay = Calendar.current.startOfDay(for: now)
        let predicate = HKQuery.predicateForSamples(withStart: startOfDay, end: now, options: .strictStartDate)
        let group = DispatchGroup()
        var out: [String: Any] = [
            "status": "empty",
            "weightGranted": true,
            "ropeGranted": true,
            "nutritionGranted": true,
            "glucoseGranted": true
        ]

        func latest(_ id: HKQuantityTypeIdentifier, unit: HKUnit, key: String, scale: Double = 1) {
            guard let type = HKObjectType.quantityType(forIdentifier: id) else { return }
            group.enter()
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: 1, sortDescriptors: [sort]) { _, samples, error in
                if let error = error, Self.isAuthorizationDenied(error) {
                    if key == "weightKg" { out["weightGranted"] = false }
                    if key == "glucoseMmol" { out["glucoseGranted"] = false }
                } else if let qty = (samples?.first as? HKQuantitySample)?.quantity.doubleValue(for: unit) {
                    out[key] = (qty * scale * 10).rounded() / 10
                }
                group.leave()
            }
            healthStore.execute(query)
        }

        latest(.bodyMass, unit: .gramUnit(with: .kilo), key: "weightKg")
        latest(.bodyFatPercentage, unit: .percent(), key: "bodyFatPct", scale: 100)
        let glucoseUnit = HKUnit.moleUnit(with: .milli, molarMass: HKUnitMolarMassBloodGlucose).dividing(by: .liter())
        latest(.bloodGlucose, unit: glucoseUnit, key: "glucoseMmol")

        if let diet = HKObjectType.quantityType(forIdentifier: .dietaryEnergyConsumed) {
            group.enter()
            let query = HKStatisticsQuery(quantityType: diet, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, stats, error in
                if let error = error, Self.isAuthorizationDenied(error) {
                    out["nutritionGranted"] = false
                } else if let sum = stats?.sumQuantity()?.doubleValue(for: .kilocalorie()), sum > 0 {
                    out["nutritionKcal"] = (sum * 10).rounded() / 10
                }
                group.leave()
            }
            healthStore.execute(query)
        }

        group.enter()
        let workouts = HKSampleQuery(sampleType: .workoutType(), predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
            if let error = error, Self.isAuthorizationDenied(error) {
                out["ropeGranted"] = false
            } else {
                let ropes = (samples as? [HKWorkout])?.filter { $0.workoutActivityType == .jumpRope } ?? []
                let seconds = ropes.reduce(0.0) { $0 + max(0, $1.duration) }
                if seconds > 0 {
                    out["jumpCount"] = ropes.count
                    out["jumpMinutes"] = Int((seconds / 60.0).rounded(.up))
                }
            }
            group.leave()
        }
        healthStore.execute(workouts)

        group.notify(queue: .main) {
            let any = out["weightKg"] != nil || out["jumpCount"] != nil || out["nutritionKcal"] != nil || out["glucoseMmol"] != nil
            out["status"] = any ? "ok" : "empty"
            call.resolve(out)
        }
    }

    /// 是否为「读取授权被拒」类错误。
    /// HKError.errorAuthorizationDenied / errorNotAuthorized 才是明确的拒绝信号；
    /// errorAuthorizationNotDetermined 表示从未询问过，归为可引导重连而非拒绝。
    private static func isAuthorizationDenied(_ error: Error) -> Bool {
        let nsError = error as NSError
        guard nsError.domain == HKErrorDomain else { return false }
        return nsError.code == HKError.Code.errorAuthorizationDenied.rawValue
            || nsError.code == HKError.Code.errorAuthorizationNotDetermined.rawValue
    }
}
