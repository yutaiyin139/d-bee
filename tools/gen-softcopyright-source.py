#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""软著登记「源程序鉴别材料」机械提取与排版工具。

🔴 本工具的职责边界（务必理解，涉及法律承诺）：
  本脚本只做 **机械提取 + 版式排版**：从本仓库已存在的真实源文件中逐字节读取，
  按版权中心要求的格式（每页 ≥50 行、页眉标注软件全称+版本号、页码 1–60、
  前 30 页 + 后 30 页）排成 docx。
  **不生成、不改写、不补全任何一行代码**，也不撰写任何文档正文。

  2026-03-15 中国版权保护中心新规要求签章页经办人手抄承诺
  「未使用 AI 开发编写代码、撰写文档或生成登记申请材料」。
  该承诺的真实性由申请人自行判断与承担 —— 详见
  docs/软著登记-事实素材包与合规红线-2026-10-28.md §一。

用法：
  python tools/gen-softcopyright-source.py                    # 默认 scope=main, 60页×50行
  python tools/gen-softcopyright-source.py --scope all        # 含小程序 mini/src
  python tools/gen-softcopyright-source.py --dry-run          # 只统计，不生成文件

输出：
  docs/软著材料/源程序鉴别材料-<软件全称><版本号>.docx
  同时打印「源程序量（总行数）」等实测统计，供申请表填写。
