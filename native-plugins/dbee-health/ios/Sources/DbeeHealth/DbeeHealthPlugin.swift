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
 * ⚠️ 本文件尚未在 Mac 上编译验证（当前开发机是 Windows）。
 *    首次在 Mac mini 构建后，请与 iOS 侧一起回归「授权 → 读步数 → 计入活动消耗」。
 */

@objc(DbeeHealthPlugin)
public class DbeeHealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DbeeHealthPlugin"
    public let jsName = "DbeeHealth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchToday", returnType: CAPPluginReturnPromise)
    ]

    private let healthStore = HKHealthStore()

    /// 要读取的数据类型（步数 / 活动能量）
    private var readTypes: Set<HKObjectType> {
        var set = Set<HKObjectType>()
        if let step = HKObjectType.quantityType(forIdentifier: .stepCount) { set.insert(step) }
        if let energy = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) { set.insert(energy) }
        return set
    }

    /// 是否可用：HealthKit 只在真实设备可用（模拟器/无健康数据的设备会不可用）
    private func isHealthAvailable() -> Bool {
        return HKHealthStore.isHealthDataAvailable()
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard isHealthAvailable() else {
            call.resolve(["completed": false])
            return
        }

        let types = readTypes
        guard !types.isEmpty else {
            call.resolve(["completed": false])
            return
        }

        healthStore.requestAuthorization(toShare: nil, read: types) { success, error in
            if let error = error {
                call.reject("DbeeHealth.requestAuthorization failed: \(error.localizedDescription)")
                return
            }
            // success 只表示「授权流程本身完成」（含用户在弹窗点了允许/取消/拒绝）。
            // 读授权不可探测，completed=true 表示流程走完，真实数据以 fetchToday 为准。
            call.resolve(["completed": success])
        }
    }

    @objc func fetchToday(_ call: CAPPluginCall) {
        guard isHealthAvailable() else {
            call.resolve(["steps": 0, "activeKcal": 0])
            return
        }

        let now = Date()
        let calendar = Calendar.current
        let startOfDay = calendar.startOfDay(for: now)

        // 步数
        guard let stepType = HKObjectType.quantityType(forIdentifier: .stepCount),
              let energyType = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) else {
            call.resolve(["steps": 0, "activeKcal": 0])
            return
        }

        let predicate = HKQuery.predicateForSamples(withStart: startOfDay, end: now, options: .strictStartDate)

        // 用 DispatchGroup 并行查步数 + 活动能量
        let group = DispatchGroup()
        var totalSteps: Double = 0
        var totalKcal: Double = 0

        group.enter()
        let stepQuery = HKStatisticsQuery(
            quantityType: stepType,
            quantitySamplePredicate: predicate,
            options: .cumulativeSum
        ) { _, stats, _ in
            if let sum = stats?.sumQuantity() {
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
        ) { _, stats, _ in
            if let sum = stats?.sumQuantity() {
                totalKcal = sum.doubleValue(for: HKUnit.kilocalorie())
            }
            group.leave()
        }
        healthStore.execute(energyQuery)

        group.notify(queue: .main) {
            call.resolve([
                "steps": Int(totalSteps.rounded()),
                "activeKcal": Int(totalKcal.rounded())
            ])
        }
    }
}
