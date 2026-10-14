#!/usr/bin/env python
"""从 public/ 下的 512px 图标生成 Android mipmap 与 iOS AppIcon。

用法：
    python tools/gen-app-icons.py

输入：
    public/icon-512.png          普通图标（方角/圆角任由启动器裁切）
    public/icon-maskable-512.png maskable 版（内容留边更多，做自适应图标前景）

输出：
    android/app/src/main/res/mipmap-*/ic_launcher.png / ic_launcher_round.png
    android/app/src/main/res/mipmap-*/ic_launcher_foreground.png
    ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png

依赖：Pillow（pip install pillow）
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "public", "icon-512.png")
SRC_MASKABLE = os.path.join(ROOT, "public", "icon-maskable-512.png")
ANDROID_RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
IOS_APPICON = os.path.join(
    ROOT, "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset", "AppIcon-512@2x.png"
)

# 密度 → 倍率
DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}
# 启动器图标基准 48dp；自适应图标前景画布 108dp（含四周 bleed）
LAUNCHER_DP = 48
FOREGROUND_DP = 108


def resize(img: Image.Image, px: int) -> Image.Image:
    return img.resize((px, px), Image.LANCZOS)


def roundify(img: Image.Image) -> Image.Image:
    """圆形裁切（高分辨率蒙版缩小，避免锯齿）。"""
    px = img.size[0]
    mask = Image.new("L", (px * 4, px * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, px * 4 - 1, px * 4 - 1), fill=255)
    mask = mask.resize((px, px), Image.LANCZOS)
    out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def main() -> int:
    if not os.path.exists(SRC):
        print(f"缺少源图：{SRC}")
        return 1
    if not os.path.exists(SRC_MASKABLE):
        print(f"缺少源图：{SRC_MASKABLE}")
        return 1

    launcher = Image.open(SRC).convert("RGBA")
    maskable = Image.open(SRC_MASKABLE).convert("RGBA")

    for name, scale in DENSITIES.items():
        out_dir = os.path.join(ANDROID_RES, f"mipmap-{name}")
        os.makedirs(out_dir, exist_ok=True)
        lp = round(LAUNCHER_DP * scale)
        fp = round(FOREGROUND_DP * scale)
        resize(launcher, lp).save(os.path.join(out_dir, "ic_launcher.png"))
        roundify(resize(launcher, lp)).save(os.path.join(out_dir, "ic_launcher_round.png"))
        resize(maskable, fp).save(os.path.join(out_dir, "ic_launcher_foreground.png"))
        print(f"mipmap-{name}: launcher {lp}px / foreground {fp}px")

    # iOS 单尺寸 1024x1024；App Store 图标不允许透明，转 RGB
    ios_icon = resize(launcher, 1024).convert("RGB")
    ios_icon.save(IOS_APPICON, "PNG")
    print(f"iOS AppIcon: {IOS_APPICON} (1024x1024)")

    print("完成。重新出包生效：npm run native:sync && cd android && gradlew assembleDebug")
    return 0


if __name__ == "__main__":
    sys.exit(main())
