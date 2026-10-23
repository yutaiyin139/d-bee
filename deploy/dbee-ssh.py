"""D-Bee 部署用 SSH/SFTP 执行器。

凭据从环境变量读取，不落盘到项目里：
  DBEE_HOST / DBEE_USER / DBEE_PWD

用法：
  python dbee.py render <模板> <输出>          # 【本地操作，不连服务器】替换占位符生成文件
  python dbee.py run    <本地脚本>             # 上传到 /tmp 执行（占位符会被替换）
  python dbee.py putdir <本地目录> <远端目录>   # 递归上传目录内容
  python dbee.py putfile <本地文件> <远端文件>  # 上传单个【文本】文件（\r\n→\n 换行归一）
  python dbee.py putbin  <本地文件> <远端文件>  # 上传单个【二进制】文件（不做任何换行替换）

占位符替换表（值来自环境变量）：
  __SUDO_PWD__    -> DBEE_PWD
  __SITE_ORIGIN__ -> DBEE_SITE_ORIGIN   （站点对外来源，如 https://dbee.example.com）
  __SERVER_NAME__ -> DBEE_SERVER_NAME   （nginx server_name，如 dbee.example.com 1.2.3.4 _）
  __DOMAIN__      -> DBEE_DOMAIN
  __EMAIL__       -> DBEE_CERT_EMAIL
  __WEBAPP_KEY__  -> DBEE_WEBAPP_KEY   （自测用 publishableKey，由 deploy.sh 从 src/cloudConfig.ts 自动提取）
  __JWT_SECRET__  -> DBEE_JWT_SECRET   （网关与 PostgREST 必须共用的 HS256 密钥，见 deploy-postgrest.sh）
"""
import os
import posixpath
import stat
import sys
import uuid

import paramiko

HOST = os.environ["DBEE_HOST"]
USER = os.environ["DBEE_USER"]
PWD = os.environ["DBEE_PWD"]

PLACEHOLDER = "__SUDO_PWD__"

# 渲染用占位符表。长键在前，避免 __DOMAIN__ 误伤 __DOMAIN_XX__ 之类（当前无此情况，留作保险）。
SUBS = {
    PLACEHOLDER: PWD,
    "__SITE_ORIGIN__": os.environ.get("DBEE_SITE_ORIGIN", ""),
    "__SERVER_NAME__": os.environ.get("DBEE_SERVER_NAME", "_"),
    "__DOMAIN__": os.environ.get("DBEE_DOMAIN", ""),
    "__EMAIL__": os.environ.get("DBEE_CERT_EMAIL", ""),
    "__WEBAPP_KEY__": os.environ.get("DBEE_WEBAPP_KEY", ""),
    # 网关与 PostgREST 必须共用同一个 HS256 密钥，否则网关签发的 JWT
    # 在 PostgREST 侧验签失败（症状：数据面全部 401）。由 deploy-postgrest.sh 传入。
    "__JWT_SECRET__": os.environ.get("DBEE_JWT_SECRET", ""),
}


def render_text(text):
    for key in sorted(SUBS, key=len, reverse=True):
        text = text.replace(key, SUBS[key])
    return text


def render_file(template, out):
    """本地渲染模板 -> 输出文件（LF 换行，避免 Windows CRLF 进 nginx 报错）。"""
    with open(template, "r", encoding="utf-8") as f:
        body = render_text(f.read())
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)
    left = [k for k in SUBS if k in body]
    print(f"[渲染] {os.path.basename(template)} -> {out}")
    if left:
        print(f"  !! 仍有未替换占位符: {left}")
    return 0


def connect():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PWD, timeout=30, banner_timeout=30, auth_timeout=30)
    # 长任务（npm install / 下载 tarball / pg_dump）期间连接上可能几分钟没有数据，
    # 中途的 NAT/防火墙会把静默连接判死并 RST（本机侧表现为 10054）。
    # 每 30 秒发一个 keepalive 包，实测能显著减少这类断连。
    c.get_transport().set_keepalive(30)
    return c


