#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# run-migration-audit.sh · 本地入口：上传迁移清单 + 跑服务器端三类探针
# ═══════════════════════════════════════════════════════════════════════
# 用法：
#   DBEE_HOST=150.158.51.106 DBEE_USER=ubuntu DBEE_PWD='密码' \
#     bash deploy/run-migration-audit.sh
#
# 做三件事：
#   ① 现算本地 db/migrations/*.sql 的 sha256，生成 TSV 清单
#      （version<TAB>name<TAB>sha256），上传到 /tmp/dbee-migration-manifest.tsv
#      —— 供服务器端脚本与库内 schema_migrations.checksum 比对，
#         报「已应用的迁移文件被改动过」。
#   ② 本地渲染 tools/migration-audit.sh（替换 __SUDO_PWD__）后上传执行
#      （三类探针：存在性 / 版本性 / 可利用性）。
#   ③ 如实返回服务器端退出码（0=全绿，1=有 ✗），可直接当部署门禁。
#
# 为什么清单要**现算**而不是入库一份：
#   入库的清单会和迁移文件一样过期（正是 0016/0026/0027 静默失效的同类病根：
#   「文档说生效了」≠「库里生效了」）。现算的 sha256 永远反映本地工作树的真实
#   内容，比对结果才有意义。
#
# 为什么用 render + run 两步而不是直接 putfile：
#   dbee-ssh.py 只有 `run` 会做占位符替换（render_text），`putfile` 是原样字节上传。
#   审计脚本内含 __SUDO_PWD__（sudo -S 喂密码用），若用 putfile 上传，
#   占位符会原样留在文件里 → sudo 收到字面量 "__SUDO_PWD__" 而认证失败，
#   表现为「所有 psql 查询都返回空」，极易被误读成「对象都不存在」。
#   故先本地 render 出临时文件，再交给 run 执行。
#
# 安全：全程只读数据库（唯一的写是 ROLLBACK 事务内的越权探针，
#   owner_id 用全 0 合成值，不对应任何真实用户）。密码只经环境变量传入，不落盘。
#
# Windows/Git Bash 坑（已踩过，勿改回去）：
#   · dbee-ssh.py 是原生 Windows Python，mktemp 给的 /tmp/xxx 会被当成 C:\tmp
#     （MSYS_NO_PATHCONV=1 下不做路径转换）→ FileNotFoundError。
#   · 反过来传 C:\xxx 又被 safe-delete 判「embedded drive prefix」拒绝清理。
#   · 统一用 cygpath -m "$(mktemp)" 产出 C:/xxx 形式，两边都认。
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

: "${DBEE_HOST:?缺少 DBEE_HOST}"
: "${DBEE_USER:?缺少 DBEE_USER}"
: "${DBEE_PWD:?缺少 DBEE_PWD}"

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PY="${PY:-C:/Users/yuty/.workbuddy/binaries/python/envs/default/Scripts/python.exe}"
[ -x "$PY" ] || PY="C:/Users/yuty/.workbuddy/binaries/python/versions/3.13.12/python.exe"

AUDIT_SH="$DIR/tools/migration-audit.sh"
[ -f "$AUDIT_SH" ] || { echo "找不到审计脚本: $AUDIT_SH" >&2; exit 1; }

MANIFEST_LOCAL="$(cygpath -m "$(mktemp)")"
RENDERED="$(cygpath -m "$(mktemp)")"
trap 'rm -f "$MANIFEST_LOCAL" "$RENDERED"' EXIT

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'
export DBEE_HOST DBEE_USER DBEE_PWD

echo "==> ① 计算本地迁移文件 sha256 清单"
# version/name 从文件名拆：0016-input-bounds.sql → 0016 / input-bounds
# ⚠️ 同号两文件（0020-ai-consent / 0020-badge-weight-lost-fix）靠 name 区分，
#    与 schema_migrations 的 (version, name) 复合主键一一对应。
: > "$MANIFEST_LOCAL"
for f in "$DIR"/db/migrations/*.sql; do
  base="$(basename "$f" .sql)"
  ver="${base%%-*}"
  nm="${base#*-}"
  sha="$(sha256sum "$f" | awk '{print $1}')"
  printf '%s\t%s\t%s\n' "$ver" "$nm" "$sha" >> "$MANIFEST_LOCAL"
done
echo "    $(wc -l < "$MANIFEST_LOCAL" | tr -d ' ') 个迁移文件"

echo "==> ② 上传清单 -> /tmp/dbee-migration-manifest.tsv"
"$PY" "$DIR/deploy/dbee-ssh.py" putfile "$MANIFEST_LOCAL" /tmp/dbee-migration-manifest.tsv

echo "==> ③ 渲染审计脚本（替换 __SUDO_PWD__）"
"$PY" "$DIR/deploy/dbee-ssh.py" render "$AUDIT_SH" "$RENDERED"

echo "==> ④ 在服务器执行三类探针"
# dbee-ssh.py run 会把脚本上传到 /tmp/dbee-<随机>.sh 并以 bash 执行，
# 退出码原样返回（0=全绿，1=有 ✗）。清单由脚本自己读取，无需 chmod
# （读清单的是 ubuntu 自己的 shell，不是 postgres）。
"$PY" "$DIR/deploy/dbee-ssh.py" run "$RENDERED"
