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
    private static final int READ_TIMEOUT_MS = 60_000;

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

                    JSObject result = new JSObject();
                    result.put("status", status);
                    result.put("statusText", statusText == null ? "" : statusText);
                    result.put("headers", responseHeaders);
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
