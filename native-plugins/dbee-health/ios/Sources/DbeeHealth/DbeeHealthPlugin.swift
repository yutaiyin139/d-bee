import Foundation
import Capacitor
import HealthKit

/**
 * DbeeHealth —— D-Bee 原生 Apple HealthKit 插件（iOS-only）。
 *
 * 职责（与前端 src/lib/health/healthkit.ts 的鸭子类型探测接口逐条对齐）：
 *   1. requestAuthorization  请求读取权限（步数 + 活动能量 + 运动类型）
 *   2. authorizationStatus   查询当前授权状态
 *   3. fetchToday            读当天步数 + 活动能量
 *
 * 参考「自律茄子」的授权交互：点击连接 → 系统弹 HealthKit 权限 → 授权后自动同步。
 * 授权状态由前端存云端（profiles.health_connected），本插件只负责「弹授权 + 读数据」。
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
        CAPPluginMethod(name: "authorizationStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchToday", returnType: CAPPluginReturnPromise)
    ]

    private let healthStore = HKHealthStore()

    /// 要读取的数据类型（步数 / 活动能量 / 运动）
    private var readTypes: Set<HKObjectType> {
        var set = Set<HKObjectType>()
        if let step = HKObjectType.quantityType(forIdentifier: .stepCount) { set.insert(step) }
        if let energy = HKObjectType.quantityType(forIdentifier: .activeEnergyBurned) { set.insert(energy) }
        if let workout = HKObjectType.workoutType() as HKObjectType? { set.insert(workout) }
        return set
    }

    /// 是否可用：HealthKit 只在真实设备可用（模拟器/无健康数据的设备会不可用）
    private func isHealthAvailable() -> Bool {
        return HKHealthStore.isHealthDataAvailable()
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard isHealthAvailable() else {
            call.resolve(["authorized": false])
            return
        }

        let types = readTypes
        guard !types.isEmpty else {
            call.resolve(["authorized": false])
            return
        }

        healthStore.requestAuthorization(toShare: nil, read: types) { success, error in
            if let error = error {
                call.reject("DbeeHealth.requestAuthorization failed: \(error.localizedDescription)")
                return
            }
            // 授权成功与否按 success 返回；用户可能只勾选部分，但只要有读取权限即视为已连接
            call.resolve(["authorized": success])
        }
    }

    @objc func authorizationStatus(_ call: CAPPluginCall) {
        guard isHealthAvailable() else {
            call.resolve(["authorized": false])
            return
        }

        // 任一读取类型已授权即视为「已连接」
        var anyAuthorized = false
        for type in readTypes {
            let status = healthStore.authorizationStatus(for: type)
            if status == .sharingAuthorized {
                anyAuthorized = true
                break
            }
        }
        call.resolve(["authorized": anyAuthorized])
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
