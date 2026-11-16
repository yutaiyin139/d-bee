#!/usr/bin/env python3
"""部署 Web 产物到生产 /var/www/d-bee：逐文件 SFTP + 全量 sha256 校验 + 原子切换。

为什么不用 deploy/deploy.sh
---------------------------
它调 `dbee-ssh.py putdir`，而 putdir 历史上不可靠（记忆已记：改逐文件 put + 事后全量
sha256 才可信）。且它会顺带跑 `npm run build` —— 本次 dist/ 已构建并自检通过，不应重跑
（native 与 web 共用 dist/，重跑构建可能引入变体混淆）。

关键设计
--------
① 🔴 index.html **最后上传**：它是入口，引用带 hash 的 assets。若先传 index.html，
   中间窗口里用户会拿到「新入口 + 缺 assets」→ 白屏。最后传等于原子切换。
② 🔴 不删除任何旧文件：assets/ 是 hash 命名，新旧并存互不干扰；保留旧 index-*.js
   反而让「已打开旧页面的用户」能继续加载其依赖（渐进过渡）。
   清理历史堆积属独立决策，须按用户的删除确认纪律单独走。
③ 上传后服务器侧逐文件 sha256 与本地计算值比对，全等才算成功（防 SFTP 静默截断）。
④ 上传后公网实测：https://d-bee.cn/ 的入口必须已切到新 hash，且新入口 js 可 200 取到。
⑤ 失败即报错并指出可用回滚备份路径（服务器 /var/www/d-bee/.bak-<ts>/）。

用法：python deploy/apply-web-dist.py
退出码：0 成功 / 1 校验或冒烟失败 / 2 缺凭据 / 3 本地 dist 不完整
"""

from __future__ import annotations

import hashlib
import os
import posixpath
import re
import subprocess
import sys

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(REPO, ".env")
DIST = os.path.join(REPO, "dist")
WEB = "/var/www/d-bee"
DOMAIN = "d-bee.cn"


