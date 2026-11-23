"""本地驱动：把 0046 + 0047（Android APP 支付结算地基）应用到生产。

═══ 为什么需要这个脚本 ═══════════════════════════════════════════════════
2026-11-22 20:45 只读探针实证：Android 收费链是「**代码已写、生产未部署**」状态。
  · POST /.cloud/payment/apppay/prepay            → **404**（不是 503）
  · /opt/dbee-gateway/lib/apppay.mjs              → **文件不存在**
  · /opt/dbee-gateway/lib/config.mjs grep ALIPAY  → **0 命中**
  · schema_migrations                             → 0040–0045、0048–0055 全 applied，
                                                     **独缺 0046、0047**
  · app_payment_transactions / xpay_transactions  → **表不存在**
  · settle_app_payment / settle_xpay_purchase     → **函数不存在**

这与 2026-11-06 查出的「0043 + 微信登录 A1 从未部署」完全同型。

本脚本负责其中**第一步（B2）**：把 DB 结构与权限在生产就位。
🔴 **做完本脚本端点仍是 404** —— 端点从 404 变 503 是 B3（网关 3 文件）的职责，
   503 变可下单是 B8（配 ALIPAY_* 三键）的职责，真机能拉起收银台是 B9（vc32）的职责。
   **不得把本脚本的绿灯宣称为「Android 已能收款」**（铁律 #13）。

═══ 为什么不用 Docker（决策⑧）════════════════════════════════════════════
「迁移能跑」是运行时行为，静态读 SQL 证明不了。四条路里只有一条走得通：
  A. 本机 Docker 起 postgres:17   → ❌ wsl.exe 在本机安全策略程序黑名单，
                                       Docker Desktop(WSL2 后端)起不来（service=Stopped）
  B. embedded-postgres 本地二进制 → ❌ 版本偏差（PG 18.x ≠ 生产 17.11），且该环境
                                       在本机真实 FS 不存在（沙箱视图差异）→ 结论不可信
  C. 本机装原生 PG                → ❌ 无 psql/pg_ctl/postgres
  D. 生产 PG 17.11 直接应用       → ✅ 版本零偏差，就是本脚本
                                     （0046/0047 全幂等：IF NOT EXISTS + OR REPLACE，
                                      且自带 BEGIN/COMMIT，失败自动回滚）

═══════════════════════════════════════════════════════════════════════════
安全性：
  · 凭据只从项目根 .env 读取（DBEE_HOST / USER / SSH_PWD），绝不打印。
    🔴 SSH 走 ubuntu@$DBEE_HOST:**22**；`.env` 的 DBEE_PORT=5432 是 **PostgreSQL
    端口，不是 SSH 端口**（本轮首次探测误用它连 5432 → NoValidConnectionsError）。
    权威口径见 deploy/apply-web-dist.py:105-108。
  · 上传的两个文件都不含密钥（只有 DDL 与脚本源码），LF 化 + 权限 644。
    🔴 必须 644：服务器端 psql 以 postgres 身份跑，700/600 读不到（0045 首轮踩过）。
  · 应用前专用备份：pg_dump -Fc + pg_restore --list 验 TOC>100，验不过 FATAL 退出。
  · 🔴 顺序不可换：0046 与 0047 都 CREATE OR REPLACE verify_payment_order，
    0047 是 0046 的超集；倒序会让 xpay（小程序虚拟支付）核销语义被覆盖 = 静默资损。
    服务器端脚本有【顺序守卫】断言钉死（函数体须同时含 wechat_xpay 与 alipay）。
  · 可重复运行：已登记 applied 时 ON CONFLICT DO UPDATE，两文件均幂等。
  · 🔴 本脚本**绝不碰 /opt/dbee-gateway**（IDENT_PEPPER 地雷）：0046/0047 只动 DB，
    不 restart 服务、不 reload nginx、不需要 JWT_SECRET。
    🔴🔴 也**绝不跑 deploy/deploy-gateway.sh**（缺 IDENT_PEPPER → 全站身份永久失效）。

用法（在项目根执行）：
    python tools/apply-app-payment-settlement-prod.py --check   # 🔴 只读预检，不备份不应用
    python tools/apply-app-payment-settlement-prod.py           # 备份 → 应用 → 断言

退出码：0 = 全部断言通过；1 = 有失败项；2 = 前置条件不满足（未连库/缺文件）。
"""
import os
import re
import sys

import paramiko

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SQL_46 = "0046-wechat-xpay-settlement.sql"
SQL_47 = "0047-app-payment-settlement.sql"
SH_NAME = "server-apply-0046-0047.sh"
REMOTE_DIR = "/tmp/dbee-mig"


