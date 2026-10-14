#!/usr/bin/env python
"""通过 Chrome DevTools Protocol 在原生 App 的 WebView 里执行 JS。

用途：模拟器/真机验收时，替代「盲点坐标 + 肉眼看截图」——
可以直接读写 DOM、触发 React 受控输入、把结构化结果取回来。
Capacitor 的 debug 包会开启 WebView 调试，因此无需额外配置。

用法：
    python tools/android-cdp.py targets                 # 列出可调试页面
    python tools/android-cdp.py eval "1+1"              # 执行 JS 并打印结果(JSON)
    python tools/android-cdp.py eval-file path.js       # 执行 JS 文件
    python tools/android-cdp.py snippet                 # 打印常用片段

前置：adb 已在 PATH，且 App 处于前台运行。
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

try:
    import websocket  # websocket-client
except ImportError:  # pragma: no cover
    sys.exit("缺少依赖：请先 pip install websocket-client")

ADB: str | None = None


def _adb_path() -> str:
    """优先用 PATH 里的 adb，否则退回本机 Android SDK 默认位置。"""
    for cand in (
        "adb",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk", "platform-tools", "adb.exe"),
        "C:/Users/yuty/AppData/Local/Android/Sdk/platform-tools/adb.exe",
    ):
        try:
            subprocess.run([cand, "version"], capture_output=True, check=True, timeout=15)
            return cand
        except Exception:  # noqa: BLE001
            continue
    sys.exit("未找到 adb")


def adb(*args: str, timeout: int = 60) -> str:
    global ADB
    if ADB is None:
        ADB = _adb_path()
    out = subprocess.run([ADB, *args], capture_output=True, timeout=timeout)
    return out.stdout.decode("utf-8", "replace").strip()


def find_app_pid(pkg: str = "com.dbee.app") -> int:
    pid = adb("shell", "pidof", pkg)
    if not pid:
        sys.exit(f"{pkg} 未在运行，请先启动 App")
    return int(pid.split()[0])


def ensure_forward(pid: int, port: int = 9222) -> None:
    adb("forward", f"tcp:{port}", f"localabstract:webview_devtools_remote_{pid}")


def list_targets(port: int = 9222) -> list[dict]:
    url = f"http://127.0.0.1:{port}/json/list"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 绕过系统代理
    for _ in range(20):
        try:
            with opener.open(url, timeout=6) as r:
                return json.loads(r.read().decode())
        except Exception:  # noqa: BLE001
            time.sleep(0.6)
    sys.exit("无法连接 DevTools 端点，确认 App 在前台且是 debug 包")


def connect(port: int = 9222, match: str = "localhost"):
    targets = [t for t in list_targets(port) if t.get("type") == "page"]
    if match:
        targets = [t for t in targets if match in t.get("url", "")] or targets
    if not targets:
        sys.exit("没有可用的页面目标")
    target = targets[0]
    ws = websocket.create_connection(target["webSocketDebuggerUrl"], timeout=60,
                                     suppress_origin=True, http_proxy_host=None)
    return ws, target


class Session:
    def __init__(self, ws):
        self.ws = ws
        self._id = 0

    def call(self, method: str, params: dict | None = None):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    def evaluate(self, expr: str, await_promise: bool = True):
        res = self.call(
            "Runtime.evaluate",
            {
                "expression": expr,
                "returnByValue": True,
                "awaitPromise": await_promise,
                "userGesture": True,
            },
        )
        if res.get("exceptionDetails"):
            det = res["exceptionDetails"]
            desc = (det.get("exception") or {}).get("description") or det.get("text")
            raise RuntimeError(f"JS 异常: {desc}")
        return res.get("result", {}).get("value")


SNIPPET = r"""
// —— 常用片段 ——
// 1) 环境自检
JSON.stringify({ native: !!(window.Capacitor), platform: window.Capacitor?.getPlatform?.(),
  origin: location.origin, httpPatched: typeof window.CapacitorWebFetch === 'function'
    && window.fetch !== window.CapacitorWebFetch })

// 2) 设置 React 受控 input 的值（必须用原生 setter + input 事件，否则 React 不认）
function setInput(el, v) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

// 3) 按文字点按钮
[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '获取验证码').click()
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["targets", "eval", "eval-file", "snippet"])
    ap.add_argument("arg", nargs="?")
    ap.add_argument("--port", type=int, default=9222)
    args = ap.parse_args()

    if args.action == "snippet":
        print(SNIPPET.strip())
        return

    if args.action == "targets":
        pid = find_app_pid()
        ensure_forward(pid, args.port)
        for t in list_targets(args.port):
            print(json.dumps({k: t.get(k) for k in ("id", "type", "title", "url")}, ensure_ascii=False))
        return

    expr = args.arg or ""
    if args.action == "eval-file":
        with open(args.arg, encoding="utf-8") as f:
            expr = f.read()

    pid = find_app_pid()
    ensure_forward(pid, args.port)
    ws, target = connect(args.port)
    try:
        session = Session(ws)
        session.call("Runtime.enable")
        value = session.evaluate(expr)
        if isinstance(value, (dict, list)):
            print(json.dumps(value, ensure_ascii=False, indent=2))
        else:
            print(value)
    finally:
        ws.close()


if __name__ == "__main__":
    main()
