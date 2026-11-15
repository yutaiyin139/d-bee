"""
护栏 29（tools/placeholder-capability.test.ts）退化红验证。

对 8 类退化分别：备份 → 注入退化 → 跑测试记录哪些用例变红 → 字节级恢复 → 校验恢复。
每类退化必须**精准**变红（命中预期用例、不误伤无关用例），否则说明断言写得太宽或太窄。

🔴 零删除：全程只做「文件内容临时改写 + 从内存备份逐字节写回」，不删除任何文件。
"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST = "tools/placeholder-capability.test.ts"


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def write(rel, text):
    (ROOT / rel).write_text(text, encoding="utf-8", newline="")


def replace_once(rel, old, new):
    src = read(rel)
    if src.count(old) != 1:
        raise SystemExit(f"[FATAL] {rel}: 目标片段出现 {src.count(old)} 次，需唯一")
    write(rel, src.replace(old, new, 1))


def run_test():
    """返回 (通过数, 失败数, 失败用例标题集合)"""
    p = subprocess.run(
        ["npx", "vitest", "run", TEST, "--reporter=json", "--outputFile=.redverify.json"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", shell=True,
    )
    out = ROOT / ".redverify.json"
    if not out.exists():
        print(p.stdout[-3000:], p.stderr[-3000:])
        raise SystemExit("[FATAL] 未生成 JSON 报告")
    import json
    data = json.loads(out.read_text(encoding="utf-8"))
    out.unlink()
    failed = set()
    passed = 0
    for suite in data["testResults"]:
        for t in suite["assertionResults"]:
            name = " / ".join(t["ancestorTitles"] + [t["title"]])
            if t["status"] == "passed":
                passed += 1
            elif t["status"] == "failed":
                failed.add(name)
    return passed, len(failed), failed


# ── 8 类退化定义 ──────────────────────────────────────────────
# each: (名称, 注入函数, 预期必须变红的用例关键字列表)
DEGRADATIONS = [
    (
        "R1 删掉通知诚实说明的条件渲染",
        lambda: replace_once(
            "mini/src/pages/profile/profile.tsx",
            "{!isNotifyPushAvailable ? (",
            "{false && !isNotifyPushAvailable ? (",
        ),
        ["mini 推送未接入时"],
    ),
    (
        "R2 只删掉 CSV 那一行的「即将上线」角标（漏改一行的典型退化）",
        lambda: replace_once(
            "mini/src/pages/profile/profile.tsx",
            "            <Text className='line-label'>导出饮食记录（CSV）</Text>\n"
            "          </View>\n"
            "          {!pro\n"
            "            ? <Text className='line-val'>Pro <Text className='arrow'>›</Text></Text>\n"
            "            : isExportAvailable\n"
            "              ? <Text className='line-val'>{exporting ? '导出中…' : '导出'}</Text>\n"
            "              : <Text className='line-badge'>即将上线</Text>}",
            "            <Text className='line-label'>导出饮食记录（CSV）</Text>\n"
            "          </View>\n"
            "          {!pro\n"
            "            ? <Text className='line-val'>Pro <Text className='arrow'>›</Text></Text>\n"
            "            : null}",
        ),
        ["两行导出入口都渲染「即将上线」角标"],
    ),
    (
        "R3 clipboard.ts 复活不可达小程序占位分支",
        lambda: replace_once(
            "src/lib/clipboard.ts",
            "export async function copyText(text: string): Promise<boolean> {\n  // 1) 原生插件（原生 App 内）",
            "export async function copyText(text: string): Promise<boolean> {\n"
            "  if (isWechatMiniProgram()) {\n    return false\n  }\n\n  // 1) 原生插件（原生 App 内）",
        ),
        ["src/lib/clipboard.ts 不再包含不可达的小程序占位分支"],
    ),
    (
        "R4 新增未登记的能力开关",
        lambda: write(
            "src/lib/miniOrderGuide.ts",
            read("src/lib/miniOrderGuide.ts")
            + "\nexport const SMS_REMIND_ENABLED: boolean = false\n",
        ),
        ["扫描到的能力标识符全部已登记"],
    ),
    (
        "R5 删掉导出占位文案（一键回退保护）",
        lambda: replace_once(
            "mini/src/lib/share.ts",
            "export const EXPORT_UNAVAILABLE_MESSAGE =",
            "const __removed_EXPORT_UNAVAILABLE_MESSAGE =",
        ),
        ["导出占位文案仍导出可用"],
    ),
    (
        "R6 通知说明写入具体推送时间（未实现能力的时间承诺）",
        lambda: replace_once(
            "mini/src/lib/notifications.ts",
            "'开关目前仅保存你的提醒偏好，小程序端尚未接入微信订阅消息，因此暂时不会收到推送通知。'",
            "'每天 20:00 提醒你记录饮食，9:00~21:00 每 2 小时提醒饮水。'",
        ),
        ["不得承诺具体推送时间"],
    ),
    (
        "R7 主端通知区块去掉 notifSupported 门控",
        lambda: replace_once(
            "src/pages/ProfileScreen.tsx",
            "{notifSupported && (",
            "{true && (",
        ),
        ["主端通知区块整块包在 notifSupported 门控内"],
    ),
    (
        "R8 主端微信登录入口去掉可见性门控",
        lambda: replace_once(
            "src/pages/AuthScreen.tsx",
            "{WECHAT_LOGIN_AVAILABLE && (",
            "{true && (",
        ),
        ["主端微信登录入口包在 WECHAT_LOGIN_AVAILABLE 门控内"],
    ),
    (
        "R9 CSV 导出路径漏掉 guardExport 检查（只改一处守卫的典型退化）",
        lambda: replace_once(
            "mini/src/pages/profile/profile.tsx",
            "  async function doExportCsv() {\n"
            "    setDataErr('')\n"
            "    setDataMsg('')\n"
            "    if (!guardExport()) return",
            "  async function doExportCsv() {\n"
            "    setDataErr('')\n"
            "    setDataMsg('')",
        ),
        ["两条导出路径（JSON / CSV）都先过 guardExport"],
    ),
]


def main():
    # 备份所有会被改动的文件
    files = {
        "mini/src/pages/profile/profile.tsx",
        "src/lib/clipboard.ts",
        "src/lib/miniOrderGuide.ts",
        "mini/src/lib/share.ts",
        "mini/src/lib/notifications.ts",
        "src/pages/ProfileScreen.tsx",
        "src/pages/AuthScreen.tsx",
    }
    backups = {rel: read(rel) for rel in files}
    tmp = Path(tempfile.mkdtemp(prefix="redverify-29-"))
    for rel, text in backups.items():
        (tmp / rel.replace("/", "__")).write_text(text, encoding="utf-8", newline="")
    print(f"[备份] {len(backups)} 文件 → {tmp}")

    base_p, base_f, _ = run_test()
    print(f"[基线] 全绿状态 {base_p} 通过 / {base_f} 失败\n")
    if base_f:
        raise SystemExit("[FATAL] 基线不是全绿，先修基线")

    all_ok = True
    results = []
    for name, inject, expect_keys in DEGRADATIONS:
        inject()
        p, f, failed = run_test()
        hit = [k for k in expect_keys if any(k in x for x in failed)]
        unexpected = sorted(x for x in failed if not any(k in x for k in expect_keys))
        ok = len(hit) == len(expect_keys) and not unexpected
        all_ok &= ok
        results.append((name, p, f, sorted(hit), unexpected, ok))
        print(f"{'✅' if ok else '❌'} {name}: {f} 红 / {p} 绿")
        print(f"    命中预期: {sorted(hit)}")
        if unexpected:
            print(f"    ⚠️ 误伤: {unexpected}")
        # 恢复
        for rel, text in backups.items():
            write(rel, text)

    # 字节级恢复校验
    print("\n[恢复校验]")
    restore_ok = True
    for rel, text in backups.items():
        now = read(rel)
        same = now == text
        restore_ok &= same
        print(f"    {'✅' if same else '❌'} {rel} 逐字一致 = {same}")

    p2, f2, _ = run_test()
    print(f"\n[恢复后] {p2} 通过 / {f2} 失败")
    final_green = f2 == 0

    shutil.rmtree(tmp, ignore_errors=True)

    print("\n" + "=" * 70)
    print(f"退化精准命中率: {sum(1 for r in results if r[5])}/{len(results)}")
    print(f"字节级恢复: {restore_ok}")
    print(f"恢复后全绿: {final_green} ({p2} 项)")
    ok = all_ok and restore_ok and final_green
    print(f"\n结论: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
