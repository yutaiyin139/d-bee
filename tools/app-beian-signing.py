#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""App 备案 · 三平台签名信息提取（公钥 / 签名指纹）。

备案口径（2026-11-07 核实：华为云 ICP 备案指引、火山引擎 App 特征信息规范、天翼云）：

  Android : 公钥   = APK signature 中的「模数」(RSA modulus, 16 进制)
            签名值 = 签名证书的 **MD5** 指纹（16 进制）
  iOS     : 公钥   = 证书中的「公共密钥」
            签名值 = 证书 **SHA-1** 指纹（16 进制）—— 🔴 不是 MD5，字段名虽叫「签名MD5值」
  Harmony : 公钥   = **叶子证书**中的公钥（须先删除证书链里的根证书/中间证书）
            签名值 = 证书指纹（华为云明确：SHA-1 指纹可作为 MD5 值提交）

用法：
  python tools/app-beian-signing.py android
  python tools/app-beian-signing.py android --apk release/<新包>.apk
  python tools/app-beian-signing.py cert signing/ios-distribution.cer --platform ios
  python tools/app-beian-signing.py cert signing/harmony-developer.cer --platform harmony
  python tools/app-beian-signing.py report [--out docs/<填报速查>.md]

凭据纪律：keystore 密码只从 android/keystore.properties 读入内存，经**进程环境变量**
传给 keytool（-storepass:env），不打印、不进命令行参数、不落盘。
"""
from __future__ import annotations

import argparse
import base64
import glob
import os
import re
import subprocess
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

ROOT = Path(__file__).resolve().parent.parent
KS_PROPS = ROOT / "android" / "keystore.properties"
SIGNING_DIR = ROOT / "signing"
APP_ID = "cn.com.dbee.app"
APP_NAME = "自律蜜蜂"


# --------------------------------------------------------------------------- 通用

def colon(hex_str: str) -> str:
    return ":".join(hex_str[i:i + 2] for i in range(0, len(hex_str), 2)).upper()


def _fingerprint(cert, algo) -> str:
    return cert.fingerprint(algo).hex().lower()


def cert_detail(cert: x509.Certificate) -> dict:
    pub = cert.public_key()
    spki_der = pub.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    out = {
        "subject": cert.subject.rfc4514_string(),
        "issuer": cert.issuer.rfc4514_string(),
        "serial": format(cert.serial_number, "X"),
        "not_before": cert.not_valid_before_utc.strftime("%Y-%m-%d"),
        "not_after": cert.not_valid_after_utc.strftime("%Y-%m-%d"),
        "md5": _fingerprint(cert, hashes.MD5()),
        "sha1": _fingerprint(cert, hashes.SHA1()),
        "sha256": _fingerprint(cert, hashes.SHA256()),
        "spki_b64": base64.b64encode(spki_der).decode(),
        "spki_pem": pub.public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode().strip(),
        "modulus_hex": None,
    }
    if isinstance(pub, rsa.RSAPublicKey):
        h = format(pub.public_numbers().n, "X")
        out["modulus_hex"] = h if len(h) % 2 == 0 else "0" + h
        out["key_alg"] = f"RSA {pub.key_size}"
    elif isinstance(pub, ec.EllipticCurvePublicKey):
        out["key_alg"] = f"EC {pub.curve.name}"
    else:
        out["key_alg"] = type(pub).__name__
    return out


def load_certs(path: Path) -> list[x509.Certificate]:
    data = path.read_bytes()
    if b"-----BEGIN CERTIFICATE-----" in data:
        return list(x509.load_pem_x509_certificates(data))
    try:
        return [x509.load_der_x509_certificate(data)]
    except ValueError:
        from cryptography.hazmat.primitives.serialization import pkcs7
        return list(pkcs7.load_der_pkcs7_certificates(data))


def pick_leaf(certs: list[x509.Certificate]) -> tuple[x509.Certificate, str]:
    """按 AGC 指引「删除证书链，只保留叶子证书」自动剔除根/中间证书。"""
    if len(certs) == 1:
        return certs[0], "文件内仅 1 张证书，无需删链"
    leaves = []
    for c in certs:
        try:
            if c.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
                continue
        except x509.ExtensionNotFound:
            pass
        if c.subject == c.issuer:  # 自签根证书
            continue
        leaves.append(c)
    if len(leaves) == 1:
        return leaves[0], f"从 {len(certs)} 张证书中自动剔除根/中间证书，保留叶子证书"
    # 退化：证书链里最后一个非 CA 通常就是应用证书
    non_ca = [c for c in certs if c.subject != c.issuer]
    if non_ca:
        return non_ca[-1], f"⚠️ 检出 {len(certs)} 张证书、{len(leaves)} 张候选叶子，已取最后一张非自签证书，请人工复核"
    return certs[0], "⚠️ 未识别出叶子证书，已取第 1 张，请人工复核"


# --------------------------------------------------------------------------- Android

def find_apksigner_jar() -> Path | None:
    sdk = None
    lp = ROOT / "android" / "local.properties"
    if lp.exists():
        for line in lp.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("sdk.dir="):
                sdk = Path(line.split("=", 1)[1].strip().replace("\\", "/"))
    if sdk is None:
        env_sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
        sdk = Path(env_sdk) if env_sdk else None
    if sdk is None:
        return None
    jars = sorted(glob.glob(str(sdk / "build-tools" / "*" / "lib" / "apksigner.jar")))
    return Path(jars[-1]) if jars else None


def apk_fingerprints(apk: Path) -> dict:
    jar = find_apksigner_jar()
    if jar is None:
        return {"error": "未找到 apksigner.jar（检查 android/local.properties / ANDROID_HOME）"}
    if not apk.exists():
        return {"error": f"APK 不存在：{apk}"}
    r = subprocess.run(
        ["java", "-jar", str(jar), "verify", "--print-certs", str(apk)],
        capture_output=True, text=True, timeout=180,
    )
    txt = (r.stdout or "") + (r.stderr or "")
    out = {"verified": r.returncode == 0, "apk": str(apk.relative_to(ROOT)), "jar": jar.parent.parent.name}
    m = re.search(r"certificate DN:\s*(.+)", txt)
    out["dn"] = m.group(1).strip() if m else ""
    for key in ("MD5", "SHA-1", "SHA-256"):
        m = re.search(rf"certificate {re.escape(key)} digest:\s*([0-9a-fA-F]+)", txt)
        out[key.lower().replace("-", "")] = m.group(1).lower() if m else ""
    if not out.get("sha256"):
        out["error"] = (txt.strip().splitlines() or ["apksigner 未输出证书指纹"])[0][:200]
    return out


def keystore_cert() -> tuple[dict, str]:
    props: dict[str, str] = {}
    for line in KS_PROPS.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        props[k.strip()] = v.strip()
    ks = ROOT / "android" / props["storeFile"]
    env = os.environ.copy()
    env["DBEE_KS_STOREPASS"] = props["storePassword"]
    env["DBEE_KS_KEYPASS"] = props.get("keyPassword", props["storePassword"])
    cmd = [
        "keytool", "-exportcert", "-rfc", "-keystore", str(ks),
        "-alias", props["keyAlias"], "-storepass:env", "DBEE_KS_STOREPASS",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=90)
    if r.returncode != 0:
        first = (r.stderr.strip().splitlines() or [""])[0][:180]
        raise RuntimeError(f"keytool 导出证书失败（不回显凭据）：{first}")
    certs = list(x509.load_pem_x509_certificates(r.stdout.encode()))
    return cert_detail(certs[0]), props["keyAlias"]


def android_info(apk: Path) -> dict:
    d, alias = keystore_cert()
    fp = apk_fingerprints(apk)
    d["alias"] = alias
    d["apk"] = fp
    d["cross_check"] = None
    if fp.get("sha256") and d["sha256"]:
        d["cross_check"] = "PASS" if fp["sha256"] == d["sha256"] else "FAIL"
    return d


# --------------------------------------------------------------------------- 输出

def block(title: str, d: dict, platform: str, source: str, extra: list[str] | None = None) -> str:
    lines = [f"### {title}", "", f"- 来源：`{source}`", f"- 证书主体 DN：{d['subject']}",
             f"- 密钥算法：{d['key_alg']} ｜ 有效期：{d['not_before']} → {d['not_after']}"]
    if d.get("modulus_hex"):
        lines += ["", "**公钥（备案要填的「模数 / 公共密钥」，16 进制）**", "",
                  "```", d["modulus_hex"], "```"]
    lines += ["", "**签名值（按平台选对应算法，16 进制）**", "",
              "```",
              f"MD5    : {d['md5']}",
              f"SHA-1  : {d['sha1']}",
              f"SHA-256: {d['sha256']}",
              "```", "",
              "**公钥 SPKI（Base64，部分备案系统要求这种格式）**", "",
              "```", d["spki_b64"], "```"]
    if d.get("apk"):
        fp = d["apk"]
        if fp.get("error"):
            lines += ["", f"⚠️ APK 侧校验未完成：{fp['error']}"]
        else:
            lines += ["", f"**APK 交叉校验**：`{fp['apk']}`（{fp['jar']}）verify={fp['verified']}，"
                      f"证书 SHA-256 与 keystore **{d['cross_check']}**；"
                      f"APK 内 MD5={fp.get('md5', '')}、SHA-1={fp.get('sha1', '')}"]
    if extra:
        lines += [""] + extra
    return "\n".join(lines)


def render_report(android: dict | None, others: list[tuple[str, dict, str, str]]) -> str:
    lines = [
        f"# {APP_NAME} · App 备案三平台签名信息（自动生成，勿手改）", "",
        "> 生成：`python tools/app-beian-signing.py report`｜口径依据见 "
        "`docs/App备案-三平台签名信息获取与填报-2026-11-07.md`", "",
        "| 平台 | 应用标识 | 公钥填什么 | 签名值填什么 | 状态 |",
        "|---|---|---|---|---|",
        f"| Android | `{APP_ID}` | APK signature 的**模数** | 证书 **MD5** | {'✅ 已取真值' if android else '🔴 缺 keystore'} |",
        f"| iOS | `{APP_ID}` | 证书公共密钥 | 证书 **SHA-1**（不是 MD5） | {'✅ 已取真值' if any(p == 'ios' for p, *_ in others) else '🔴 缺 Apple Distribution 证书'} |",
        f"| 鸿蒙 | 待 AGC 登记包名 | 叶子证书公钥 | 证书指纹（**SHA-1** 可作 MD5 值提交） | {'✅ 已取真值' if any(p == 'harmony' for p, *_ in others) else '🔴 缺 AGC 开发者证书'} |",
        "", "---", "",
    ]
    if android:
        apk_src = android["apk"].get("apk", "已签名 APK") if isinstance(android.get("apk"), dict) else "已签名 APK"
        lines += [block("① Android 平台 · 可直接填表", android, "android",
                        f"android/keystore.properties（alias {android['alias']}）+ {apk_src}"),
                  "", f"**包名（App 包名）**：`{APP_ID}`", "",
                  "🔴 备案系统只认「模数 + MD5」两项，不要误填 SHA-256 或 SPKI Base64。", "", "---", ""]
    for platform, d, source, note in others:
        title = "② iOS 平台" if platform == "ios" else "③ 鸿蒙平台"
        lines += [block(f"{title} · 可直接填表", d, platform, source, [note]), "", "---", ""]
    if not any(p == "ios" for p, *_ in others):
        lines += ["## ② iOS 平台 · 待补材料", "",
                  "把 Apple Developer 下载的 Distribution 证书（`.cer`）放到 "
                  "`signing/ios-distribution.cer`，然后：", "",
                  "```bash",
                  "python tools/app-beian-signing.py cert signing/ios-distribution.cer --platform ios",
                  "```", "", "详见填报文档 §三。", "", "---", ""]
    if not any(p == "harmony" for p, *_ in others):
        lines += ["## ③ 鸿蒙平台 · 待补材料", "",
                  "把 AGC「证书、APP ID 和 Profile → 证书」下载的开发者证书放到 "
                  "`signing/harmony-developer.cer`（脚本会自动删除证书链保留叶子证书），然后：", "",
                  "```bash",
                  "python tools/app-beian-signing.py cert signing/harmony-developer.cer --platform harmony",
                  "```", "", "详见填报文档 §四。", ""]
    return "\n".join(lines)


# --------------------------------------------------------------------------- 入口

def main() -> int:
    ap = argparse.ArgumentParser(description="App 备案三平台签名信息提取")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_a = sub.add_parser("android", help="从项目 keystore + 已签名 APK 取 Android 真值")
    p_a.add_argument("--apk", default=None, help="APK 路径；默认扫 release/ 下 mtime 最新的正式包")

    p_c = sub.add_parser("cert", help="解析 iOS / 鸿蒙证书文件")
    p_c.add_argument("file", help=".cer / .pem / .p7b 证书（可含证书链）")
    p_c.add_argument("--platform", choices=["ios", "harmony"], required=True)

    p_r = sub.add_parser("report", help="汇总为可直接照抄的备案填报表")
    p_r.add_argument("--out", default=None, help="写入文件（默认打印到 stdout）")
    args = ap.parse_args()

    if args.cmd == "android":
        if args.apk:
            apk = Path(args.apk)
            if not apk.is_absolute():
                apk = ROOT / apk
        else:
            cands = sorted((ROOT / "release").glob("D-Bee-*-FORMAL-*.apk"),
                           key=lambda p: p.stat().st_mtime, reverse=True)
            apk = cands[0] if cands else ROOT / "release" / "app-release.apk"
        d = android_info(apk)
        print(block("Android 平台 · 备案签名信息", d, "android", str(apk)))
        print(f"\n包名：`{APP_ID}`")
        return 0 if d.get("cross_check") in (None, "PASS") else 1

    if args.cmd == "cert":
        path = Path(args.file)
        if not path.is_absolute():
            path = ROOT / path
        if not path.exists():
            print(f"✗ 证书不存在：{path}", file=sys.stderr)
            return 2
        certs = load_certs(path)
        leaf, how = pick_leaf(certs)
        d = cert_detail(leaf)
        note = f"- 证书链处理：{how}（共 {len(certs)} 张）"
        print(block(f"{'iOS' if args.platform == 'ios' else '鸿蒙'} 平台 · 备案签名信息",
                    d, args.platform, str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path),
                    [note, "- 🔴 本平台签名值填 **SHA-1**，不是 MD5"]))
        return 0

    # report
    android = None
    try:
        cands = sorted((ROOT / "release").glob("D-Bee-*-FORMAL-*.apk"),
                       key=lambda p: p.stat().st_mtime, reverse=True)
        apk = cands[0] if cands else None
        if apk:
            android = android_info(apk)
    except Exception as e:
        print(f"⚠️ Android 取值失败：{type(e).__name__}: {str(e)[:120]}", file=sys.stderr)

    others = []
    for platform, pattern in (("ios", "ios-distribution.*"), ("harmony", "harmony-developer.*")):
        for path in sorted(SIGNING_DIR.glob(pattern)):
            try:
                certs = load_certs(path)
                leaf, how = pick_leaf(certs)
                others.append((platform, cert_detail(leaf), str(path.relative_to(ROOT)),
                               f"- 证书链处理：{how}（共 {len(certs)} 张）\n"
                               "- 🔴 本平台签名值填 **SHA-1**，不是 MD5"))
                break
            except Exception as e:
                print(f"⚠️ 跳过 {path.name}：{type(e).__name__}: {str(e)[:120]}", file=sys.stderr)

    text = render_report(android, others)
    if args.out:
        out = Path(args.out)
        if not out.is_absolute():
            out = ROOT / out
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text + "\n", encoding="utf-8")
        print(f"✓ 已写入 {out.relative_to(ROOT)}（{len(text)} 字符）")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
