"""【纯只读】探测两套 SSH 身份对生产网关 env 的操作能力。

背景：.env 里存在两套互不相同的身份 ——
  · USER=ubuntu      + SSH_PWD  （apply-llm-thinking-fix.py 用，注释称 sudo -n 免密已验证）
  · DBEE_USER=dbee_app + DBEE_PWD（dbee-ssh.py / deploy.sh 用）
两个密码不是同一把。手术式改 /etc/dbee/gateway.env（0640 root:dbee）之前，
必须确定用哪个身份：既要能读、又要能写、还要能 systemctl restart。

探测项（全部只读，不改任何文件、不重启任何服务）：
  ① 能否 SSH 登录
  ② id（用户与所属组，判断是否在 dbee 组 → 可能免 sudo 直读 env）
  ③ sudo -n true 是否免密可用
  ④ 直读 /etc/dbee/gateway.env 是否成功（不带 sudo）
  ⑤ sudo cat 该文件是否成功（密码走 stdin）
  ⑥ 该文件属主/权限（确认改写方式）
  ⑦ systemctl 是否可管 dbee-gateway

安全口径：密码走 stdin 不进命令行；stdout 不输出任何密钥/密码明文。
凭据全部从项目根 .env 读取（DBEE_HOST / USER / SSH_PWD / DBEE_USER / DBEE_PWD），
故直接 `python deploy/probe-ssh-identities.py` 即可，无需在命令行传密码。
"""
from __future__ import annotations

import os
import re
import sys

import paramiko

ENV_FILE = "/etc/dbee/gateway.env"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


# 全部凭据从 .env 读，不走命令行/环境变量：
# ① 密码含 @ 等特殊字符，写进命令行易破引号且留 ps 痕迹
# ② Windows Git Bash 的 /tmp 与 Python 视图不互通，中转文件不可靠
_DOT = load_env(os.path.join(REPO, ".env"))
HOST = _DOT.get("DBEE_HOST") or os.environ.get("DBEE_HOST", "")
if not HOST:
    print("[x] .env 缺 DBEE_HOST")
    sys.exit(2)


def run(c, cmd: str, pwd: str | None = None, timeout: int = 25) -> tuple[int, str, str]:
    _i, o, e = c.exec_command(cmd, timeout=timeout)
    if pwd is not None:
        _i.write(pwd + "\n")
        _i.flush()
    out = o.read().decode("utf-8", "replace").strip()
    err = e.read().decode("utf-8", "replace").strip()
    rc = o.channel.recv_exit_status()
    return rc, out, err


def probe(label: str, user: str, pwd: str | None) -> dict:
    print(f"\n{'═' * 66}\n身份：{label}  ({user}@{HOST})\n{'═' * 66}")
    res = {"label": label, "user": user, "ok": False}
    if not pwd:
        print("  [x] 密码为空，跳过")
        return res
    try:
        c = paramiko.SSHClient()
        c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        c.connect(HOST, username=user, password=pwd, timeout=25,
                  banner_timeout=25, auth_timeout=25)
    except Exception as exc:  # noqa: BLE001
        print(f"  ① SSH 登录  : 失败 —— {type(exc).__name__}: {str(exc)[:120]}")
        return res
    print("  ① SSH 登录  : OK")
    res["ok"] = True
    try:
        rc, out, _ = run(c, "id")
        print(f"  ② id        : {out}")
        res["groups"] = out
        in_dbee = bool(re.search(r"\bdbee\b", out))
        res["in_dbee_group"] = in_dbee

        rc, out, err = run(c, "sudo -n true")
        print(f"  ③ sudo -n   : {'免密可用 OK' if rc == 0 else f'不可用 (rc={rc}) {err[:80]}'}")
        res["sudo_nopasswd"] = rc == 0

        rc, out, _ = run(c, f"test -r {ENV_FILE} && echo READABLE || echo NO")
        print(f"  ④ 直读 env  : {out}  (不带 sudo)")
        res["direct_read"] = out == "READABLE"

        rc, out, err = run(c, f"sudo -S -p '' cat {ENV_FILE} | wc -l", pwd)
        n = out.strip() if rc == 0 else f"失败 rc={rc}"
        print(f"  ⑤ sudo cat  : {n}"
              + ("" if rc == 0 else f"  err={err[:80]}"))
        res["sudo_read"] = rc == 0

        rc, out, _ = run(c, f"sudo -S -p '' stat -c 'owner=%U:%G perm=%a size=%s' {ENV_FILE}", pwd)
        print(f"  ⑥ env 属性  : {out if rc == 0 else f'读取失败 rc={rc}'}")
        res["env_stat"] = out if rc == 0 else ""

        rc, out, _ = run(c, "systemctl is-active dbee-gateway")
        print(f"  ⑦ 网关状态  : is-active={out}")
        res["gw_active"] = out
    finally:
        c.close()
    return res


def main() -> int:
    results = [
        probe("ubuntu（apply-*.py 惯用）", _DOT.get("USER", "ubuntu"),
              _DOT.get("SSH_PWD")),
        probe("dbee_app（deploy.sh / 用户所给密码）",
              _DOT.get("DBEE_USER", "dbee_app"), _DOT.get("DBEE_PWD")),
    ]

    print(f"\n{'═' * 66}\n结论\n{'═' * 66}")
    usable = [r for r in results
              if r["ok"] and (r.get("sudo_read") or r.get("direct_read"))]
    for r in results:
        tag = "可用" if r in usable else "不可用"
        print(f"  {r['label']:38s} {tag}"
              f"  sudo_nopasswd={r.get('sudo_nopasswd', False)}"
              f"  in_dbee_group={r.get('in_dbee_group', False)}")
    if not usable:
        print("  [x] 两个身份都读不到生产 env —— 不要动手，先排查权限")
        return 1
    # 优选 sudo -n 免密的（脚本最简、最不易卡在密码提示）
    pick = next((r for r in usable if r.get("sudo_nopasswd")), usable[0])
    print(f"\n  → 建议用「{pick['label']}」执行手术式更新"
          f"（sudo -n 免密={'是' if pick.get('sudo_nopasswd') else '否，需 sudo -S 喂密码'}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
