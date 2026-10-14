"""图标安全区像素级自检。

思路：分别渲染「完整图标」和「只保留背景（隐藏图形层）」两张同尺寸图，
两者做差值即可精确圈出**图案像素**，再统计这些像素到画布中心的距离分布，
与 Android maskable 的安全圆（直径 = 画布 80%，即半径 0.4×画布）比对。

比用外接矩形角点估算准确得多 —— 蜜蜂、字母等形状并不填满其外接矩形，
用角点判断会得出偏保守的错误结论。

用法：
    python check-safezone.py full.png bgonly.png [画布边长，默认 1024]
"""
import sys

from PIL import Image, ImageChops

SAFE_RATIO = 0.4  # 安全圆半径 = 画布边长 × 0.4（对应直径 80%）


def main():
    if len(sys.argv) < 3:
        print("用法: python check-safezone.py <full.png> <bgonly.png> [canvas]")
        return 2
    full_path, bg_path = sys.argv[1], sys.argv[2]
    canvas = float(sys.argv[3]) if len(sys.argv) > 3 else 1024.0

    full = Image.open(full_path).convert("RGBA")
    bg = Image.open(bg_path).convert("RGBA")
    if full.size != bg.size:
        print(f"!! 尺寸不一致: {full.size} vs {bg.size}")
        return 2

    px_full = full.load()
    px_bg = bg.load()
    w, h = full.size
    scale = canvas / w               # 位图坐标 -> 画布坐标
    cx = cy = w / 2.0
    safe_r = canvas * SAFE_RATIO     # 画布坐标下的安全半径

    max_dist = -1.0
    outside = 0
    total = 0
    x0 = y0 = 10 ** 9
    x1 = y1 = -1

    for y in range(h):
        for x in range(w):
            a = px_full[x, y]
            b = px_bg[x, y]
            # 任一通道差异超过阈值即视为图案像素
            if abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2]) <= 12:
                continue
            total += 1
            if x < x0:
                x0 = x
            if y < y0:
                y0 = y
            if x > x1:
                x1 = x
            if y > y1:
                y1 = y
            d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 * scale
            if d > max_dist:
                max_dist = d
            if d > safe_r:
                outside += 1

    if total == 0:
        print("!! 两张图完全一致，未检测到图案像素（art 层可能未正确标记）")
        return 1

    bx0, by0, bx1, by1 = x0 * scale, y0 * scale, x1 * scale, y1 * scale
    pct = outside / total * 100
    ok = outside == 0

    print(f"  图案像素: {total}")
    print(f"  精确外接框(画布坐标): [{bx0:.0f},{by0:.0f}]-[{bx1:.0f},{by1:.0f}]")
    print(f"  图案最远点距中心: {max_dist:.0f}px   安全半径: {safe_r:.0f}px")
    print(f"  安全圆外的图案像素: {outside} ({pct:.3f}%)")
    print(f"  判定: {'✓ 完全落在安全圆内' if ok else '✗ 有图案被裁剪风险'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
