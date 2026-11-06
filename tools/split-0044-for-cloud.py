#!/usr/bin/env python3
"""从 db/migrations/0044-redeem-code-tiers.sql 提取需要补到云库的语句，
拆成「单语句文件」供 MCP db_exec_sql（mode=migrate，单次不支持多语句）逐条执行。

为什么云库也必须打这个补丁（0039 双库铁律）：
  `redeem_by_code` 是**权益函数**。mini 端默认后端是云库
  （`mini/src/lib/backend.ts:15,47` CLOUD_HOST=zilv-mifeng.app.workbuddy.host），
  主端 web/iOS/Android 走自建库。若只改自建库，四端行为立刻**分叉**：
  主端能兑月卡/年卡、mini 端仍只发终身 —— 同一张码在两端结果不同。

云库适配说明（与自建库 0044 的差异，逐条有据，沿用 split-0039 的口径）：
  · 跳过 (c) schema_migrations 登记 —— 云库无该表（0034 未应用）。0044 原文本身
    有 to_regclass 守卫会安全跳过，这里直接不生成，省一次无意义调用。
  · 跳过 NOTIFY pgrst —— 云库 PostgREST 由平台托管，客户端无法直发 NOTIFY，
    平台侧 schema cache 会自动刷新。
  · 跳过 BEGIN / COMMIT —— MCP 单语句执行不需要显式事务包裹。
  · 函数体与约束定义**一字不改**：RPC 签名 `redeem_by_code(text)` 与返回值
    text(ok/used/bad) 必须与自建库完全一致，否则两端前端 api.ts 的
    `r === 'ok' || r === 'used' ? r : 'bad'` 判定会静默降级成 'bad'。

⚠️ 切分纪律（split-0039 首版踩过、此处沿用其修法）：
  1. 语句前常挂着 `-- ═══` 分节注释头，不能因为 startswith('--') 就整条丢弃；
     先剥注释头再判空。
  2. `$fn$ ... $fn$` 之间的分号属于函数体，不能当语句结束；
     按 dollar-quote 出现次数奇偶翻转 in_dollar 状态。
  3. 本迁移的 DO 块内部也有分号，同样靠 dollar-quote 计数保护（`$$ ... $$`）。

用法：
  python tools/split-0044-for-cloud.py
产物：
  db/cloud-patch-0044/NN.sql（按执行顺序编号；01 开头即 ALTER TABLE ADD COLUMN）
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "db/migrations/0044-redeem-code-tiers.sql"
OUT = ROOT / "db/cloud-patch-0044"

DOLLAR_RE = re.compile(r"\$[A-Za-z_]*\$")

# 提取区间：从第一条 ALTER TABLE 加列，到 (c) 段追踪表登记之前
START_MARKER = "ALTER TABLE public.redeem_codes\n  ADD COLUMN IF NOT EXISTS plan"
END_MARKER = "-- (c) 迁移追踪表登记"


def split_statements(body: str) -> list[str]:
    """按顶层分号切分；dollar-quote 内的分号不算语句边界。"""
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
    """剥掉悬挂的注释头/空行，返回真实语句；整条都是注释则返回空串。"""
    lines = stmt.splitlines()
    while lines and (not lines[0].strip() or lines[0].strip().startswith("--")):
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def main() -> int:
    text = SRC.read_text(encoding="utf-8")
    try:
        start = text.index(START_MARKER)
        end = text.index(END_MARKER)
    except ValueError as e:
        print(f"🔴 定位标记失败：{e}\n   0044 的结构变了，请先核对 START/END_MARKER。")
        return 1
    body = text[start:end]

    clean: list[str] = []
    for raw in split_statements(body):
        stmt = strip_comments(raw)
        if not stmt:
            continue
        core = stmt.upper().rstrip(";").strip()
        if core in ("BEGIN", "COMMIT"):   # 云库单语句执行无需显式事务
            continue
        clean.append(stmt)

    # 清空旧产物，避免上一次跑的残留被误当成本次补丁
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.sql"):
        old.unlink()

    for i, s in enumerate(clean, 1):
        (OUT / f"{i:02d}.sql").write_text(s + "\n", encoding="utf-8", newline="\n")
        print(f"{i:02d}.sql  {len(s):5d}B  {s.splitlines()[0][:74]}")

    # ── 数量自检 ─────────────────────────────────────────────────────
    # 期望构成：
    #   2  ALTER TABLE ADD COLUMN (plan / months)
    #   2  COMMENT ON COLUMN
    #   2  DROP CONSTRAINT IF EXISTS
    #   2  ADD CONSTRAINT
    #   1  CREATE INDEX
    #   1  CREATE OR REPLACE FUNCTION redeem_by_code
    #   1  REVOKE ALL ON FUNCTION
    #   1  GRANT EXECUTE ON FUNCTION
    #   1  ALTER TABLE ENABLE ROW LEVEL SECURITY
    #   1  REVOKE ALL ON TABLE
    #   1  COMMENT ON FUNCTION
    #  = 15
    n_create_fn = sum(1 for s in clean if s.upper().startswith("CREATE OR REPLACE FUNCTION"))
    n_alter = sum(1 for s in clean if s.upper().startswith("ALTER TABLE"))
    n_grant = sum(1 for s in clean if s.upper().startswith(("REVOKE", "GRANT")))
    n_comment = sum(1 for s in clean if s.upper().startswith("COMMENT ON"))
    n_index = sum(1 for s in clean if s.upper().startswith("CREATE INDEX"))

    print(f"\n共 {len(clean)} 条 -> {OUT}")
    print(f"  CREATE OR REPLACE FUNCTION = {n_create_fn}（期望 1：redeem_by_code）")
    print(f"  ALTER TABLE                = {n_alter}（期望 7：2 加列 + 2 DROP + 2 ADD + 1 ENABLE RLS）")
    print(f"  REVOKE/GRANT               = {n_grant}（期望 3：函数 REVOKE + 函数 GRANT + 表 REVOKE）")
    print(f"  COMMENT ON                 = {n_comment}（期望 3：plan + months + function）")
    print(f"  CREATE INDEX               = {n_index}（期望 1）")

    errs = []
    if len(clean) != 15:
        errs.append(f"总条数 {len(clean)} != 15")
    if n_create_fn != 1:
        errs.append("CREATE FUNCTION 数 != 1")
    if n_alter != 7:
        errs.append("ALTER TABLE 数 != 7")
    if n_grant != 3:
        errs.append("REVOKE/GRANT 数 != 3")
    if n_comment != 3:
        errs.append("COMMENT 数 != 3")
    if n_index != 1:
        errs.append("CREATE INDEX 数 != 1")

    # 关键安全自检：函数体必须与自建库版本逐字一致，且绝不含 FORCE
    fn = next((s for s in clean if s.upper().startswith("CREATE OR REPLACE FUNCTION")), "")
    if "FORCE ROW LEVEL SECURITY" in "\n".join(clean).upper():
        errs.append("🔴 补丁里出现 FORCE ROW LEVEL SECURITY（见 0044 (b) 段末说明，禁止）")
    if "advisory_xact_lock" not in fn:
        errs.append("🔴 函数体丢了 advisory lock（并发顺延会丢更新）")
    if "make_interval" not in fn:
        errs.append("🔴 函数体丢了 make_interval（pro 档无法发放）")
    if "RETURNS text" not in fn:
        errs.append("🔴 返回类型不是 text（两端前端会把成功降级成 'bad'）")
    if fn.count("$fn$") != 2:
        errs.append("🔴 dollar-quote 未配对（切分把函数体切坏了）")

    if errs:
        print("\n🔴 校验未通过，请勿执行补丁：")
        for e in errs:
            print(f"   - {e}")
        return 1
    print("\n  ✅ 数量与安全校验全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