"""
from __future__ import annotations

import argparse
import os
import re
import sys

# ---- 第三方依赖：python-docx（缺失时给出安装指引）----
try:
    from docx import Document
    from docx.enum.section import WD_SECTION
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
    from docx.shared import Mm, Pt
except ImportError:  # pragma: no cover
    sys.exit("!! 缺少 python-docx，请先安装：pip install python-docx")


REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── 提取范围（按「先入口后模块」的阅读顺序排列，前 30 页取头部、后 30 页取尾部）──
# 说明：源程序鉴别材料要能体现软件的核心逻辑，故按 入口 → 配置 → 页面 → 领域库 →
#       组件 → 状态 → 服务端网关 → 共享包 的顺序串联，而非简单按字母序。
SCOPE_MAIN: list[tuple[str, list[str]]] = [
    # (根目录, 扩展名白名单)
    ("src", [".ts", ".tsx"]),
    ("server", [".mjs", ".js"]),
    ("packages/shared/src", [".ts"]),
    ("db/migrations", [".sql"]),
]
SCOPE_MINI: list[tuple[str, list[str]]] = [("mini/src", [".ts", ".tsx"])]

# 入口文件优先（保证前 30 页是「软件怎么启动的」，审查员一眼看懂）
PRIORITY_FILES = [
    "src/main.tsx",
    "src/App.tsx",
    "src/cloudConfig.ts",
    "src/cloud.ts",
    "src/types.ts",
    "server/lib/app.mjs",
]

# 🔴 末尾锚点：版权中心明确要求「**最后一页应为软件退出部分代码**」。
# server/index.mjs 的尾部正是本软件的退出逻辑（shutdown(signal) + SIGTERM/SIGINT
# 优雅退出 + 连接池 end + 10s 超时强退 + boot()），故把它固定排到语料最末，
# 使「后 30 页」的最后一页落在退出代码上，而不是恰好按字母序排在最后的某个页面组件。
TAIL_ANCHOR_FILES = [
    "server/index.mjs",
]

# 🔴 安全过滤：命中即整文件跳过（鉴别材料会公开存档，绝不能带凭据）
SKIP_PATH_PATTERNS = [
    r"\.secrets", r"\.env", r"secret", r"credential", r"keystore",
    r"node_modules", r"[\\/]dist[\\/]", r"[\\/]build[\\/]", r"\.test\.", r"\.spec\.",
]
# 行级过滤：疑似密钥行剔除（保留代码结构，只抹掉敏感值所在行）
SKIP_LINE_PATTERNS = [
    re.compile(r"(sk-[A-Za-z0-9]{16,})"),
    re.compile(r"(api[_-]?key|apikey|secret|passwd|password|token)\s*[:=]\s*['\"][^'\"]{12,}['\"]", re.I),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"wbpk_[A-Za-z0-9_]{10,}"),   # WorkBuddy publishableKey（虽为公开key，仍不入库到公开材料）
]
# 只含空白/纯装饰的行会被剔除（版权中心要求「去掉非代码空行」，每页须 ≥50 行有效内容）
BLANK_LINE = re.compile(r"^\s*$")


def should_skip_path(rel: str) -> bool:
    low = rel.lower().replace("\\", "/")
    return any(re.search(p, low) for p in SKIP_PATH_PATTERNS)


def collect_files(scope: str) -> list[str]:
    """按范围收集源文件，返回仓库相对路径（正斜杠）。"""
    roots = list(SCOPE_MAIN) + (SCOPE_MINI if scope == "all" else [])
    found: list[str] = []
    for root, exts in roots:
        base = os.path.join(REPO, root.replace("/", os.sep))
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in {"node_modules", "dist", "build", ".git"}]
            for fn in sorted(filenames):
                if os.path.splitext(fn)[1].lower() not in exts:
                    continue
                abs_p = os.path.join(dirpath, fn)
                rel = os.path.relpath(abs_p, REPO).replace("\\", "/")
                if should_skip_path(rel):
                    continue
                found.append(rel)
    found.sort()
    # 入口文件提到最前（保持 PRIORITY_FILES 的相对次序）
    prio = [p for p in PRIORITY_FILES if p in found]
    # 末尾锚点固定排到最后（保证「最后一页 = 软件退出部分代码」）
    tail = [p for p in TAIL_ANCHOR_FILES if p in found]
    fixed = set(prio) | set(tail)
    rest = [p for p in found if p not in fixed]
    return prio + rest + tail


def read_effective_lines(rel: str) -> list[str]:
    """读取一个文件的有效行（去空行、去疑似密钥行），行尾不带换行符。"""
    path = os.path.join(REPO, rel.replace("/", os.sep))
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            raw = f.read().splitlines()
    except OSError as e:
        print(f"  [warn] 读取失败 {rel}: {e}", file=sys.stderr)
        return []
    out: list[str] = []
    dropped_secret = 0
    for ln in raw:
        ln = ln.rstrip("\r").replace("\t", "    ")
        if BLANK_LINE.match(ln):
            continue
        if any(p.search(ln) for p in SKIP_LINE_PATTERNS):
            dropped_secret += 1
            continue
        out.append(ln)
    if dropped_secret:
        print(f"  [安全] {rel}: 剔除疑似凭据行 {dropped_secret} 行")
    return out


def build_corpus(files: list[str]) -> tuple[list[str], dict]:
    """把文件串成「带文件分隔标记」的行序列，返回 (行列表, 统计)。"""
    lines: list[str] = []
    per_file: dict[str, int] = {}
    for rel in files:
        body = read_effective_lines(rel)
        if not body:
            continue
        per_file[rel] = len(body)
        # 文件分隔标记：便于审查员定位，同时算作有效行
        lines.append(f"/* ===== 文件：{rel}（{len(body)} 行） ===== */")
        lines.extend(body)
    stats = {
        "files": len(per_file),
        "total_lines": sum(per_file.values()),
        "per_file": per_file,
    }
    return lines, stats


def pick_head_tail(lines: list[str], pages: int, per_page: int) -> tuple[list[str], list[str], bool]:
    """取前 N/2 页与后 N/2 页。返回 (头部行, 尾部行, 是否全文不足)。"""
    need = pages * per_page
    half = (pages // 2) * per_page
    if len(lines) <= need:
        # 不足 60 页 → 版权中心要求「提交整个源程序」
        return lines, [], True
    return lines[:half], lines[-half:], False


def add_field_page_number(paragraph) -> None:
    """在段落中插入 Word PAGE 域（自动页码），格式「第 X 页」。"""
    run = paragraph.add_run("第 ")
    fld_begin = run._r.makeelement(qn("w:fldChar"), {qn("w:fldCharType"): "begin"})
    instr = run._r.makeelement(qn("w:instrText"), {qn("xml:space"): "preserve"})
    instr.text = " PAGE "
    fld_end = run._r.makeelement(qn("w:fldChar"), {qn("w:fldCharType"): "end"})
    r2 = paragraph.add_run()._r
    r2.append(fld_begin)
    r2.append(instr)
    r2.append(fld_end)
    paragraph.add_run(" 页")


def make_doc(name: str, version: str, head: list[str], tail: list[str],
             per_page: int, out_path: str, whole: bool) -> None:
    doc = Document()
    sec = doc.sections[0]
    # A4 纵向，窄边距（留出装订线在左侧）
    sec.page_width, sec.page_height = Mm(210), Mm(297)
    sec.left_margin, sec.right_margin = Mm(25), Mm(15)
    sec.top_margin, sec.bottom_margin = Mm(18), Mm(15)

    # ── 页眉：软件全称 + 版本号 居中；页码右上（同段落用制表位分开会复杂，
    #    版权中心只要求「页眉标注软件全称与版本号」「右上角标页码」，
    #    故页眉正中放全称+版本，页码放页眉右侧制表位）──
    header = sec.header
    hp = header.paragraphs[0]
    hp.text = ""
    # 右对齐制表位到页面可用宽度
    from docx.enum.text import WD_TAB_ALIGNMENT
    usable = sec.page_width - sec.left_margin - sec.right_margin
    hp.paragraph_format.tab_stops.add_tab_stop(usable, WD_TAB_ALIGNMENT.RIGHT)
    r = hp.add_run(f"{name}{version}")
    r.font.size = Pt(9)
    r.font.name = "宋体"
    r._element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")
    hp.add_run("\t")
    add_field_page_number(hp)
    for run in hp.runs:
        run.font.size = Pt(9)
    hp.alignment = WD_ALIGN_PARAGRAPH.LEFT

    # ── 正文：等宽小字，固定行距，每 per_page 行插一个分页符 ──
    style = doc.styles["Normal"]
    style.font.name = "Consolas"
    style.font.size = Pt(8)
    style.element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")
    pf = style.paragraph_format
    pf.space_before = Pt(0)
    pf.space_after = Pt(0)
    pf.line_spacing = Pt(11.2)   # 50 行 × 11.2pt ≈ 560pt，落在 A4 可用高度内

    chunks: list[list[str]] = []
    seq = list(head) if whole else list(head) + list(tail)
    for i in range(0, len(seq), per_page):
        chunks.append(seq[i:i + per_page])

    note_added = False
    for idx, chunk in enumerate(chunks):
        if idx > 0:
            doc.add_page_break()
        if not whole and not note_added and idx == len(head) // per_page:
            # 在「后 30 页」起始处标注，便于审查员理解为何行号不连续
            p = doc.add_paragraph()
            r = p.add_run("/* ===== 以下为源程序连续的后 30 页（前 30 页与后 30 页之间省略中间部分） ===== */")
            r.font.size = Pt(8)
            r.font.name = "Consolas"
            note_added = True
        for line in chunk:
            p = doc.add_paragraph()
            r = p.add_run(line[:400])   # 单行截断，防止超长行撑破版式
            r.font.size = Pt(8)
            r.font.name = "Consolas"
            r._element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    doc.save(out_path)


def main() -> int:
    ap = argparse.ArgumentParser(description="软著源程序鉴别材料机械提取排版")
    ap.add_argument("--name", default="自律蜜蜂饮食健康管理软件", help="软件全称（须与申请表逐字一致）")
    ap.add_argument("--version", default="V1.0", help="版本号（首次登记惯例 V1.0）")
    ap.add_argument("--scope", choices=["main", "all"], default="main",
                    help="main=主工程(src+server+shared+db)；all=另含小程序 mini/src")
    ap.add_argument("--pages", type=int, default=60, help="总页数（默认 60=前30+后30）")
    ap.add_argument("--per-page", type=int, default=50, help="每页行数（版权中心要求 ≥50）")
    ap.add_argument("--out", default=None, help="输出 docx 路径")
    ap.add_argument("--dry-run", action="store_true", help="只统计不生成")
    args = ap.parse_args()

    print(f"=== 软著源程序鉴别材料提取 ===")
    print(f"软件全称: {args.name}{args.version}")
    print(f"范围: {args.scope}（{'含' if args.scope == 'all' else '不含'}小程序）")
    files = collect_files(args.scope)
    print(f"候选源文件: {len(files)} 个")
    lines, stats = build_corpus(files)
    print(f"有效代码行（去空行/去疑似凭据行）: {stats['total_lines']} 行，来自 {stats['files']} 个文件")

    head, tail, whole = pick_head_tail(lines, args.pages, args.per_page)
    if whole:
        print(f"⚠️ 源程序不足 {args.pages} 页（共 {len(lines)} 行 = {len(lines)/args.per_page:.1f} 页）"
              f"→ 按规则须提交**整个源程序**")
        total_pages = -(-len(lines) // args.per_page)
    else:
        print(f"取前 {len(head)} 行 + 后 {len(tail)} 行 = {args.pages} 页 × {args.per_page} 行")
        total_pages = args.pages

    # 供申请表填写的实测数据
    print("\n=== 申请表可填的实测数据 ===")
    print(f"源程序量（行数）: {stats['total_lines']}")
    print(f"编程语言: TypeScript / JavaScript(Node.js ESM) / SQL"
          + (" / TypeScript(Taro 小程序)" if args.scope == "all" else ""))
    top = sorted(stats["per_file"].items(), key=lambda kv: -kv[1])[:12]
    print("行数最多的模块（Top 12）:")
    for rel, n in top:
        print(f"  {n:>6}  {rel}")

    if args.dry_run:
        print("\n(--dry-run，未生成文件)")
        return 0

    out = args.out or os.path.join(
        REPO, "docs", "软著材料", f"源程序鉴别材料-{args.name}{args.version}.docx")
    make_doc(args.name, args.version, head, tail, args.per_page, out, whole)
    print(f"\n✅ 已生成: {out}")
    print(f"   页数: {total_pages}（页眉已标注「{args.name}{args.version}」+ 自动页码）")
    print("   ⚠️ 提交前请人工核对：①每页 ≥50 行 ②页眉全称+版本号与申请表逐字一致")
    print("      ③无凭据泄露 ④A4 纵向单面打印，右上角页码 1–60")
    return 0


if __name__ == "__main__":
    sys.exit(main())
