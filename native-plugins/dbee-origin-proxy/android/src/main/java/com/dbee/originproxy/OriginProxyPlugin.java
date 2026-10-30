package com.dbee.originproxy;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * OriginProxy —— D-Bee 原生端「Origin 转发」插件（方案 B）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * WorkBuddy 云端按 **Origin 精确匹配** 校验客户端（设计文档 §5.2 / §7.3），
 * publishableKey 只标识应用、不带权限，安全性完全由来源匹配提供。
 *
 * Web 端能登录，靠的是本站 Nginx 反代里显式覆写的那两行：
 *     proxy_set_header Origin  "https://zilv-mifeng.app.workbuddy.host";
 *     proxy_set_header Referer "https://zilv-mifeng.app.workbuddy.host/";
 *
 * 原生端没有 Nginx：请求由 WebView 的 fetch 发出，被 CapacitorHttp 插件接管后
 * 在**原生层**直发云端，而原生 HTTP 栈不会自己加 Origin。更糟的是 —— `Origin`
 * 在浏览器里属于 forbidden header name，JS 侧就算手动塞进 Request 也会被过滤
 * （已在 logcat 实测证实）。这条死路正是本插件存在的全部理由：
 *
 *     把 Nginx 那两行，搬进 App。
 *
 * 业务请求经本插件转发后，云端看到的来源与 Web 端**完全一致**，因此
 * signup / signin / token 续期（refreshToken 句柄同样绑定 Origin）全部走通。
 *
 * ── 实现取舍 ────────────────────────────────────────────────────────────────
 * 1. 用 JDK 自带的 {@link HttpURLConnection}，不引 OkHttp —— 零新增依赖，
 *    也就不可能与 Capacitor 内部的 okhttp 传递依赖打架。
 * 2. 走云 SDK 官方的 `options.fetch` 注入点（见 src/cloud.ts），**不 patch
 *    window.fetch**，也不覆盖 CapacitorHttp 的补丁 —— 影响面只有云 SDK 自己的请求。
 * 3. 响应体用 Base64 回传，避免 charset / 二进制（storage 下载）两类问题；
 *    JS 侧再解回 Uint8Array 构造 Response。
 */
@CapacitorPlugin(name = "OriginProxy")
public class OriginProxyPlugin extends Plugin {

    /** 应用创建时预留的发布域名 —— 必须与 Nginx 里那两行的值保持一致 */
    private static final String DEFAULT_ORIGIN = "https://zilv-mifeng.app.workbuddy.host";

    private static final int CONNECT_TIMEOUT_MS = 15_000;
    /**
     * LLM 流式响应可达 120s（网关 llmTimeoutMs），加余量设 180s。
     * 旧值 60s 导致「问问小蜜」教练问答必超时（与 iOS 同病）。
     */
    private static final int READ_TIMEOUT_MS = 180_000;

    /**
     * 这些请求头由原生栈自己决定，透传反而会坏事：
     *  - accept-encoding：不设时 HttpURLConnection 会自动加 gzip 并**自动解压**；
     *    一旦显式设了，它就只解压不告知，body 会变成乱码
     *  - content-length / host：必须由 URL 与真实字节数决定
     *  - origin / referer：本插件的核心职责，一律由原生层强制覆盖，不接受 JS 传入
     */
    private static final Set<String> SKIPPED_REQUEST_HEADERS = new HashSet<>(Arrays.asList(
            "accept-encoding", "content-length", "host", "connection", "origin", "referer"
    ));

    /**
     * 响应里这些头不上报：内容编码已在原生层解除、长度已变化，
     * 透传给 JS 的 Response 只会造成 body 与元数据不一致。
     */
    private static final Set<String> SKIPPED_RESPONSE_HEADERS = new HashSet<>(Arrays.asList(
            "content-encoding", "content-length", "transfer-encoding"
    ));

    /** 插件方法不得阻塞主线程（Capacitor 的插件调用跑在 WebView 线程上） */
    private static final ExecutorService EXECUTOR = Executors.newCachedThreadPool();

