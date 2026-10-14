import Foundation
import Capacitor

/**
 * OriginProxy —— D-Bee 原生端「Origin 转发」插件（方案 B，iOS 侧）。
 *
 * 与 Android 侧行为必须**逐条对齐**（见 android/.../OriginProxyPlugin.java 的注释：
 * 云端按 Origin 精确匹配校验客户端，Web 端靠 Nginx 覆写 Origin/Referer 过关，
 * 原生端没 Nginx，浏览器又禁止 JS 设置 Origin，只能由原生层代发）。
 *
 * iOS 侧的差异只有一处：URLSession 不像 WKWebView 那样做 forbidden header 过滤，
 * 可以直接 setValue(_:forHTTPHeaderField:)，因此实现比 Android 短。
 *
 * ⚠️ 本文件尚未在 Mac 上编译验证（当前开发机是 Windows）。
 *    首次在 Mac mini 上构建后，请与 Android 侧一起回归「登录 → 读数据 → 记一餐」。
 */
@objc(OriginProxyPlugin)
public class OriginProxyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OriginProxyPlugin"
    public let jsName = "OriginProxy"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise)
    ]

    /// 应用创建时预留的发布域名 —— 必须与 Nginx 里那两行的值保持一致
    private static let defaultOrigin = "https://zilv-mifeng.app.workbuddy.host"

    private static let connectTimeout: TimeInterval = 15
    private static let readTimeout: TimeInterval = 60

    /// 由原生栈决定的请求头，透传会坏事（原因同 Android 侧注释）
    private static let skippedRequestHeaders: Set<String> = [
        "accept-encoding", "content-length", "host", "connection", "origin", "referer"
    ]

    /// 已在原生层解除内容编码，长度亦已变化，透传只会让 body 与元数据不一致
    private static let skippedResponseHeaders: Set<String> = [
        "content-encoding", "content-length", "transfer-encoding"
    ]

    @objc func request(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), !urlString.trimmingCharacters(in: .whitespaces).isEmpty else {
            call.reject("OriginProxy.request: url is required")
            return
        }
        guard let url = URL(string: urlString) else {
            call.reject("OriginProxy.request: invalid url \(urlString)")
            return
        }

        let method = normalizeMethod(call.getString("method"))
        let origin = nonEmpty(call.getString("origin"), fallback: OriginProxyPlugin.defaultOrigin)
        let referer = nonEmpty(call.getString("referer"), fallback: "\(origin)/")
        let bodyIsBase64 = (call.getString("bodyEncoding") ?? "text") == "base64"

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = OriginProxyPlugin.readTimeout
        request.cachePolicy = .reloadIgnoringLocalCacheData

        if let headers = call.getObject("headers") {
            for (name, value) in headers {
                let lower = name.lowercased()
                if OriginProxyPlugin.skippedRequestHeaders.contains(lower) { continue }
                if let stringValue = value as? String {
                    request.setValue(stringValue, forHTTPHeaderField: name)
                } else if let anyValue = value as? CustomStringConvertible {
                    request.setValue(anyValue.description, forHTTPHeaderField: name)
                }
            }
        }

        // ★ 本插件存在的理由：强制注入来源，行为与 Nginx 反代一致
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.setValue(referer, forHTTPHeaderField: "Referer")

        if let body = call.getString("body") {
            if bodyIsBase64 {
                request.httpBody = Data(base64Encoded: body) ?? Data()
            } else {
                request.httpBody = body.data(using: .utf8)
            }
        }

        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.timeoutIntervalForRequest = OriginProxyPlugin.readTimeout
        sessionConfig.timeoutIntervalForResource = OriginProxyPlugin.readTimeout
        let session = URLSession(configuration: sessionConfig)

        let task = session.dataTask(with: request) { data, response, error in
            defer { session.finishTasksAndInvalidate() }

            if let error = error {
                // 网络层失败（DNS / TLS / 超时）—— JS 侧会把它转成 fetch 语义的 TypeError
                call.reject("OriginProxy.request failed: \(error.localizedDescription)")
                return
            }
            guard let http = response as? HTTPURLResponse else {
                call.reject("OriginProxy.request failed: no HTTP response")
                return
            }

            var responseHeaders: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                guard let name = key as? String else { continue }
                if OriginProxyPlugin.skippedResponseHeaders.contains(name.lowercased()) { continue }
                if let stringValue = value as? String {
                    responseHeaders[name] = stringValue
                } else if let anyValue = value as? CustomStringConvertible {
                    responseHeaders[name] = anyValue.description
                }
            }

            call.resolve([
                "status": http.statusCode,
                "statusText": HTTPURLResponse.localizedString(forStatusCode: http.statusCode),
                "headers": responseHeaders,
                "data": (data ?? Data()).base64EncodedString(),
                "url": urlString
            ])
        }
        task.resume()
    }

    private func normalizeMethod(_ method: String?) -> String {
        let upper = (method ?? "GET").trimmingCharacters(in: .whitespaces).uppercased()
        let allowed: Set<String> = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
        return allowed.contains(upper) ? upper : "GET"
    }

    private func nonEmpty(_ value: String?, fallback: String) -> String {
        guard let value = value, !value.trimmingCharacters(in: .whitespaces).isEmpty else { return fallback }
        return value
    }
}
