#!/usr/bin/env python3
"""把服务器最新的 dbee 库备份拉回本地做异地副本，并校验 sha256。

背景（2026-11-05）：数据面权威源已是**服务器自建 PostgreSQL `dbee`**（web 端
endpoint 取 window.location.origin → nginx `/.cloud/` → 自建网关 → PG，已由
`/.cloud/healthz` 返回 `database:"dbee"` 实证）。服务器侧 cron 每日 03:30 跑
`/usr/local/bin/dbee-backup.sh`（pg_dump -Fc + TOC 验证 + 滚动保留）。

但那份备份**和数据库在同一台机器** —— 机器挂了备份跟着没，等于没有异地副本。
本脚本补这一环：拉最新 dump 到本地 `db/backups/offsite/`，并用服务器
`SHA256SUMS` 逐字节校验（传输损坏 / 拉到一半断线都能当场发现）。

用法：
    python deploy/pull-latest-backup.py            # 拉最新一份
    python deploy/pull-latest-backup.py --all-daily  # 拉全部 daily（首次建副本用）

凭据：环境变量 DBEE_HOST / DBEE_USER / DBEE_PWD（与 dbee-ssh.py 同一套）。
    set -a && . ./.env && set +a && export DBEE_USER="$USER" DBEE_PWD="$SSH_PWD"
    🔴 `.env` 里的 DBEE_USER=dbee_app / DBEE_PWD 是**过时值，SSH 认证会失败**；
       必须用 USER=ubuntu + SSH_PWD（见 MEMORY「部署侧坑」）。

产物落在 db/backups/offsite/（已被 .gitignore 的 db/backups/ 覆盖，不入库）。
🔴 该目录含真实健康档案（PIPL 敏感个人信息），**严禁**移出项目目录或提交进 git。

退出码：0 成功（含"已是最新、无需拉"）；1 失败；2 参数错。
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
SSH = HERE / "dbee-ssh.py"
REMOTE_DIR = "/var/backups/dbee"
LOCAL_DIR = PROJECT / "db" / "backups" / "offsite"
DUMP_RE = re.compile(r"^dbee-(daily|weekly|monthly)-\d{8}-\d{6}\.dump$")


def die(msg: str, code: int = 1) -> "NoReturn":  # noqa: F821
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(code)


def ssh_run(script_body: str) -> str:
    """在服务器跑一段【只读】脚本并返回 stdout。凭据不进命令行（走 dbee-ssh.py 的 render）。"""
    tmp = Path("/tmp") / f"dbee-pullq-{os.getpid()}.sh"
    tmp.write_text(script_body, encoding="utf-8", newline="\n")
    try:
        proc = subprocess.run(
            [sys.executable, str(SSH), "run", str(tmp)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900,
        )
    finally:
        tmp.unlink(missing_ok=True)
    if proc.returncode != 0:
        die(f"远端探测失败 exit={proc.returncode}\n{proc.stdout}\n{proc.stderr}")
    # dbee-ssh.py 末尾会打 "[exit N]"，去掉
    return re.sub(r"\n\[exit \d+\]\s*$", "", proc.stdout)


def remote_inventory() -> tuple[dict[str, str], dict[str, str]]:
    """返回 ({文件名: sha256}, {文件名: 字节数})，取自服务器 SHA256SUMS 与 ls -l。"""
    out = ssh_run(
        "#!/usr/bin/env bash\n"
        "SUDO_PWD='__SUDO_PWD__'\n"
        "S() { echo \"$SUDO_PWD\" | sudo -S \"$@\" 2>/dev/null; }\n"
        f"echo '---SUMS---'; S cat {REMOTE_DIR}/SHA256SUMS\n"
        f"echo '---LIST---'; S ls -l {REMOTE_DIR}/\n"
    )
    sums: dict[str, str] = {}
    sizes: dict[str, str] = {}
    section = None
    for line in out.splitlines():
        if line.startswith("---SUMS---"):
            section = "sums"
            continue
        if line.startswith("---LIST---"):
            section = "list"
            continue
        if section == "sums":
            parts = line.split()
            if len(parts) >= 2 and len(parts[0]) == 64:
                sums[parts[1]] = parts[0]
        elif section == "list":
            parts = line.split()
            # -rw-r----- 1 root postgres 171000 ... dbee-daily-....dump
            if len(parts) >= 9 and parts[-1].endswith(".dump"):
                sizes[parts[-1]] = parts[4]
    if not sums:
        die(f"服务器 {REMOTE_DIR}/SHA256SUMS 读不到内容（备份体系可能未安装）")
    return sums, sizes


def _ts_of(name: str) -> str:
    """从 dbee-{daily,weekly,monthly}-YYYYMMDD-HHMMSS.dump 取时间戳用于排序。

    🔴 不能直接 sort() 文件名：字母序是 daily < monthly < weekly，
    「最新」会永远选到 weekly/monthly 而不是真正最近那份（已实测踩过）。
    """
    m = re.search(r"-(\d{8})-(\d{6})\.dump$", name)
    return (m.group(1) + m.group(2)) if m else ""


def pick_targets(sums: dict[str, str], want_all_daily: bool) -> list[str]:
    names = [n for n in sums if DUMP_RE.match(n) and _ts_of(n)]
    if not names:
        die("服务器上没有符合命名规范的 dump（dbee-{daily,weekly,monthly}-TS.dump）")
    names.sort(key=_ts_of)  # 按备份时间排序，不是按字母序
    if want_all_daily:
        return sorted((n for n in names if n.startswith("dbee-daily-")), key=_ts_of)
    return [names[-1]]


def pull(name: str, expected_sha: str, expected_size: str) -> bool:
    dest = LOCAL_DIR / name
    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    print(f"  ↓ {REMOTE_DIR}/{name}")
    proc = subprocess.run(
        [sys.executable, str(SSH), "getsudo", f"{REMOTE_DIR}/{name}", str(dest)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1800,
    )
    if proc.returncode != 0 or not dest.exists():
        print(f"    ✗ 拉取失败：{proc.stdout.strip()} {proc.stderr.strip()}")
        dest.unlink(missing_ok=True)
        return False

    actual_size = dest.stat().st_size
    if expected_size and str(actual_size) != expected_size:
        print(f"    ✗ 大小不符：远端 {expected_size} B vs 本地 {actual_size} B")
        dest.unlink(missing_ok=True)
        return False

    sha = hashlib.sha256(dest.read_bytes()).hexdigest()
    if sha != expected_sha:
        print(f"    ✗ sha256 不符（传输损坏）：\n      远端 {expected_sha}\n      本地 {sha}")
        dest.unlink(missing_ok=True)
        return False

    print(f"    ✅ {actual_size / 1024:.1f} KB，sha256 校验通过")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all-daily", action="store_true", help="拉全部 daily（首次建副本）")
    args = ap.parse_args()

    for key in ("DBEE_HOST", "DBEE_USER", "DBEE_PWD"):
        if not os.environ.get(key):
            die(f"缺环境变量 {key}（先 set -a && . ./.env && set +a && "
                f'export DBEE_USER="$USER" DBEE_PWD="$SSH_PWD"）')

    sums, sizes = remote_inventory()
    targets = pick_targets(sums, args.all_daily)
    print(f"服务器备份 {len(sums)} 份，本次拉 {len(targets)} 份 → {LOCAL_DIR.relative_to(PROJECT)}/")

    ok, skipped = [], []
    for name in targets:
        local = LOCAL_DIR / name
        if local.exists() and hashlib.sha256(local.read_bytes()).hexdigest() == sums[name]:
            print(f"  = {name} 本地已有且 sha256 一致，跳过")
            skipped.append(name)
            continue
        if pull(name, sums[name], sizes.get(name, "")):
            ok.append(name)

    failed = [n for n in targets if n not in ok and n not in skipped]
    print(f"\n结果：新拉 {len(ok)} 份 / 已最新 {len(skipped)} 份 / 失败 {len(failed)} 份")
    if failed:
        print("失败清单：" + ", ".join(failed), file=sys.stderr)
        return 1

    kept = sorted((p.name for p in LOCAL_DIR.glob("dbee-*.dump")), key=_ts_of)
    print(f"本地异地副本存量 {len(kept)} 份，最新：" + (kept[-1] if kept else "（空）"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