    /**
     * 在途流式请求注册表：streamId → 连接句柄（JS 侧 AbortSignal → cancel(streamId) 用）。
     * 读循环每轮检查 cancelled 标记，配合 disconnect() 尽快中断阻塞的 read。
     * ConcurrentHashMap：EXECUTOR 多线程并发注册/移除，无需额外锁。
     */
    private final Map<String, StreamHandle> activeStreams = new ConcurrentHashMap<>();

    /** 一条在途流：连接句柄 + 取消标记（volatile 保证读循环立即可见） */
    private static final class StreamHandle {
        final HttpURLConnection conn;
        volatile boolean cancelled;

        StreamHandle(HttpURLConnection conn) {
            this.conn = conn;
        }
    }

    /**
     * 取消在途流式请求（与 iOS 侧 cancel 逐条对齐；幂等：未知 streamId 也 resolve）。
     */
    @PluginMethod
    public void cancel(final PluginCall call) {
        final String streamId = call.getString("streamId");
        if (streamId == null || streamId.trim().isEmpty()) {
            call.reject("OriginProxy.cancel: streamId is required");
            return;
        }
        StreamHandle handle = activeStreams.remove(streamId);
        if (handle != null) {
            handle.cancelled = true;
            // disconnect 会令阻塞中的 read/getResponseCode 抛异常，读循环随之退出
            try {
                handle.conn.disconnect();
            } catch (Exception ignored) {
                // 已断开的连接重复 disconnect 无副作用
            }
        }
        JSObject ret = new JSObject();
        ret.put("streamId", streamId);
        ret.put("cancelled", handle != null);
        call.resolve(ret);
    }

    @PluginMethod
    public void request(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("OriginProxy.request: url is required");
            return;
        }

        final String method = normalizeMethod(call.getString("method", "GET"));
        final String origin = nonEmpty(call.getString("origin"), DEFAULT_ORIGIN);
        final String referer = nonEmpty(call.getString("referer"), origin + "/");
        final JSObject headers = call.getObject("headers");
        final String body = call.getString("body");
        final boolean bodyIsBase64 = "base64".equals(call.getString("bodyEncoding", "text"));

        EXECUTOR.execute(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    // 诊断日志：只打方法/地址/来源，不含任何凭据头。
                    // 排查时用 adb logcat | grep d-bee-origin，可直接确认 Origin 是否随请求发出。
                    android.util.Log.d("d-bee-origin", method + " " + url + " Origin=" + origin);
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setRequestMethod(method);
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                    conn.setReadTimeout(READ_TIMEOUT_MS);
                    conn.setUseCaches(false);

                    if (headers != null) {
                        for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                            String name = it.next();
                            if (name == null || SKIPPED_REQUEST_HEADERS.contains(name.toLowerCase(Locale.ROOT))) {
                                continue;
                            }
                            String value = headers.optString(name, null);
                            if (value == null) continue;
                            conn.setRequestProperty(name, value);
                        }
                    }

                    // ★ 本插件存在的理由：强制注入来源，行为与 Nginx 反代一致
                    conn.setRequestProperty("Origin", origin);
                    conn.setRequestProperty("Referer", referer);

                    if (body != null) {
                        byte[] payload = bodyIsBase64
                                ? Base64.decode(body, Base64.DEFAULT)
                                : body.getBytes(StandardCharsets.UTF_8);
                        conn.setDoOutput(true);
                        conn.setFixedLengthStreamingMode(payload.length);
                        OutputStream os = conn.getOutputStream();
                        try {
                            os.write(payload);
                        } finally {
                            os.close();
                        }
                    }

                    int status = conn.getResponseCode();
                    String statusText = conn.getResponseMessage();
                    InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    byte[] data = stream == null ? new byte[0] : readAll(stream);

