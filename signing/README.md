# signing/ · App 备案签名证书（本地材料，不入库）

此目录只放**他人可下载的公开证书**（`.cer` / `.pem` / `.p7b`），用于提取备案所需的公钥与签名指纹。
🔴 **严禁**放私钥、`.p12`、`.jks`、keystore 密码、AGC/Apple 账号凭据。

证书文件一律被 `.gitignore` 排除，本 README 入库仅作放置说明。

## 放什么

| 文件名 | 平台 | 从哪下载 |
|---|---|---|
| `ios-distribution.cer` | iOS | Apple Developer → Certificates → **iOS Distribution (App Store and Ad Hoc)** |
| `harmony-developer.cer` | 鸿蒙 | AppGallery Connect → 证书、APP ID 和 Profile → 证书 → 下载开发者证书（可含证书链） |

> 鸿蒙证书按华为云指引需「删除证书链，只保留叶子证书」——工具会自动处理，无需手工编辑。

## 取价值

```bash
python tools/app-beian-signing.py cert signing/ios-distribution.cer --platform ios
python tools/app-beian-signing.py cert signing/harmony-developer.cer --platform harmony
python tools/app-beian-signing.py report --out docs/App备案-签名信息速查-自动生成.md
```

## 口径提醒

- Android：公钥填**模数**、签名值填**MD5**
- iOS：公钥填**公共密钥**、签名值填 **SHA-1**（表单字段名写「签名MD5值」，但实际要 SHA-1）
- 鸿蒙：公钥填**叶子证书公钥**、签名值填**指纹（SHA-1 可作 MD5 值提交）**

详见 `docs/App备案-三平台签名信息获取与填报-2026-11-07.md`。
