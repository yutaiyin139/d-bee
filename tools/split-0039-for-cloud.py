#!/usr/bin/env python3
"""从 db/migrations/0039-rpc-trust-boundary.sql 提取需要补到云库的语句，
拆成「单语句文件」供 MCP db_exec_sql（mode=migrate，单次不支持多语句）逐条执行。

云库适配说明（与自建库 0039 的差异，逐条有据）：
  · 跳过 (g) llm_gate —— 云库无 dbee_app 角色（实测 has_dbee_app=0），且云侧 LLM
    由 WorkBuddy 平台代理、不走本项目网关；建了也没人调用，反而留一个死函数。
  · 跳过 (h) schema_migrations 登记 —— 云库无该表（实测 has_schema_migrations=false，
    0034 未应用），0039 原文有 to_regclass 守卫会自动跳过，这里直接不生成。
  · 跳过 ALTER TABLE 加 llm_used_at —— 已于本次补丁前单独执行完成（幂等 IF NOT EXISTS）。
  · 跳过 NOTIFY pgrst —— 云库 PostgREST 由平台托管，客户端无法直发 NOTIFY；
    平台侧 schema cache 会自动刷新。
  · 函数体一字不改：云库函数签名已与 0039 完全一致（实测
    pg_get_function_identity_arguments 逐个比对通过），前端 callRpc 参数名不变。

⚠️ 切分纪律（首版踩过两个坑，都已修）：
  1. 语句前常挂着 `-- ═══` 分节注释头，**不能因为 startswith('--') 就整条丢弃**
     （首版因此只切出 2/7 个 CREATE FUNCTION）。正确做法是先剥注释头再判空。
  2. `$fn$ ... $fn$` 之间的分号是函数体内的，**不能当成语句结束**；
     必须按 dollar-quote 出现次数奇偶翻转 in_dollar 状态。
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "db/migrations/0039-rpc-trust-boundary.sql"
OUT = ROOT / "db/cloud-patch-0039"

# 只取 (a)~(f) 段：从第一个 CREATE OR REPLACE 到 (g) 段标题之前
DOLLAR_RE = re.compile(r"\$[A-Za-z_]*\$")


def split_statements(body: str) -> list[str]:
    """按顶层分号切分，dollar-quote 内的分号不算。"""
    statements: list[str] = []
    buf: list[str] = []
    in_dollar = False
    for line in body.splitlines():
        n = len(DOLLAR_RE.findall(line))
        if n % 2 == 1:
            in_dollar = not in_dollar
        buf.append(line)
        if not in_dollar and line.rstrip().endswith(";"):
            statements.append("\n".join(buf))
            buf = []
    if buf:
        tail = "\n".join(buf).strip()
        if tail:
            statements.append(tail)
    return statements


def strip_comments(stmt: str) -> str:
    """剥掉悬挂的注释头/空行，返回真实语句；若整条都是注释则返回空串。"""
    lines = stmt.splitlines()
    while lines and (not lines[0].strip() or lines[0].strip().startswith("--")):
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def main() -> int:
    text = SRC.read_text(encoding="utf-8")
    start = text.index("CREATE OR REPLACE FUNCTION public.grant_honey(")
    end = text.index("-- (g) llm_gate")
    body = text[start:end]

    clean: list[str] = []
    for raw in split_statements(body):
        stmt = strip_comments(raw)
        if not stmt:
            continue
        core = stmt.upper().rstrip(";").strip()
        # 云库单语句执行不需要显式事务包裹
        if core in ("BEGIN", "COMMIT"):
            continue
        clean.append(stmt)

    # 清空旧产物，避免上一次跑残留的文件被误当成补丁
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.sql"):
        old.unlink()

    for i, s in enumerate(clean, 1):
        (OUT / f"{i:02d}.sql").write_text(s + "\n", encoding="utf-8", newline="\n")
        print(f"{i:02d}.sql  {len(s):5d}B  {s.splitlines()[0][:72]}")

    # 自检：7 个 CREATE + 12 个 REVOKE/GRANT（6 个函数 × 2）= 19 条
    n_create = sum(1 for s in clean if s.upper().startswith("CREATE OR REPLACE"))
    n_grant = sum(1 for s in clean if s.upper().startswith(("REVOKE", "GRANT")))
    print(f"\n共 {len(clean)} 条 -> {OUT}")
    print(f"  CREATE OR REPLACE = {n_create}（期望 6：grant_honey/grant_photo_bonus/"
          f"consume_ai_quota/consume_photo_quota/get_photo_quota/redeem_honey/settle_invite_checkin 共 7 个，"
          f"其中 settle_invite_checkin 也在内 → 期望 7）")
    print(f"  REVOKE/GRANT      = {n_grant}（期望 14：7 个函数 × 2）")
    if n_create != 7 or n_grant != 14:
        print("  🔴 数量不符，切分逻辑有问题，请勿执行补丁！")
        return 1
    print("  ✅ 数量校验通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
