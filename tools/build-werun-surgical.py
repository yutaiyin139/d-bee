"""基于生产副本本地生成 werun 手术版 app.mjs / auth.mjs（纯本地，零连接）。

🔴 为什么不用本地 HEAD 版直接覆盖生产：
   本地 auth.mjs 混入 0046 的 `import { saveSessionKey } from './wechatSession.mjs'`，
   生产 lib 无 wechatSession.mjs → 整体覆盖 = ESM 顶层崩溃 = 全站宕机。
   本地 app.mjs 也含 xpay/apppay 装配，同样生产没有。
   所以手术必须在【生产副本】上做最小字符串插入/替换。

手术清单（8 处锚点，每处强制唯一命中）：
  app.mjs：
    A1 import 区：iap import 行后插 werun import
    A2 装配区：`const router = new Router()` 前插 werun 装配
    A3 路由区：login-wechat 路由行后插 werun/sync 路由
    A4 return 块：加 werun（自测/可观测性用）
  auth.mjs：
    B1 成功返回：{ ok:true, openid } → 加 sessionKey（werun 解密必需；
       生产 loginWechat 只消费 openid，加字段完全向后兼容）
    B2 导出块：refresh, 后加 exchangeWechatCode,
    B3 JSDoc 纪律②注释：「拿到即弃/只返回 openid」→ 更新为 WX-1 实况（防注释漂移）
    B4 JSDoc @returns：补 sessionKey 字段

operate() 供 tools/apply-werun-prod.py import 复用（同一份手术逻辑，不分叉）。
输出 LF；任一锚点非唯一命中即 SystemExit，调用方零写入。

CLI 用法：python tools/build-werun-surgical.py <生产app.mjs> <生产auth.mjs> <输出目录>
"""
import sys
from pathlib import Path


def replace_once(text: str, old: str, new: str, tag: str) -> str:
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"FAIL: 锚点 {tag} 命中 {n} 次（必须恰好 1）—— 中止，未输出任何文件")
    return text.replace(old, new)


def operate(app: str, auth: str) -> tuple[str, str]:
    """对生产副本 app/auth 文本做 8 处锚点手术，返回 (new_app, new_auth)。"""
    # ── A1: import 区 ────────────────────────────────────────────────
    app = replace_once(
        app,
        "import { createIapHandlers } from './iap.mjs'\n",
        "import { createIapHandlers } from './iap.mjs'\n"
        "import { createWerunHandlers } from './werun.mjs'\n",
        "A1-import",
    )

    # ── A2: 装配区（router 创建前）───────────────────────────────────
    app = replace_once(
        app,
        "\n  const router = new Router()\n",
        "\n  // WX-1：werun 复用 auth 的 exchangeWechatCode（同批次 session_key）+ authOwnerIdStrict。\n"
        "  // 无需条件装配：未登录/未配置 appid 时端点自身返回 401/503（同 login-wechat 范式）。\n"
        "  const werun = createWerunHandlers({ cfg, logger, auth })\n"
        "\n  const router = new Router()\n",
        "A2-assemble",
    )

    # ── A3: 路由区（login-wechat 后）─────────────────────────────────
    app = replace_once(
        app,
        "  router.on('POST', `${A}/login-wechat`, wrap(auth.loginWechat))\n",
        "  router.on('POST', `${A}/login-wechat`, wrap(auth.loginWechat))\n"
        "  // WX-1：微信运动步数同步（需 Bearer + 用户主动触发，服务端解密只返回当天步数）\n"
        "  router.on('POST', `${A}/werun/sync`, wrap(werun.sync))\n",
        "A3-route",
    )

    # ── A4: return 块 ────────────────────────────────────────────────
    app = replace_once(
        app,
        "    server, router, otp, auth, llm, dbProxy, iap,\n",
        "    server, router, otp, auth, werun, llm, dbProxy, iap,\n",
        "A4-return",
    )

    # ── B1: 成功返回加 sessionKey ────────────────────────────────────
    auth = replace_once(
        auth,
        "    return { ok: true, openid: data.openid }\n",
        "    // WX-1：session_key 可能缺失（极老客户端或微信异常）→ 按空串返回；\n"
        "    // werun 侧对空 key fail-closed（长度≠16 → 400），不落库、不下发、不进日志。\n"
        "    const sessionKey = typeof data.session_key === 'string' ? data.session_key : ''\n"
        "    return { ok: true, openid: data.openid, sessionKey }\n",
        "B1-sessionkey",
    )

    # ── B2: 导出块加 exchangeWechatCode ──────────────────────────────
    auth = replace_once(
        auth,
        "  return {\n    refresh,\n",
        "  return {\n    refresh,\n"
        "\n"
        "    // WX-1（2026-11-17）：微信运动步数解密端点 werun.mjs 复用同一套\n"
        "    //   appid 白名单 + jscode2session + 错误码归类，session_key 仅内存瞬时。\n"
        "    //   暴露函数本身而非结果，保证「同批次 code 即时换 session_key」（规划 §9 方案 A）。\n"
        "    exchangeWechatCode,\n",
        "B2-export",
    )

    # ── B3: 纪律②注释更新（防注释与代码漂移）────────────────────────
    auth = replace_once(
        auth,
        "   *      拿到即弃：本函数**只返回 openid**，不把 session_key 传出、不落库、不记日志。\n",
        "   *      WX-1 起返回 sessionKey 供 werun.mjs 同批次解密微信运动密文：\n"
        "   *      仅内存瞬时传递，不落库、不下发前端、不记日志（本函数不打值）。\n",
        "B3-jsdoc",
    )

    # ── B4: @returns 注释 ────────────────────────────────────────────
    auth = replace_once(
        auth,
        "   * @returns {Promise<{ok:true, openid:string}|{ok:false, status:number, message:string, code:string, errcode?:number}>}\n",
        "   * @returns {Promise<{ok:true, openid:string, sessionKey:string}|{ok:false, status:number, message:string, code:string, errcode?:number}>}\n",
        "B4-returns",
    )

    return app, auth


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    app_src, auth_src, out_dir = (Path(p) for p in sys.argv[1:4])
    for p in (app_src, auth_src):
        if not p.is_file():
            print(f"FAIL: 缺文件 {p}")
            return 2

    app = app_src.read_text(encoding="utf-8")
    auth = auth_src.read_text(encoding="utf-8")
    for name, t in (("app", app), ("auth", auth)):
        if "\r" in t:
            print(f"FAIL: 生产副本 {name} 含 CR —— 中止")
            return 2

    app, auth = operate(app, auth)

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "app.mjs").write_text(app, encoding="utf-8", newline="\n")
    (out_dir / "auth.mjs").write_text(auth, encoding="utf-8", newline="\n")

    # 自检回读
    for name in ("app.mjs", "auth.mjs"):
        t = (out_dir / name).read_text(encoding="utf-8")
        if "\r" in t:
            print(f"FAIL: 输出 {name} 含 CR")
            return 2
    print("OK  手术完成（8 处锚点全部唯一命中）：")
    print(f"  {out_dir/'app.mjs'}  {len(app.splitlines())} 行")
    print(f"  {out_dir/'auth.mjs'} {len(auth.splitlines())} 行")
    return 0


if __name__ == "__main__":
    sys.exit(main())