def load_env():
    env = {}
    path = os.path.join(ROOT, ".env")
    if not os.path.isfile(path):
        return env
    with open(path, encoding="utf-8", errors="ignore") as f:
        for line in f:
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line.strip())
            if m:
                env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return env


def redact(text):
    """兜底过滤：万一将来有人误加 echo，这里拦掉明显的凭据形态。"""
    text = re.sub(r"eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}",
                  "<jwt-redacted>", text)
    text = re.sub(r"wbpk_[A-Za-z0-9_]{10,}", "<access-key-redacted>", text)
    text = re.sub(r"\b[0-9a-f]{32}\b", "<32hex-redacted>", text)
    # 🔴 本批新增：ALIPAY_PRIVATE_KEY / WECHAT_PAY_PRIVATE_KEY 是 PKCS8 PEM，
    #    若被误 echo 会以 BEGIN ... PRIVATE KEY 形态出现 → 整段抹掉。
    text = re.sub(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
                  "<pem-private-key-redacted>", text)
    return text


def main():
    check_only = "--check" in sys.argv[1:]

    env = load_env()
    host = env.get("DBEE_HOST") or env.get("IP")
    # 🔴 SSH 用户是 USER（ubuntu），不是 DBEE_USER（dbee_app = PG 角色）；
    #    端口走默认 22，绝不用 DBEE_PORT（那是 PostgreSQL 的 5432）。
    user = env.get("USER")
    pwd = env.get("SSH_PWD")
    if not (host and user and pwd):
        print("✗ .env 缺 DBEE_HOST/USER/SSH_PWD，无法连接生产")
        return 2

    sql46 = os.path.join(ROOT, "db", "migrations", SQL_46)
    sql47 = os.path.join(ROOT, "db", "migrations", SQL_47)
    sh_path = os.path.join(ROOT, "tools", SH_NAME)
    for p in (sql46, sql47, sh_path):
        if not os.path.isfile(p):
            print(f"✗ 缺文件 {p}")
            return 2

    # 上传内容统一 LF（服务器端脚本会用 grep -qU $'\r' 拒绝 CRLF）
    payloads = {}
    for name, path in ((SQL_46, sql46), (SQL_47, sql47), (SH_NAME, sh_path)):
        with open(path, "rb") as f:
            data = f.read().replace(b"\r\n", b"\n")
        if b"\r" in data:
            print(f"✗ {name} 含 CR 字符，拒绝上传")
            return 2
        payloads[name] = data

    # 🔴 上传前静态自检：与服务器端脚本的守卫同口径，提前拦住必然失败的情况
    m47_text = payloads[SQL_47].decode("utf-8", errors="replace")
    if "IN ('wechat_xpay', 'wechat', 'alipay')" not in m47_text:
        print(f"✗ {SQL_47} 未含三 provider 超集分支 —— 文件版本异常，拒绝上传")
        return 2
    for name in (SQL_46, SQL_47):
        t = payloads[name].decode("utf-8", errors="replace")
        body = "\n".join(ln for ln in t.splitlines() if not ln.strip().startswith("--"))
        if re.search(r"DROP\s+TABLE|TRUNCATE", body, re.I):
            print(f"✗ {name} 含 DROP TABLE / TRUNCATE —— 与「只增不减」定位矛盾，拒绝上传")
            return 2
        if not (re.search(r"^BEGIN;", t, re.M) and re.search(r"^COMMIT;", t, re.M)):
            print(f"✗ {name} 缺 BEGIN;/COMMIT; 事务边界，拒绝上传")
            return 2
    print("✓ 上传前静态自检通过（三 provider 超集 / 无破坏性语句 / 事务边界齐备）")

    print(f"· 目标：{user}@{host}:22  库：dbee")
    print(f"· 上传：{SQL_46}（{len(payloads[SQL_46])} B）、"
          f"{SQL_47}（{len(payloads[SQL_47])} B）、{SH_NAME}（{len(payloads[SH_NAME])} B）")
    if check_only:
        print("· 模式：--check 只读预检（不备份、不应用、不写库）")
    else:
        print("· 模式：备份 → 应用 0046 → 应用 0047 → 幂等复验 → 断言（含四组守卫）")
    print()

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(host, username=user, password=pwd, timeout=30,
                banner_timeout=30, auth_timeout=30)
    tr = cli.get_transport()
    if tr:
        tr.set_keepalive(30)
    try:
        # 🔴 目录必须 755、文件必须 644（postgres 身份读 /tmp/dbee-mig/*.sql）
        _, out, _ = cli.exec_command(
            f"mkdir -p {REMOTE_DIR} && chmod 755 {REMOTE_DIR} && echo ok", timeout=30)
        if out.read().decode().strip() != "ok":
            print(f"✗ 无法创建 {REMOTE_DIR}")
            return 2

        sftp = cli.open_sftp()
        for name, data in payloads.items():
            remote = f"{REMOTE_DIR}/{name}"
            with sftp.open(remote, "wb") as fh:
                fh.write(data)
            sftp.chmod(remote, 0o644)
        sftp.close()
        print("✓ 已上传（LF，权限 644）\n")

        P = "sudo -n -u postgres psql -d dbee -tA"
        if check_only:
            # 只读预检：连通性、sudo 免密、PG 版本、0046/0047 登记状态、目标表是否已存在。
            # 全部是 SELECT / 查系统目录，零写操作。
            cmd = (
                f"cd {REMOTE_DIR} && "
                "echo '── 只读预检（零写操作）──' && "
                "echo -n 'sudo 免密: ' && (sudo -n true 2>/dev/null && echo yes || echo NO) && "
                "echo -n 'PG 版本: ' && " + P + " -c \"SELECT version();\" 2>&1 | head -1 && "
                "echo -n '迁移水位 max(version): ' && " + P +
                " -c \"SELECT max(version)||' / 共 '||count(*)||' 行' FROM public.schema_migrations;\" 2>&1 | head -1 && "
                "echo -n '0046 登记状态: ' && " + P +
                " -c \"SELECT coalesce(status,'<未登记>') FROM public.schema_migrations WHERE version='0046';\" 2>&1 | head -1 && "
                "echo -n '0047 登记状态: ' && " + P +
                " -c \"SELECT coalesce(status,'<未登记>') FROM public.schema_migrations WHERE version='0047';\" 2>&1 | head -1 && "
                "echo -n 'xpay_transactions 表: ' && " + P +
                " -c \"SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_name='xpay_transactions';\" 2>&1 | head -1 && "
                "echo -n 'app_payment_transactions 表: ' && " + P +
                " -c \"SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_name='app_payment_transactions';\" 2>&1 | head -1 && "
                "echo -n '三档价（应 1800/12800/29800）: ' && " + P +
                " -c \"SELECT string_agg(amount_cents::text,'/' ORDER BY id) FROM public.payment_products;\" 2>&1 | head -1 && "
                "echo -n '备份目录可写: ' && (sudo -n mkdir -p /var/backups/dbee && echo yes || echo NO) && "
                "echo -n 'apppay 端点现状（应 404，B3 后变 503）: ' && "
                "curl -sS -o /dev/null -w 'HTTP %{http_code}' --max-time 15 "
                "-X POST -H 'Content-Type: application/json' -d '{}' "
                "https://d-bee.cn/.cloud/payment/apppay/prepay 2>&1 | head -c 60"
            )
        else:
            cmd = f"cd {REMOTE_DIR} && MIG_DIR={REMOTE_DIR} bash {SH_NAME}"

        _, out, err = cli.exec_command(cmd, timeout=900)
        text = out.read().decode("utf-8", errors="replace")
        etext = err.read().decode("utf-8", errors="replace")
        code = out.channel.recv_exit_status()

        print(redact(text).strip())
        if etext.strip():
            print("\n[stderr 摘要]", redact(etext).strip()[:600])
        print(f"\n远端退出码: {code}")

        if check_only:
            return 0 if code == 0 else 1

        if code == 0 and "FAIL=0" in text:
            print("✅ 0046 + 0047 生产应用 + 幂等 + 全部断言通过")
            print("   🔴 覆盖范围（不得越界宣称）：只保证 DB 结构与权限就位。")
            print("      ❌ 未部署网关（B3）→ 端点仍 404；❌ 未配 env（B8）；")
            print("      ❌ 未重打 vc32（B9）；❌ 未做 settle_app_payment 运行时行为探针（B10）。")
            print("   下一步：B3 手术式部署 apppay.mjs + config.mjs + app.mjs（三文件同批）")
            print("           判据 = 端点从 404 变 503（未配 env 时的 notConfigured 语义）")
            return 0
        print("❌ 未全部通过（见上方 ✗ 行）")
        print("   排查顺序：① 顺序守卫三项（是否倒序应用）② 权限守卫（既有 GRANT 覆盖）")
        print("             ③ RLS 守卫（FORCE 是否被误改）④ 回归守卫（既有对象被破坏）")
        print("   回滚：见上方输出里的 pg_restore 命令（备份已生成并验过 TOC）")
        return 1
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
