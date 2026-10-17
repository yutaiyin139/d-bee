import Foundation
import Capacitor
import StoreKit

/**
 * DbeeIap —— D-Bee 原生 StoreKit 2 内购插件（iOS-only）。
 *
 * 职责（与前端 src/lib/payment/iosIap.ts 的鸭子类型探测接口逐条对齐）：
 *   1. getProducts  拉取商品（含本地化价格，供付费墙展示）
 *   2. purchase     发起购买，返回 transactionId + 收据 base64
 *   3. restore      恢复已购项目（订阅续期/换设备）
 *
 * 权益落库由服务端 verify_payment_order 完成（本插件只负责「发起支付 + 回传凭证」）。
 *
 * ⚠️ 本文件尚未在 Mac 上编译验证（当前开发机是 Windows）。
 *    首次在 Mac mini 构建后，请回归「拉商品 → 购买 → 回传凭证 → 服务端核销」全链路。
 */

@objc(DbeeIapPlugin)
public class DbeeIapPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DbeeIapPlugin"
    public let jsName = "DbeeIap"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise)
    ]

    @objc func getProducts(_ call: CAPPluginCall) {
        guard let ids = call.getArray("productIds") as? [String], !ids.isEmpty else {
            call.reject("DbeeIap.getProducts: productIds is required")
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
                call.reject("DbeeIap.getProducts failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId"), !productId.isEmpty else {
            call.reject("DbeeIap.purchase: productId is required")
            return
        }

        Task {
            do {
                let products = try await Product.products(for: [productId])
                guard let product = products.first else {
                    call.reject("DbeeIap.purchase: product not found")
                    return
                }
                let result = try await product.purchase()
                switch result {
                case .success(let verification):
                    let transaction = try checkVerified(verification)
                    await transaction.finish()
                    let receipt = loadReceiptBase64()
                    call.resolve([
                        "transactionId": String(transaction.id),
                        "receipt": receipt,
                        "productId": productId
                    ])
                case .userCancelled:
                    call.reject("DbeeIap.purchase cancelled")
                case .pending:
                    call.reject("DbeeIap.purchase pending")
                @unknown default:
                    call.reject("DbeeIap.purchase unknown result")
                }
            } catch {
                call.reject("DbeeIap.purchase failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func restore(_ call: CAPPluginCall) {
        Task {
            var transactions: [[String: String]] = []
            for await result in Transaction.currentEntitlements {
                do {
                    let transaction = try checkVerified(result)
                    transactions.append([
                        "transactionId": String(transaction.id),
                        "receipt": loadReceiptBase64(),
                        "productId": transaction.productID
                    ])
                } catch {
                    // 跳过无法验证的交易
                }
            }
            call.resolve(["transactions": transactions])
        }
    }

    /// 校验 StoreKit 2 交易，失败抛错
    private func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .unverified(_, let error):
            throw error
        case .verified(let signed):
            return signed
        }
    }

    /// 读取当前 App Store 收据并转 base64（供服务端 verifyReceipt）
    private func loadReceiptBase64() -> String {
        guard let url = Bundle.main.appStoreReceiptURL,
              let data = try? Data(contentsOf: url) else {
            return ""
        }
        return data.base64EncodedString()
    }
}
