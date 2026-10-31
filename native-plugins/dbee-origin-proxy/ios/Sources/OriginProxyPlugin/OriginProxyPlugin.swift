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
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestStream", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    /// 在途流式请求注册表：streamId → 可取消句柄。
    /// JS 侧 fetch 带 AbortSignal 时，signal.aborted 会调 cancel(streamId) 找到对应 task 终止。
    /// 锁保护：Capacitor 的 JS 调用在主线程，URLSession 回调在其它线程，
    /// 注册/移除可能并发，用 NSLock 而不是依赖单线程假设。
    private var activeStreams: [String: URLSessionTask] = [:]
    private let streamLock = NSLock()

    /// 取消在途流式请求。已结束的 streamId 视为成功（幂等）。
    @objc func cancel(_ call: CAPPluginCall) {
        let streamId = call.getString("streamId") ?? ""
        guard !streamId.isEmpty else {
            call.reject("OriginProxy.cancel: streamId is required")
            return
        }
        streamLock.lock()
        let task = activeStreams.removeValue(forKey: streamId)
        streamLock.unlock()
        task?.cancel()
        call.resolve(["streamId": streamId, "cancelled": task != nil])
    }

    /// 应用创建时预留的发布域名 —— 必须与 Nginx 里那两行的值保持一致。
    /// 🔒 仅作 JS 层未显式传 origin 时的兜底（src/lib/originProxy.ts 恒传
    ///    CLOUD_ORIGIN，正常链路不走此默认值）。它只是过云端白名单的 header，
    ///    不决定流量去向：endpoint 由 cloudConfig.ts 钉死（native-release =
    ///    https://d-bee.cn 自托管，网关不校验来源，此头被忽略）。
    private static let defaultOrigin = "https://zilv-mifeng.app.workbuddy.host"

    private static let connectTimeout: TimeInterval = 15
    /// LLM 流式响应可达 120s（网关 llmTimeoutMs），加余量设 180s。
    /// 旧值 60s 导致「问问小蜜」教练问答必超时（iOS V1.7.0 用户实测复现）。
    private static let readTimeout: TimeInterval = 180

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

    /// 流式任务结束时由 delegate 回调，从注册表移除（避免 map 无限增长）
    fileprivate func unregisterStream(_ streamId: String) {
        streamLock.lock()
        activeStreams.removeValue(forKey: streamId)
        streamLock.unlock()
    }

    // MARK: - requestStream（LLM SSE 流式转发，2026-10-26 新增）

    /// 与 Android 侧 requestStream 行为逐条对齐（见 OriginProxyPlugin.java 同名方法注释）：
    /// - 2xx + text/event-stream → 先 resolve 头信息，随后逐块 notifyListeners
    ///   ("originProxyChunk")，正常结束 ("originProxyEnd")，中途异常 ("originProxyError")。
    /// - 其余 → 整体缓冲，resolve 时带 data 字段（Base64）。
    ///
    /// 背景：iOS V1.7.0「问问小蜜」实测 60s 报「网络超时」且无增量输出——
    /// 旧 `request` 用 dataTask 整体缓冲，长回答在 timeoutIntervalForResource
    /// 内到不了结尾。流式通道逐块到达，readTimeout 语义变为「块间空闲超时」。
    @objc func requestStream(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), !urlString.trimmingCharacters(in: .whitespaces).isEmpty else {
            call.reject("OriginProxy.requestStream: url is required")
            return
        }
        guard let url = URL(string: urlString) else {
            call.reject("OriginProxy.requestStream: invalid url \(urlString)")
            return
        }

        let method = normalizeMethod(call.getString("method"))
        let origin = nonEmpty(call.getString("origin"), fallback: OriginProxyPlugin.defaultOrigin)
        let referer = nonEmpty(call.getString("referer"), fallback: "\(origin)/")
        let bodyIsBase64 = (call.getString("bodyEncoding") ?? "text") == "base64"
        let streamId = nonEmpty(call.getString("streamId"), fallback: UUID().uuidString)

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
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.setValue(referer, forHTTPHeaderField: "Referer")

        if let body = call.getString("body") {
            request.httpBody = bodyIsBase64 ? (Data(base64Encoded: body) ?? Data()) : body.data(using: .utf8)
        }

        let sessionConfig = URLSessionConfiguration.ephemeral
        // 流式语义：request 超时 = 「块间空闲」超时；资源总时长放宽到 10 分钟，
        // 避免长回答被总时长掐死（网关侧 llmTimeoutMs=120s 先兜底）。
        sessionConfig.timeoutIntervalForRequest = OriginProxyPlugin.readTimeout
        sessionConfig.timeoutIntervalForResource = 600
        let delegate = StreamDelegate(plugin: self, call: call, streamId: streamId)
        let session = URLSession(configuration: sessionConfig, delegate: delegate, delegateQueue: nil)
        // URLSession 对 delegate 持强引用直至 invalidate；外部再存一份防提前释放
        delegate.retain(session: session)
        let task = session.dataTask(with: request)

        // 注册可取消句柄，供 JS 侧 AbortSignal → cancel(streamId) 终止长回答。
        // 先注册再 resume：否则极端情况下 delegate 已回调完成、注册却还没发生，
        // unregisterStream 找不到条目，map 里会留下一条永不释放的僵尸记录。
        streamLock.lock()
        activeStreams[streamId] = task
        streamLock.unlock()

        task.resume()
    }

    /// 流式转发的 delegate：头信息 → resolve；数据块 → 事件；结束/异常 → 事件。
    /// 线程安全：URLSession delegate 回调在串行队列上，天然不并发。
    private final class StreamDelegate: NSObject, URLSessionDataDelegate {
        private weak var plugin: OriginProxyPlugin?
        private let call: CAPPluginCall
        private let streamId: String
        private var headResolved = false
        private var buffered = Data()
        private var isSSE = false
        private var session: URLSession?

        init(plugin: OriginProxyPlugin, call: CAPPluginCall, streamId: String) {
            self.plugin = plugin
            self.call = call
            self.streamId = streamId
        }

        func retain(session: URLSession) {
            self.session = session
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            let contentType = (http?.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
            isSSE = status >= 200 && status < 300 && contentType.contains("text/event-stream")

            if isSSE {
                var headers: [String: String] = [:]
                for (key, value) in http?.allHeaderFields ?? [:] {
                    guard let name = key as? String else { continue }
                    if OriginProxyPlugin.skippedResponseHeaders.contains(name.lowercased()) { continue }
                    if let stringValue = value as? String {
                        headers[name] = stringValue
                    } else if let anyValue = value as? CustomStringConvertible {
                        headers[name] = anyValue.description
                    }
                }
                headResolved = true
                call.resolve([
                    "streamId": streamId,
                    "status": status,
                    "statusText": HTTPURLResponse.localizedString(forStatusCode: status),
                    "headers": headers,
                    "url": response.url?.absoluteString ?? ""
                ])
            }
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            if isSSE {
                // 逐块转发：JS 侧 originProxyChunk → ReadableStream → SDK iterSSEEvents
                plugin?.notifyListeners("originProxyChunk", data: [
                    "streamId": streamId,
                    "data": data.base64EncodedString()
                ])
            } else {
                buffered.append(data)
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            defer {
                // 无论成功/失败/取消，都要从插件注册表移除，否则 activeStreams 会持续增长
                self.plugin?.unregisterStream(streamId)
                self.session?.finishTasksAndInvalidate()
                self.session = nil
            }
            if let error = error {
                // 主动取消（JS 侧 AbortSignal → cancel）：对 JS 而言是正常终止，
                // 走 End 事件让 ReadableStream 自然 close，不要报成「网络错误」。
                let nsError = error as NSError
                if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
                    if headResolved {
                        plugin?.notifyListeners("originProxyEnd", data: ["streamId": streamId])
                    }
                    // 头还没 resolve 就取消：call 已被 JS 侧 abort 丢弃，这里不再 resolve/reject
                    return
                }
                if headResolved {
                    plugin?.notifyListeners("originProxyError", data: [
                        "streamId": streamId,
                        "message": error.localizedDescription
                    ])
                } else {
                    call.reject("OriginProxy.requestStream failed: \(error.localizedDescription)")
                }
                return
            }
            let http = task.response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            if !headResolved {
                // 非流式：整体缓冲回传（错误体必须完整，SDK httpError 要解析 JSON）
                var headers: [String: String] = [:]
                for (key, value) in http?.allHeaderFields ?? [:] {
                    guard let name = key as? String else { continue }
                    if OriginProxyPlugin.skippedResponseHeaders.contains(name.lowercased()) { continue }
                    if let stringValue = value as? String {
                        headers[name] = stringValue
                    } else if let anyValue = value as? CustomStringConvertible {
                        headers[name] = anyValue.description
                    }
                }
                call.resolve([
                    "streamId": streamId,
                    "status": status,
                    "statusText": http.map { HTTPURLResponse.localizedString(forStatusCode: $0.statusCode) } ?? "",
                    "headers": headers,
                    "data": buffered.base64EncodedString(),
                    "url": task.response?.url?.absoluteString ?? ""
                ])
                return
            }
            plugin?.notifyListeners("originProxyEnd", data: ["streamId": streamId])
        }
    }
}