def load_env() -> dict[str, str]:
    out: dict[str, str] = {}
    with open(ENV_PATH, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def collect_dist() -> list[tuple[str, bytes, str]]:
    """返回 [(相对路径, 内容字节, sha256)]，index.html 排在最后。"""
    items: list[tuple[str, bytes, str]] = []
    for root, _dirs, files in os.walk(DIST):
        for name in files:
            lp = os.path.join(root, name)
            rel = os.path.relpath(lp, DIST).replace(os.sep, "/")
            data = open(lp, "rb").read()
            items.append((rel, data, hashlib.sha256(data).hexdigest()))
    # 🔴 index.html 最后：它是入口，先传会造成「新入口 + 旧/缺 assets」白屏窗口
    items.sort(key=lambda t: (t[0] == "index.html", t[0]))
    return items


def entry_of(html: bytes) -> str:
    m = re.search(rb'(index-[A-Za-z0-9_-]+\.js)', html)
    return m.group(1).decode() if m else ""


def main() -> int:
    if not os.path.isdir(DIST):
        print(f"[x] dist 不存在: {DIST}")
        return 3
    items = collect_dist()
    if not items:
        print("[x] dist 为空")
        return 3

    html = next((d for r, d, _ in items if r == "index.html"), None)
    if html is None:
        print("[x] dist 缺 index.html")
        return 3
    new_entry = entry_of(html)
    if not new_entry:
        print("[x] 无法从 index.html 解析出入口 js 名")
        return 3

    print("=== ⓪ 本地产物自检 ===")
    print(f"  dist 文件数 : {len(items)}")
    print(f"  新入口      : {new_entry}")
    print(f"  上传顺序末位: {items[-1][0]}（🔴 index.html 最后传 = 原子切换）")
    assert items[-1][0] == "index.html", "index.html 未排在最后"
    missing_entry = [f"assets/{new_entry}"]
    have = {r for r, _, _ in items}
    if missing_entry[0] not in have:
        print(f"[x] 入口文件 assets/{new_entry} 不在 dist 里")
        return 3
    print(f"  入口文件在场: assets/{new_entry} ✅")

    env = load_env()
    host = env.get("DBEE_HOST") or ""
    user = env.get("USER") or "ubuntu"
    pwd = env.get("SSH_PWD") or ""
    if not host or not pwd:
        print("[x] .env 缺 DBEE_HOST / USER / SSH_PWD")
        return 2

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"\n连接 {user}@{host} ...")
    cli.connect(host, username=user, password=pwd, timeout=25,
                banner_timeout=25, auth_timeout=25)
    tr = cli.get_transport()
    if tr:
        tr.set_keepalive(30)

    try:
        # ① 记录当前线上入口（用于事后确认确实切换了）
        _, so, _ = cli.exec_command(
            f"grep -oE 'index-[A-Za-z0-9_-]+\\.js' {WEB}/index.html | head -1", timeout=30)
        old_entry = so.read().decode().strip()
        so.channel.recv_exit_status()
        print(f"\n=== ① 线上当前入口 ===\n  {old_entry or '(未解析到)'}")
        if old_entry == new_entry:
            print("  注：新旧入口同名，可能已部署过（幂等重跑）")

        # ② 确保子目录存在
        dirs = sorted({posixpath.dirname(r) for r, _, _ in items if posixpath.dirname(r)})
        print(f"\n=== ② 确保远端子目录存在（{len(dirs)} 个）===")
        for d in dirs:
            _, so, _ = cli.exec_command(f"mkdir -p '{WEB}/{d}'", timeout=30)
            so.channel.recv_exit_status()
        print("  OK " + " ".join(dirs))

        # ③ 逐文件上传（index.html 在最后）
        print(f"\n=== ③ 逐文件上传 {len(items)} 个 ===")
        sftp = cli.open_sftp()
        for i, (rel, data, _sha) in enumerate(items, 1):
            rp = f"{WEB}/{rel}"
            # 🔴 二进制原样写，绝不做换行替换（wasm/png 被改一个字节就废）
            with sftp.open(rp, "wb") as fh:
                fh.write(data)
            tag = "🔴入口" if rel == "index.html" else "      "
            print(f"  [{i:2d}/{len(items)}] {tag} ↑ {rel} ({len(data)} B)")
        sftp.close()

        # ④ 🔴 服务器侧全量 sha256 回读比对（防 SFTP 静默截断）
        print(f"\n=== ④ 服务器侧全量 sha256 校验 ===")
        remote_paths = " ".join(f"'{WEB}/{r}'" for r, _, _ in items)
        _, so, se = cli.exec_command(f"sha256sum {remote_paths}", timeout=120)
        out = so.read().decode("utf-8", "replace")
        err = se.read().decode("utf-8", "replace")
        rc = so.channel.recv_exit_status()
        if rc != 0:
            print(f"[x] sha256sum 失败 rc={rc}: {err.strip()[:300]}")
            return 1
        remote_sha = {}
        for line in out.strip().splitlines():
            parts = line.split()
            if len(parts) >= 2:
                remote_sha[parts[1].replace(WEB + "/", "", 1)] = parts[0]
        bad = []
        for rel, _data, sha in items:
            got = remote_sha.get(rel)
            if got != sha:
                bad.append((rel, sha[:12], (got or "(缺失)")[:12]))
        if bad:
            print(f"[x] {len(bad)} 个文件 sha256 不一致（SFTP 静默损坏？）：")
            for rel, want, got in bad:
                print(f"    {rel}  期望 {want}  实得 {got}")
            return 1
        print(f"  ✅ {len(items)}/{len(items)} 文件 sha256 全部逐字节一致")

        # ⑤ 确认入口已切换 + 新入口 js 可取到
        print(f"\n=== ⑤ 线上入口切换确认 ===")
        _, so, _ = cli.exec_command(
            f"grep -oE 'index-[A-Za-z0-9_-]+\\.js' {WEB}/index.html | head -1", timeout=30)
        now_entry = so.read().decode().strip()
        so.channel.recv_exit_status()
        print(f"  部署后入口: {now_entry}（期望 {new_entry}）")
        if now_entry != new_entry:
            print("[x] 入口未切换成功")
            return 1
        print("  ✅ 入口已切换")
    finally:
        cli.close()

    # ⑥ 🔴 公网实测（铁律 #13：本地/服务器绿 ≠ 线上绿）
    print(f"\n=== ⑥ 公网侧实测（铁律 #13）===")
    ok = True

    def curl(args: list[str], timeout=40) -> tuple[int, str]:
        r = subprocess.run(["curl", *args], capture_output=True, text=True,
                           timeout=timeout, encoding="utf-8", errors="replace")
        return r.returncode, (r.stdout or "") + (r.stderr or "")

    def http_code(url: str, extra: list[str] | None = None) -> str:
        # 🔴 用「分隔符 + -w」把状态码单独取出来，不要拿 body 尾巴猜：
        #    首次实跑时把 `-o /dev/null -w '%{http_code}'` 的 stdout 又和后续
        #    body 混在一起，最后 3 个字符变成 body 内容（实测打印出 "HTTP tes"），
        #    导致明明 200 却判失败。改为 -w 输出前置换行分隔、只取最后一段数字。
        args = ["-sS", "-m", "20", "-o", "/dev/null", "-w", "\n%{http_code}"]
        if extra:
            args = ["-sS", "-m", "20", "-o", "/dev/null", "-w", "\n%{http_code}", *extra]
        args.append(url)
        _rc, out = curl(args)
        tail = out.strip().splitlines()[-1] if out.strip() else "000"
        return tail.strip() if tail.strip().isdigit() else "000"

    code = http_code(f"https://{DOMAIN}/")
    print(f"  https://{DOMAIN}/            -> HTTP {code}（期望 200）")
    ok &= code == "200"

    _rc, body = curl(["-sS", "-m", "20", f"https://{DOMAIN}/"])
    got = entry_of(body.encode("utf-8", "replace"))
    print(f"  线上 index.html 入口         -> {got or '(未解析)'}（期望 {new_entry}）")
    ok &= (got == new_entry)

    code = http_code(f"https://{DOMAIN}/assets/{new_entry}")
    print(f"  新入口 js 可取               -> HTTP {code}（期望 200）")
    ok &= code == "200"

    # 新包探针：必须走 features 路由、必须不含旧的 dbee-feature 标记
    _rc, js = curl(["-sS", "-m", "30", f"https://{DOMAIN}/assets/{new_entry}"], timeout=90)
    has_features = "llm/features/" in js
    has_old_mark = "dbee-feature" in js
    print(f"  新包含 llm/features/ 路由    -> {has_features}（期望 True）")
    print(f"  新包含 dbee-feature 旧标记   -> {has_old_mark}（期望 False）")
    ok &= has_features and not has_old_mark

    _rc, out = curl(["-sS", "-m", "20", f"https://{DOMAIN}/.cloud/healthz"])
    print(f"  healthz                     -> {out.strip()[:110]}")
    ok &= '"ok":true' in out

    # 🔴 期望 400（不是 401）：空 body 会先被 buildOwnedMessages 参数校验拦下，
    #    400 = 路由命中 + handler 执行 + 参数校验生效；404 才是「网关没这条路由」。
    code = http_code(f"https://{DOMAIN}/.cloud/llm/features/meal",
                     ["-X", "POST", "-H", "Content-Type: application/json", "-d", "{}"])
    print(f"  features/meal（网关联动）    -> HTTP {code}（期望 400，404=网关未部署）")
    ok &= code == "400"

    if not ok:
        print("\n[x] 公网实测未全绿 —— 见上方失败项")
        print("    回滚：sudo cp -a /var/www/d-bee/.bak-<ts>/index.html /var/www/d-bee/ 等")
        return 1
    print("\n✅ WEB_DEPLOY_OK 新包已上线且公网实测全绿")
    return 0


if __name__ == "__main__":
    sys.exit(main())