def run_script(client, path):
    with open(path, "r", encoding="utf-8") as f:
        body = render_text(f.read())
    remote = f"/tmp/dbee-{uuid.uuid4().hex[:8]}.sh"
    sftp = client.open_sftp()
    with sftp.file(remote, "w") as fh:
        fh.write(body)
    sftp.chmod(remote, 0o700)
    sftp.close()

    stdin, stdout, stderr = client.exec_command(f"bash {remote}", timeout=1800)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()

    # 🔴 先输出结果，再清理远端临时文件。
    # 顺序反了的后果已实测踩过：清理用的 open_sftp() 一旦赶上连接被重置
    # （Windows 侧报 10054），异常会直接冒泡，下面几行 write 永远执行不到 ——
    # 远端脚本其实跑完了、输出也已在内存里，却一个字都看不见，
    # 只能重新连上去猜它到底执行到哪一步。
    sys.stdout.write(out)
    if err.strip():
        sys.stdout.write("\n--- stderr ---\n" + err)
    print(f"\n[exit {code}]")

    # 清理是尽力而为：失败只提示，不影响已经拿到的结果与退出码
    try:
        sftp = client.open_sftp()
        try:
            sftp.remove(remote)
        except OSError:
            pass
        sftp.close()
    except Exception as e:  # noqa: BLE001 — 连接已断等任何情况都不该掩盖结果
        print(f"[warn] 远端临时脚本 {remote} 未能清理（{e}），可手工 rm", file=sys.stderr)

    return 0 if code == 0 else 1


def mkdirs(sftp, remote_dir):
    parts = [p for p in remote_dir.split("/") if p]
    cur = ""
    for p in parts:
        cur += "/" + p
        try:
            sftp.stat(cur)
        except IOError:
            try:
                sftp.mkdir(cur)
            except IOError:
                pass


def put_dir(client, local_dir, remote_dir):
    sftp = client.open_sftp()
    mkdirs(sftp, remote_dir)
    count = 0
    total = 0
    for root, _dirs, files in os.walk(local_dir):
        rel = os.path.relpath(root, local_dir)
        target = remote_dir if rel == "." else posixpath.join(remote_dir, rel.replace(os.sep, "/"))
        mkdirs(sftp, target)
        for name in files:
            lp = os.path.join(root, name)
            rp = posixpath.join(target, name)
            sftp.put(lp, rp)
            mode = 0o644
            try:
                if os.stat(lp).st_mode & stat.S_IXUSR:
                    mode = 0o755
            except OSError:
                pass
            try:
                sftp.chmod(rp, mode)
            except IOError:
                pass
            count += 1
            total += os.path.getsize(lp)
            print(f"  ↑ {posixpath.join(rel.replace(os.sep, '/'), name) if rel != '.' else name}")
    sftp.close()
    print(f"[上传完成] {count} 个文件, {total / 1024:.1f} KB -> {remote_dir}")
    return 0


def put_file(client, local_path, remote_path):
    """上传单个【文本】文件（\\r\\n→\\n 换行归一，供 nginx 等直接消费）。"""
    sftp = client.open_sftp()
    with open(local_path, "rb") as fh:
        data = fh.read().replace(b"\r\n", b"\n")
    parent = posixpath.dirname(remote_path)
    if parent:
        mkdirs(sftp, parent)
    with sftp.file(remote_path, "wb") as fh:
        fh.write(data)
    sftp.chmod(remote_path, 0o600)
    sftp.close()
    print(f"[上传] {local_path} -> {remote_path} ({len(data)} B)")
    return 0


def put_bin(client, local_path, remote_path):
    """上传单个【二进制】文件 —— 原样字节，绝不做换行替换。

    与 put_file 的唯一区别就是那一步 replace：文本配置要归一成 LF，
    但二进制（如 postgrest 的 tar.xz）一旦被 \\r\\n→\\n 处理就会损坏，
    sha256 校验必然失败。故为二进制单独开这个入口。
    """
    sftp = client.open_sftp()
    with open(local_path, "rb") as fh:
        data = fh.read()  # 原样读入，不动一个字节
    parent = posixpath.dirname(remote_path)
    if parent:
        mkdirs(sftp, parent)
    with sftp.file(remote_path, "wb") as fh:
        fh.write(data)
    sftp.chmod(remote_path, 0o600)
    sftp.close()
    print(f"[上传·二进制] {local_path} -> {remote_path} ({len(data)} B)")
    return 0


def main():
    action = sys.argv[1]
    # render 是纯本地操作，不需要连服务器
    if action == "render":
        return render_file(sys.argv[2], sys.argv[3])
    client = connect()
    try:
        if action == "run":
            return run_script(client, sys.argv[2])
        if action == "putdir":
            return put_dir(client, sys.argv[2], sys.argv[3])
        if action == "putfile":
            return put_file(client, sys.argv[2], sys.argv[3])
        if action == "putbin":
            return put_bin(client, sys.argv[2], sys.argv[3])
        print("unknown action", file=sys.stderr)
        return 2
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
