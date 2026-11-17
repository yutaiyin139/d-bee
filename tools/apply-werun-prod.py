"""WX-1 微信运动网关手术式部署（2026-11-17）。

范围（严格限定）：
  · 新增 /opt/dbee-gateway/lib/werun.mjs（本地 server/lib/werun.mjs 逐字节）
  · 手术 /opt/dbee-gateway/lib/app.mjs   （4 处锚点：import/装配/路由/return）
  · 手术 /opt/dbee-gateway/lib/auth.mjs  （4 处锚点：sessionKey 返回/导出/两处注释）
  · sudo systemctl restart dbee-gateway
  ✗ 不碰 gateway.env（前后 sha256 断言不变）、不碰 nginx、不碰数据库、
    不碰其余 9 个 .mjs、不整体覆盖（本地版含 0046/xpay 依赖，覆盖即全站宕机）。

安全闸门（按顺序，任一失败即中止/回滚）：
  ① 生产基线指纹钉死：app=f9b521d8… auth=3444aaa2… env=ef88014e…
     （不符＝生产被他人改过 → 中止，手术锚点可能失效）
  ② 手术在【新鲜下载的生产副本】上做，产物 sha256 必须等于本地预演值
     （054bb5ec… / 53ea73e5…）；8 锚点唯一命中断言在 operate() 内
  ③ 影子环境预检：服务器暂存目录搭 shadow（生产 12 模块 + 手术 3 文件），
     用生产 node v22 跑 tools/werun-selftest.mjs 27 项全链路（mock pool/fetch，
     不连真库不发外呼）→ 全绿才继续
  ④ 真 ESM import 干跑：node esm-dryrun.mjs 静态 import 手术版 app.mjs
     （拉起整条依赖图；index.mjs 才 listen，app.mjs 纯装配无副作用）→ 防顶层崩溃
  ⑤ 备份 app/auth/env 到 /etc/dbee/.bak-<ts>-werun/，回读 sha 核对
  ⑥ 落盘后回读 sha256 == 手术产物；gateway.env sha256 不变
  ⑦ restart + sleep 8 + healthz×3（防假红）+ unit active
  ⑧ 端点验收：werun/sync 无 Bearer → 401 未登录（非 404）；login-wechat 回归；
     healthz db.ok=true
  ⑨ 失败自动回滚：恢复 app/auth + 删除本次新增的 werun.mjs + restart

回滚删除的 werun.mjs 是【本脚本本次刚部署】的新增文件（撤销本次改动），
不是删除既有生产文件。凭据从 .env IP/USER/SSH_PWD 读取，绝不回显；
暂存 700/600，用后 rm -rf。

用法（项目根目录）：
  python tools/apply-werun-prod.py --dry-run   # 只读：基线核对+手术预演，零写入
  python tools/apply-werun-prod.py             # 正式部署
退出码：0=成功 · 1=失败已回滚 · 2=本地前置不满足 · 3=断言/预检失败（未动生产或已回滚）
"""
from __future__ import annotations

import hashlib
import importlib.util
import sys
import tempfile
import time
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent.parent
LIB = "/opt/dbee-gateway/lib"
ENVF = "/etc/dbee/gateway.env"
NODE = "/usr/local/bin/node"

