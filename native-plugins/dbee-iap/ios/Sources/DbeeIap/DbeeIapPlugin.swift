import Foundation
import Capacitor
import StoreKit

/**
 * DbeeIap —— D-Bee 原生 StoreKit 2 内购插件（iOS-only）。
 *
 * 交易纪律：购买成功后绝不立即 finish。客户端先把 transactionId + 收据交给
 * 服务端幂等核销，核销成功后才调用 finishTransaction。否则断网时会同时丢掉
 * 权益与 Transaction.unfinished 的恢复入口。
 *
 * 本插件负责商店商品、StoreKit 交易和交易生命周期；权益落库仍由服务端负责。
 */
@objc(DbeeIapPlugin)
public class DbeeIapPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DbeeIapPlugin"
    public let jsName = "DbeeIap"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getUnfinished", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishTransaction", returnType: CAPPluginReturnPromise)
    ]

    private var transactionUpdatesTask: Task<Void, Never>?

    override public func load() {
        super.load()
        // 覆盖 App 被杀后的补单、Ask to Buy 批准、续订等非当前页面发起的交易。
        transactionUpdatesTask = Task { [weak self] in
            for await result in Transaction.updates {
                guard let self else { return }
                do {
                    let transaction = try self.checkVerified(result)
                    await self.handleTransactionUpdate(transaction)
                } catch {
                    NSLog("DbeeIap: ignored unverified transaction update: \(error.localizedDescription)")
                }
            }
        }
    }

    deinit {
        transactionUpdatesTask?.cancel()
    }

    @objc func getProducts(_ call: CAPPluginCall) {
        guard let ids = call.getArray("productIds") as? [String], !ids.isEmpty else {
            call.reject("DbeeIap.getProducts: productIds is required", "INVALID_PRODUCT_IDS")
            return
        }

        Task {
            do {
                let products = try await Product.products(for: Set(ids))
                let result = products.map { p in
                    [
                        "productId": p.id,
                        "title": p.displayName,
                        "description": p.description,
                        "price": p.displayPrice
                    ]
                }
                call.resolve(["products": result])
            } catch {
                call.reject("DbeeIap.getProducts failed: \(error.localizedDescription)", "PRODUCTS_FAILED")
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId"), !productId.isEmpty else {
            call.reject("DbeeIap.purchase: productId is required", "INVALID_PRODUCT_ID")
            return
        }

        Task {
            do {
                let products = try await Product.products(for: [productId])
                guard let product = products.first else {
                    call.reject("DbeeIap.purchase: product not found", "PRODUCT_NOT_FOUND")
                    return
                }
                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    let transaction = try checkVerified(verification)
                    if transaction.revocationDate != nil {
                        // 已退款交易绝不是新购，不送核销，避免退款后被客户端重新发权益。
                        await transaction.finish()
                        call.reject("DbeeIap.purchase: transaction was revoked", "TRANSACTION_REVOKED")
                        return
                    }
                    // 不 finish：等 TS 层确认服务端已发权益后调用 finishTransaction。
                    call.resolve(transactionPayload(transaction))
                case .userCancelled:
                    call.reject("DbeeIap.purchase cancelled", "USER_CANCELLED")
                case .pending:
                    // Ask to Buy / 家长批准等场景尚无交易号，不能核销。
                    call.resolve(["status": "pending", "productId": productId])
                @unknown default:
                    call.reject("DbeeIap.purchase unknown result", "PURCHASE_UNKNOWN")
                }
            } catch {
                call.reject("DbeeIap.purchase failed: \(error.localizedDescription)", "PURCHASE_FAILED")
            }
        }
    }

    /// 当前有效权益，用于用户主动「恢复购买」。
    @objc func restore(_ call: CAPPluginCall) {
        Task {
            var transactions: [[String: String]] = []
            for await result in Transaction.currentEntitlements {
                do {
                    let transaction = try checkVerified(result)
                    if transaction.revocationDate == nil {
                        transactions.append(transactionPayload(transaction))
                    }
                } catch {
                    NSLog("DbeeIap.restore: skipped unverified transaction: \(error.localizedDescription)")
                }
            }
            call.resolve(["transactions": transactions])
        }
    }

    /// App 启动时恢复所有已扣款但尚未 finish 的交易。
    @objc func getUnfinished(_ call: CAPPluginCall) {
        Task {
            var transactions: [[String: String]] = []
            for await result in Transaction.unfinished {
                do {
                    let transaction = try checkVerified(result)
                    if transaction.revocationDate != nil {
                        // 退款/撤销更新也可能进入 unfinished；只 finish，绝不重新核销。
                        await transaction.finish()
                    } else {
                        transactions.append(transactionPayload(transaction))
                    }
                } catch {
                    NSLog("DbeeIap.getUnfinished: skipped unverified transaction: \(error.localizedDescription)")
                }
            }
            call.resolve(["transactions": transactions])
        }
    }

    /// 只完成经 StoreKit 验证且仍在 unfinished 序列中的指定交易。
    @objc func finishTransaction(_ call: CAPPluginCall) {
        guard let id = call.getString("transactionId"), let transactionId = UInt64(id) else {
            call.reject("DbeeIap.finishTransaction: valid transactionId is required", "INVALID_TRANSACTION_ID")
            return
        }

        Task {
            for await result in Transaction.unfinished {
                guard let transaction = try? checkVerified(result), transaction.id == transactionId else {
                    continue
                }
                await transaction.finish()
                call.resolve(["finished": true, "transactionId": id])
                return
            }
            // 不在 unfinished 中通常表示上次 finish 已成功；核销重试应保持幂等。
            call.resolve(["finished": false, "alreadyFinished": true, "transactionId": id])
        }
    }

    /// 后台更新中的退款交易直接 finish；只有未撤销交易才能进入 JS 核销闭环。
    private func handleTransactionUpdate(_ transaction: Transaction) async {
        if transaction.revocationDate != nil {
            await transaction.finish()
            NSLog("DbeeIap: finished revoked transaction \(transaction.id) without settlement")
            return
        }
        notifyListeners("transactionUpdated", data: transactionPayload(transaction))
    }

    private func transactionPayload(_ transaction: Transaction) -> [String: String] {
        return [
            "status": "purchased",
            "transactionId": String(transaction.id),
            "receipt": loadReceiptBase64(),
            "productId": transaction.productID
        ]
    }

    /// 校验 StoreKit 2 交易，失败抛错。
    private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .unverified(_, let error):
            throw error
        case .verified(let signed):
            return signed
        }
    }

    /// 读取当前 App Store 收据并转 base64（供服务端 verifyReceipt）。
    private func loadReceiptBase64() -> String {
        guard let url = Bundle.main.appStoreReceiptURL,
              let data = try? Data(contentsOf: url) else {
            return ""
        }
        return data.base64EncodedString()
    }
}