                    JSObject result = new JSObject();
                    result.put("status", status);
                    result.put("statusText", statusText == null ? "" : statusText);
                    result.put("headers", buildHeaders(conn));
                    result.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
                    result.put("url", url);
                    call.resolve(result);
                } catch (Exception e) {
                    // 网络层失败（DNS / TLS / 超时）—— JS 侧会把它转成 fetch 语义的 TypeError
                    String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                    call.reject("OriginProxy.request failed: " + message);
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        });
    }

    /**
     * 流式转发（LLM SSE 专用，2026-10-26 新增）。
     *
     * 背景：`request` 整体缓冲响应体，LLM 长回答在 READ_TIMEOUT_MS 内到不了
     * 结尾 → iOS V1.7.0「问问小蜜」实测 60s 报「网络超时」，且全程无增量
     * 输出（无「思考链路」）。本方法把响应逐块经 Capacitor 事件通道回传：
     *   - 2xx + Content-Type: text/event-stream → 先 resolve 头信息
     *     {streamId,status,statusText,headers}，随后每收到一块就
     *     notifyListeners("originProxyChunk", {streamId,data:base64})，
     *     流正常结束 notifyListeners("originProxyEnd")，中途异常
     *     notifyListeners("originProxyError", {streamId,message})。
     *   - 其余（错误响应 / 非 SSE）→ 与 request 相同整体缓冲，resolve 时
     *     带 data 字段（SDK 的 httpError 需要完整 JSON 错误体）。
     *
     * JS 侧适配见 src/lib/originProxy.ts 的 nativeStreamFetch（事件泵进
     * ReadableStream；旧版 App 没有本方法时 PluginHeaders 探测不到，自动
     * 走缓冲 request，不会误调）。
     *
     * 注：HttpURLConnection.setReadTimeout 是「两次数据到达的间隔」超时，
     * SSE 逐块到达时间隔很小，长回答不再被总时长掐死。
     */
    @PluginMethod
    public void requestStream(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("OriginProxy.requestStream: url is required");
            return;
        }

        final String method = normalizeMethod(call.getString("method", "GET"));
        final String origin = nonEmpty(call.getString("origin"), DEFAULT_ORIGIN);
        final String referer = nonEmpty(call.getString("referer"), origin + "/");
        final JSObject headers = call.getObject("headers");
        final String body = call.getString("body");
        final boolean bodyIsBase64 = "base64".equals(call.getString("bodyEncoding", "text"));
        final String streamId = nonEmpty(call.getString("streamId"), "s" + System.nanoTime());

        EXECUTOR.execute(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                boolean headResolved = false;
                StreamHandle handle = null;
                try {
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setRequestMethod(method);
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                    conn.setReadTimeout(READ_TIMEOUT_MS);
                    conn.setUseCaches(false);

                    // 注册取消句柄：必须在发起请求前登记，否则 JS 侧提前 abort 时
                    // cancel(streamId) 找不到条目，请求会继续跑到超时
                    handle = new StreamHandle(conn);
                    activeStreams.put(streamId, handle);

                    if (headers != null) {
                        for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                            String name = it.next();
                            if (name == null || SKIPPED_REQUEST_HEADERS.contains(name.toLowerCase(Locale.ROOT))) {
                                continue;
                            }
                            String value = headers.optString(name, null);
                            if (value == null) continue;
                            conn.setRequestProperty(name, value);
                        }
                    }
                    conn.setRequestProperty("Origin", origin);
                    conn.setRequestProperty("Referer", referer);

                    if (body != null) {
                        byte[] payload = bodyIsBase64
                                ? Base64.decode(body, Base64.DEFAULT)
                                : body.getBytes(StandardCharsets.UTF_8);
                        conn.setDoOutput(true);
                        conn.setFixedLengthStreamingMode(payload.length);
                        OutputStream os = conn.getOutputStream();
                        try {
                            os.write(payload);
                        } finally {
                            os.close();
                        }
                    }

                    int status = conn.getResponseCode();
                    String statusText = conn.getResponseMessage();
                    String contentType = conn.getContentType() == null ? "" : conn.getContentType().toLowerCase(Locale.ROOT);
                    boolean sse = status >= 200 && status < 300 && contentType.contains("text/event-stream");
                    InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();

                    if (!sse) {
                        // 非流式：整体缓冲回传（错误体必须完整，SDK httpError 要解析 JSON）
                        byte[] data = stream == null ? new byte[0] : readAll(stream);
                        JSObject result = new JSObject();
                        result.put("streamId", streamId);
                        result.put("status", status);
                        result.put("statusText", statusText == null ? "" : statusText);
                        result.put("headers", buildHeaders(conn));
                        result.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
                        result.put("url", url);
                        headResolved = true;
                        call.resolve(result);
                        return;
                    }

                    // 流式：先回头信息（JS 侧据此构造 Response），再逐块事件回传
                    JSObject head = new JSObject();
                    head.put("streamId", streamId);
                    head.put("status", status);
                    head.put("statusText", statusText == null ? "" : statusText);
                    head.put("headers", buildHeaders(conn));
                    head.put("url", url);
                    headResolved = true;
                    call.resolve(head);

                    if (stream != null) {
                        try {
                            byte[] chunk = new byte[8192];
                            int read;
                            // 每轮检查取消标记：用户中断 LLM 回答时立即停止泵数据，
                            // 否则会持续 notifyListeners 把已废弃的块塞进已关闭的流
                            while (!handle.cancelled && (read = stream.read(chunk)) != -1) {
                                JSObject ev = new JSObject();
                                ev.put("streamId", streamId);
                                ev.put("data", Base64.encodeToString(Arrays.copyOf(chunk, read), Base64.NO_WRAP));
                                notifyListeners("originProxyChunk", ev);
                            }
                        } finally {
                            stream.close();
                        }
                    }
                    // 主动取消也走 End：对 JS 而言流是正常收尾（close），不是网络错误
                    JSObject end = new JSObject();
                    end.put("streamId", streamId);
                    notifyListeners("originProxyEnd", end);
                } catch (Exception e) {
                    if (handle != null && handle.cancelled) {
                        // 取消触发的 disconnect 会让 read/getResponseCode 抛异常，属预期路径
                        JSObject end = new JSObject();
                        end.put("streamId", streamId);
                        notifyListeners("originProxyEnd", end);
                    } else {
                        String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                        if (headResolved) {
                            // 头已回给 JS：错误走事件通道，让 ReadableStream 以 error 收尾
                            JSObject ev = new JSObject();
                            ev.put("streamId", streamId);
                            ev.put("message", message);
                            notifyListeners("originProxyError", ev);
                        } else {
                            call.reject("OriginProxy.requestStream failed: " + message);
                        }
                    }
                } finally {
                    // 必须移除注册表条目，否则 map 随请求次数无限增长
                    activeStreams.remove(streamId);
                    if (conn != null) conn.disconnect();
                }
            }
        });
    }

    /** 响应头 → JSObject（过滤原生栈已改写的编码/长度类头） */
    private static JSObject buildHeaders(HttpURLConnection conn) {
        JSObject responseHeaders = new JSObject();
        Map<String, List<String>> headerFields = conn.getHeaderFields();
        if (headerFields != null) {
            for (Map.Entry<String, List<String>> entry : headerFields.entrySet()) {
                String name = entry.getKey();
                if (name == null) continue; // 第一项是状态行
                if (SKIPPED_RESPONSE_HEADERS.contains(name.toLowerCase(Locale.ROOT))) continue;
                List<String> values = entry.getValue();
                if (values == null || values.isEmpty()) continue;
                responseHeaders.put(name, join(values));
            }
        }
        return responseHeaders;
    }

    /** 只允许 HttpURLConnection 认识的动词，避免运行时抛 ProtocolException */
    private static String normalizeMethod(String method) {
        String m = method == null ? "GET" : method.trim().toUpperCase(Locale.ROOT);
        switch (m) {
            case "GET":
            case "POST":
            case "PUT":
            case "PATCH":
            case "DELETE":
            case "HEAD":
            case "OPTIONS":
                return m;
            default:
                return "GET";
        }
    }

    private static String nonEmpty(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    private static String join(List<String> values) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append(values.get(i));
        }
        return sb.toString();
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        try {
            while ((read = in.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
        } finally {
            in.close();
        }
        return buffer.toByteArray();
    }
}