# 手术逻辑与 build-werun-surgical.py 共用一份（文件名带连字符 → importlib 按路径加载）
_spec = importlib.util.spec_from_file_location(
    "build_werun_surgical", ROOT / "tools" / "build-werun-surgical.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
operate = _mod.operate

# ── 基线指纹（2026-11-17 22:14 只读探针实测；不符即中止）───────────────
EXPECT_PROD_APP = "f9b521d86601c14779f4fdeae55b21e3b5a8b26b1c1fee75c0ac372615082031"
EXPECT_PROD_AUTH = "3444aaa22e144270040de8ae3cebf0332ac671e865aa93d35a25c86bc9f34957"
EXPECT_ENV = "ef88014ee319dd6d49ab84d56e7652995b72e5b19cde1b026ec5c731f4ec1d3d"
# 手术产物（本地预演 build-werun-surgical.py 输出，字节级钉死）
EXPECT_NEW_APP = "054bb5ec0891d2c5b988bc208c1e0b08b86beb7b1d7bfd9a56734d096dc7fda9"
EXPECT_NEW_AUTH = "53ea73e55e4356125c09d20016da19f06b63cbe2489c51879ed04104735f2c29"

# ESM 干跑脚本：静态 import 手术版 app.mjs（相对路径 = shadow/esm-dryrun.mjs）
ESM_DRYRUN = """\
import { createApp } from './server/lib/app.mjs'
import { createWerunHandlers } from './server/lib/werun.mjs'
if (typeof createApp !== 'function') { console.error('createApp missing'); process.exit(1) }
if (typeof createWerunHandlers !== 'function') { console.error('createWerunHandlers missing'); process.exit(1) }
console.log('IMPORT_OK createApp+createWerunHandlers')
process.exit(0)
"""

DRY = "--dry-run" in sys.argv


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def load_env() -> dict:
    kv = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        kv[k.strip()] = v.strip().strip('"').strip("'")
    return kv


def fail(msg: str, code: int = 3) -> int:
    print(f"[x] {msg}")
    return code


def main() -> int:
    env = load_env()
    host = env.get("IP") or env.get("DBEE_HOST")
    user = env.get("USER")
    pwd = env.get("SSH_PWD")
    if not (host and user and pwd):
        return fail(".env 缺 IP/USER/SSH_PWD", 2)

    werun_local = (ROOT / "server" / "lib" / "werun.mjs").read_bytes()
    selftest_local = (ROOT / "tools" / "werun-selftest.mjs").read_bytes()
    if b"\r" in werun_local or b"\r" in selftest_local:
        return fail("werun.mjs / werun-selftest.mjs 含 CR", 2)
    print("═══ ⓪ 本地前置 ═══")
    print(f"  werun.mjs        {len(werun_local)} B sha256:{sha(werun_local)[:16]}")
    print(f"  werun-selftest   {len(selftest_local)} B sha256:{sha(selftest_local)[:16]}")

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"\n═══ 连接 {user}@{host} ═══")
    cli.connect(host, username=user, password=pwd, timeout=30)
    cli.get_transport().set_keepalive(30)

    def sh(cmd: str, timeout: int = 120) -> tuple[int, str, str]:
        _i, o, e = cli.exec_command(cmd, timeout=timeout)
        out = o.read().decode("utf-8", "replace")
        rc = o.channel.recv_exit_status()
        return rc, out, e.read().decode("utf-8", "replace")

    def sudo(cmd: str, timeout: int = 120) -> tuple[int, str, str]:
        # 命令内禁止出现单引号（bash -c '…' 包装）；密码不进命令行（sudo -n 已实测可用）
        assert "'" not in cmd, f"sudo() 命令含单引号会破坏包装: {cmd[:80]}"
        return sh(f"sudo -n bash -c '{cmd}'", timeout)

    bak = ""
    stage = ""
    werun_deployed = False

    def rollback(restart: bool) -> None:
        if not bak:
            return
        print(f"  ↩ 回滚：app/auth 从 {bak} 恢复"
              + ("；删除本次新增 werun.mjs" if werun_deployed else ""))
        sudo(f"cp -a {bak}/app.mjs {LIB}/app.mjs && cp -a {bak}/auth.mjs {LIB}/auth.mjs")
        if werun_deployed:
            sudo(f"rm -f {LIB}/werun.mjs")
        if restart:
            sudo("systemctl restart dbee-gateway.service")
            time.sleep(8)
        _, out, _ = sudo(f"sha256sum {LIB}/app.mjs {LIB}/auth.mjs {ENVF}")
        print("  ↩ 回滚后指纹：")
        for line in out.splitlines():
            print("    " + line)
        print(f"  ↩ 回滚完成（运行态{'已重启' if restart else '未重启'}）")

    tmpdir = Path(tempfile.gettempdir())
    try:
        # ── ① 生产基线核对（只读）───────────────────────────────────
        print("\n═══ ① 生产基线指纹（不符即中止，零写入）═══")
        rc, out, err = sudo(f"sha256sum {LIB}/app.mjs {LIB}/auth.mjs {ENVF} && "
                            f"test ! -f {LIB}/werun.mjs && echo NO_WERUN")
        if rc != 0:
            return fail(f"读基线失败 rc={rc} {err[:200]}（werun.mjs 已存在？疑似重复部署）")
        shas = {}
        for line in out.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1].startswith("/"):
                shas[parts[1]] = parts[0]
        if "NO_WERUN" not in out:
            return fail(f"{LIB}/werun.mjs 已存在 —— 疑似已部署过，中止（人工核查）")
        if shas.get(f"{LIB}/app.mjs") != EXPECT_PROD_APP:
            return fail(f"生产 app.mjs 指纹漂移：{str(shas.get(LIB + '/app.mjs'))[:16]} ≠ 基线 —— 中止")
        if shas.get(f"{LIB}/auth.mjs") != EXPECT_PROD_AUTH:
            return fail(f"生产 auth.mjs 指纹漂移：{str(shas.get(LIB + '/auth.mjs'))[:16]} ≠ 基线 —— 中止")
        if shas.get(ENVF) != EXPECT_ENV:
            return fail(f"gateway.env 指纹漂移：{str(shas.get(ENVF))[:16]} ≠ 基线 —— 中止")
        print("  ✓ app/auth/env 三指纹与基线一致；werun.mjs 不存在（待新增）")
        _, out, _ = sudo("systemctl is-active dbee-gateway && "
                         "systemctl show dbee-gateway -p NRestarts --value")
        olines = out.split()
        print(f"  ✓ 网关 {olines[0] if olines else '?'} NRestarts={olines[-1] if olines else '?'}")

        # ── ② 新鲜下载生产副本 → 本地手术 → 指纹核对 ────────────────
        print("\n═══ ② 新鲜下载 + 本地手术 ═══")
        _, home, _ = sh("echo $HOME")
        home = home.strip()
        stage = f"{home}/dbee-werun-stage"
        sh(f"rm -rf {stage} && mkdir -p {stage}/pull && chmod 700 {stage} {stage}/pull")
        rc, _, err = sudo(f"cp {LIB}/app.mjs {stage}/pull/app.mjs && "
                          f"cp {LIB}/auth.mjs {stage}/pull/auth.mjs && "
                          f"chown {user} {stage}/pull/app.mjs {stage}/pull/auth.mjs && "
                          f"chmod 600 {stage}/pull/app.mjs {stage}/pull/auth.mjs")
        if rc != 0:
            sh(f"rm -rf {stage}")
            return fail(f"暂存生产副本失败 rc={rc} {err[:160]}")
        pull_app = tmpdir / "werun-pull-app.mjs"
        pull_auth = tmpdir / "werun-pull-auth.mjs"
        sftp = cli.open_sftp()
        try:
            sftp.get(f"{stage}/pull/app.mjs", str(pull_app))
            sftp.get(f"{stage}/pull/auth.mjs", str(pull_auth))
        finally:
            sftp.close()
        prod_app = pull_app.read_bytes()
        prod_auth = pull_auth.read_bytes()
        pull_app.unlink(missing_ok=True)
        pull_auth.unlink(missing_ok=True)
        if sha(prod_app) != EXPECT_PROD_APP or sha(prod_auth) != EXPECT_PROD_AUTH:
            sh(f"rm -rf {stage}")
            return fail("下载副本指纹与基线不符（传输损坏或 TOCTOU）—— 中止")
        if b"\r" in prod_app or b"\r" in prod_auth:
            return fail("生产副本含 CR —— 中止")
        print("  ✓ 下载副本逐字节 = 生产（SFTP 传输无损）")
        new_app, new_auth = operate(prod_app.decode("utf-8"), prod_auth.decode("utf-8"))
        new_app_b = new_app.encode("utf-8")
        new_auth_b = new_auth.encode("utf-8")
        if sha(new_app_b) != EXPECT_NEW_APP:
            return fail(f"手术 app.mjs 指纹 {sha(new_app_b)[:16]} ≠ 预演值 —— 中止")
        if sha(new_auth_b) != EXPECT_NEW_AUTH:
            return fail(f"手术 auth.mjs 指纹 {sha(new_auth_b)[:16]} ≠ 预演值 —— 中止")
        print("  ✓ 手术产物与本地预演字节级一致（8 锚点唯一命中）")

        if DRY:
            sh(f"rm -rf {stage}")
            print("\n[--dry-run] 基线核对 + 手术预演完成，生产零写入")
            return 0

        # ── ③ 上传手术 3 文件 + 自测 → 影子环境预检 ─────────────────
        print("\n═══ ③ 影子环境预检（生产 node + 生产 12 模块 + 手术 3 文件）═══")
        sftp = cli.open_sftp()
        try:
            for name, data in (("app.mjs", new_app_b), ("auth.mjs", new_auth_b),
                               ("werun.mjs", werun_local),
                               ("werun-selftest.mjs", selftest_local),
                               ("esm-dryrun.mjs", ESM_DRYRUN.encode("utf-8"))):
                with sftp.open(f"{stage}/{name}", "wb") as f:
                    f.write(data)
        finally:
            sftp.close()
        rc, out, err = sh(
            f"set -e; cd {stage}; mkdir -p shadow/server/lib shadow/tools; "
            f"cp {LIB}/*.mjs shadow/server/lib/; "
            # iap.mjs 顶层 readFileSync(lib/../assets/AppleRootCA-G3.cer)：
            # 影子必须镜像 assets 相对布局，否则 ESM 加载即 ENOENT（首跑实测假红）
            f"cp -r /opt/dbee-gateway/assets shadow/server/assets; "
            # 生产依赖（pg 等）在 /opt/dbee-gateway/node_modules：软链进影子，
            # node 从文件目录向上解析 node_modules 即可命中（首跑实测缺 pg 假红）
            f"ln -sfn /opt/dbee-gateway/node_modules shadow/node_modules; "
            f"cp /opt/dbee-gateway/package.json shadow/package.json 2>/dev/null || true; "
            f"cp app.mjs auth.mjs werun.mjs shadow/server/lib/; "
            f"cp werun-selftest.mjs shadow/tools/; cp esm-dryrun.mjs shadow/; "
            f"cd shadow; {NODE} --check server/lib/app.mjs; {NODE} --check server/lib/auth.mjs; "
            f"{NODE} --check server/lib/werun.mjs; echo CHECK_OK; "
            f"{NODE} tools/werun-selftest.mjs", timeout=180)
        tail = "\n".join(out.strip().splitlines()[-8:])
        print("  " + tail.replace("\n", "\n  "))
        if err.strip():
            print("  [stderr] " + err.strip()[:300])
        if rc != 0 or "CHECK_OK" not in out or "失败 0" not in out:
            sh(f"rm -rf {stage}")
            return fail("影子自测未全绿 —— 中止（生产零写入）")
        print("  ✓ 生产 node 下：语法 OK + 27 项全链路自测全绿"
              "（解密/归属/水印/伪造steps/日志红线）")

        # ── ④ 真 ESM import 干跑（整条依赖图，防顶层崩溃）───────────
        print("\n═══ ④ ESM import 干跑（手术 app.mjs + 生产其余模块）═══")
        rc, out, err = sh(f"cd {stage}/shadow && {NODE} esm-dryrun.mjs", timeout=60)
        print(f"  {out.strip() or err.strip()[:200]}")
        if rc != 0 or "IMPORT_OK" not in out:
            sh(f"rm -rf {stage}")
            return fail("ESM import 干跑失败 —— 中止（生产零写入，绝不带病重启）")

        # ── ⑤ 备份 ──────────────────────────────────────────────────
        ts = time.strftime("%Y%m%d-%H%M%S")
        bak = f"/etc/dbee/.bak-{ts}-werun"
        print(f"\n═══ ⑤ 备份到 {bak}/ ═══")
        rc, out, err = sudo(f"install -d -m 0750 -o root -g dbee {bak} && "
                            f"cp -a {LIB}/app.mjs {LIB}/auth.mjs {bak}/ && "
                            f"cp -a {ENVF} {bak}/gateway.env && "
                            f"sha256sum {bak}/app.mjs {bak}/auth.mjs {bak}/gateway.env")
        if rc != 0 or not (EXPECT_PROD_APP in out and EXPECT_PROD_AUTH in out
                           and EXPECT_ENV in out):
            bak = ""
            return fail(f"备份失败或回读指纹不符 rc={rc} {err[:160]} —— 中止（生产零写入）")
        print("  ✓ 备份 3 文件指纹核对一致")

        # ── ⑥ 落盘 + 回读断言 ───────────────────────────────────────
        print("\n═══ ⑥ 落盘（root:dbee / 644）═══")
        rc, _, err = sudo(
            f"install -m 0644 -o root -g dbee {stage}/werun.mjs {LIB}/werun.mjs && "
            f"install -m 0644 -o root -g dbee {stage}/app.mjs {LIB}/app.mjs && "
            f"install -m 0644 -o root -g dbee {stage}/auth.mjs {LIB}/auth.mjs")
        werun_deployed = True
        if rc != 0:
            print(f"  落盘失败 {err[:160]} —— 回滚（不重启，旧进程仍在跑旧代码）")
            rollback(False)
            return fail("落盘失败已回滚", 1)
        _, rb, _ = sudo(f"sha256sum {LIB}/app.mjs {LIB}/auth.mjs {LIB}/werun.mjs {ENVF}")
        checks = [(EXPECT_NEW_APP, f"{LIB}/app.mjs"), (EXPECT_NEW_AUTH, f"{LIB}/auth.mjs"),
                  (sha(werun_local), f"{LIB}/werun.mjs"), (EXPECT_ENV, ENVF)]
        for expect, path in checks:
            hit = any(line.startswith(expect) and line.endswith(path)
                      for line in rb.splitlines())
            if not hit:
                print(f"  回读不符：{path}")
                rollback(False)
                return fail("落盘回读断言失败已回滚", 1)
        print("  ✓ 3 文件回读 sha256 逐字节一致；gateway.env 未被触碰（指纹不变）")

        # ── ⑦ 重启 + 探活（sleep 8 防假红）──────────────────────────
        print("\n═══ ⑦ 重启网关 ═══")
        rc, _, err = sudo("systemctl restart dbee-gateway.service")
        if rc != 0:
            print(f"  restart 失败 {err[:160]} —— 回滚并重启")
            rollback(True)
            return fail("restart 失败已回滚", 1)
        time.sleep(8)
        healthy = False
        for i in range(3):
            rc, out, _ = sh("curl -sS -m 10 https://d-bee.cn/.cloud/healthz")
            print(f"  healthz 第{i + 1}次 → {out[:130]}")
            if '"ok":true' in out:
                db_part = out.split('"db":{', 1)[1][:60] if '"db":{' in out else ""
                if '"ok":true' in db_part:
                    healthy = True
                    break
            time.sleep(4)
        if not healthy:
            print("  healthz 未恢复 —— 回滚并重启")
            rollback(True)
            return fail("healthz 失败已回滚", 1)
        _, out, _ = sudo("systemctl is-active dbee-gateway && "
                         "systemctl show dbee-gateway -p NRestarts --value")
        olines = out.split()
        if not olines or olines[0] != "active":
            rollback(True)
            return fail(f"unit 非 active：{out[:80]} 已回滚", 1)
        print(f"  ✓ unit=active NRestarts={olines[-1]}")

        # ── ⑧ 端点验收（生产实测，铁律 #13）─────────────────────────
        print("\n═══ ⑧ 端点验收 ═══")
        _, out, _ = sh(
            "curl -sS -m 10 -w '\\nHTTP:%{http_code}' -X POST "
            "https://d-bee.cn/.cloud/auth/v1/werun/sync "
            "-H 'content-type: application/json' -d '{}'")
        print(f"  werun/sync 无Bearer → {out.strip()[:220]}")
        werun_ok = "HTTP:401" in out and "not_found" not in out and "未登录" in out
        _, out2, _ = sh(
            "curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST "
            "https://d-bee.cn/.cloud/auth/v1/login-wechat "
            "-H 'content-type: application/json' -d '{}'")
        print(f"  login-wechat 回归 → {out2.strip()}")
        login_ok = out2.strip() in ("400", "401")
        _, out3, _ = sh("curl -sS -m 10 https://d-bee.cn/.cloud/healthz")
        health_ok = '"ok":true' in out3
        print(f"  werun 路由挂载     = {'PASS' if werun_ok else 'FAIL'}（期望 401 未登录，非 404）")
        print(f"  login-wechat 回归  = {'PASS' if login_ok else 'FAIL'}")
        print(f"  healthz            = {'PASS' if health_ok else 'FAIL'}")

        # ── ⑨ 清理 ──────────────────────────────────────────────────
        sh(f"rm -rf {stage}")
        print("\n═══ ⑨ 清理 ═══\n  ✓ 服务器暂存目录已删除")

        if not (werun_ok and login_ok and health_ok):
            print("\n[!] 端点验收未全绿 —— 文件已就位且进程 active，未自动回滚，请人工核查")
            return 3
        print("\n✅ WX-1 网关部署完成：werun.mjs 新增 + app/auth 手术生效 + 网关已重启")
        print(f"   备份保留在 {bak}/（可用于回滚）")
        print("   剩余：③ 重建 mini/dist（删除旧包需用户确认）→ 用户本人上传体验版真机验证")
        return 0
    finally:
        try:
            cli.close()
        except Exception:
            pass


if __name__ == "__main__":
    try:
        rc = main()
    except SystemExit as e:  # operate() 锚点断言失败
        print(f"[x] {e}")
        rc = 3
    except Exception as exc:
        print(f"[x] 未捕获异常：{type(exc).__name__}: {str(exc)[:200]}")
        rc = 1
    sys.exit(rc)
