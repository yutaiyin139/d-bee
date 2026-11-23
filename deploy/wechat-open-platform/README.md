# 微信开放平台「移动应用」创建 · 工程侧物料包与核查报告

> 项目：自律蜜蜂（D-Bee）｜生成日期：**2026-11-21**｜执行：工程（Alex）
> 本目录是**纯新增**产物，未修改仓库任何既有文件（自证见 §五）。
> 所有结论均附**可复现证据**（文件路径:行号 / 命令 / 字节级校验），无推测项。
> 平台入口：`https://open.weixin.qq.com` → 管理中心 → 移动应用 → 创建移动应用

---

## 〇、一页纸结论（TL;DR）

| 项 | 结论 | 卡点 |
| --- | --- | --- |
| **应用图标 28×28 / 108×108** | 🟢 **已生成并自验通过**（§一） | 无，可直接上传 |
| **Android 应用签名** | 🟢 **`0abe7fc5005987ed9b6eae9a45fb9dc9`**（证书 MD5，32 位小写无冒号） | 无。已用**官方 Gen_Signature 工具反编译 + 字节级复算**三重锁定口径（§二） |
| **Android 应用包名** | 🟢 **`cn.com.dbee.app`** | 无 |
| **微信 SDK 接入完备性** | 🟡 Android 侧**结构完备可回跳**，但有 **2 个 ⚠️**（queries 靠依赖隐式带入、SDK 停在已停更的 6.8.0）（§三） | 需另开会话改 gradle/manifest（本次禁止改文件） |
| **iOS Universal Links** | 🔴 **仍不具备**：无 associated-domains、无 AASA、iOS 侧**根本没装微信 SDK**（§三.d）。🟢 **Apple Team ID 已回填 `96BW23KM2C`**（2026-11-22 用户提供，已写入 `project.pbxproj:311,335`） | 只能 Mac + 付费开发者账号做 |
| **提审材料** | 🔴 应用运行流程图（真机截图）、官网内容合规、类目、主体认证 = **工程侧无法代做**（§四） | 用户本人 |

---

## 一、任务 1 · 应用图标（已生成，逐个自验）

### 1.1 产物清单（`deploy/wechat-open-platform/`）

| 文件 | 实测宽×高 | 格式 | 字节数 | ≤300KB | 用途 |
| --- | --- | --- | --- | --- | --- |
| `logo-28x28.png` | **28×28** | PNG | **1,384** | ✅ | 开放平台「移动应用图片」（28\*28，仅 PNG） |
| `logo-108x108.png` | **108×108** | PNG | **11,783** | ✅ | 开放平台「移动应用图片大图」（108\*108，仅 PNG） |
| `logo-28x28.jpg` | 28×28 | JPEG | 866 | ✅ | 备用（部分入口只收 jpg），质量 92、无色度二次抽样 |
| `logo-108x108.jpg` | 108×108 | JPEG | 5,038 | ✅ | 备用，同上 |
| `logo-512x512.png` | 512×512 | PNG | **121,821** | ✅ | 大图备用；与 `public/icon-512.png` **MD5 逐字一致**（纯拷贝，未重编码） |

源图：`public/icon-512.png`（512×512，RGB，121,821 B，MD5 `acfdc1794c2cf0e1c9bc547d5e54602e`）
—— 即 `tools/gen-app-icons.py:27` 生成 Android mipmap / iOS AppIcon 的同一张源图，图标与 App 内实际图标同源，满足审核规范 1.2.2「应用图标应与应用名称保持一致」。

### 1.2 自验输出（真实读回，非"已生成"口头结论）

```
SRC: public/icon-512.png
  size=(512, 512) mode=RGB format=PNG bytes=121821
  sha256=5caa838546574a8c9ed4770e00c632c210e03f676a8a7722c8cb35834019a5f9

--- SELF-VERIFY (read every file back) ---
logo-28x28.png      size=28x28    mode=RGB format=PNG  bytes=1384   md5=7a103fea11dc1cddf683122dfc9cf4f4
logo-28x28.jpg      size=28x28    mode=RGB format=JPEG bytes=866    md5=d86dd59b8296713eeee07a6a3796f5eb
logo-108x108.png    size=108x108  mode=RGB format=PNG  bytes=11783  md5=01055b2137abe596a29597d3900b1ce5
logo-108x108.jpg    size=108x108  mode=RGB format=JPEG bytes=5038   md5=9e9da32f314553fab6efec91e5fbea2f
logo-512x512.png    size=512x512  mode=RGB format=PNG  bytes=121821 md5=acfdc1794c2cf0e1c9bc547d5e54602e

# 第二轮独立复验（含 300KB 上限与格式断言）
logo-28x28.png        28x28  PNG     1384 B  <=300KB:True  PASS:True
logo-28x28.jpg        28x28  JPEG     866 B  <=300KB:True  PASS:True
logo-108x108.png     108x108 PNG    11783 B  <=300KB:True  PASS:True
logo-108x108.jpg     108x108 JPEG    5038 B  <=300KB:True  PASS:True
logo-512x512.png     512x512 PNG   121821 B  <=300KB:True  PASS:True
ALL PASS: True
```

### 1.3 「未引入透明边距变化」的量化证明

缩放算法 **LANCZOS**（Pillow 12.3.0）。源图为 `RGB`（无 alpha 通道，四角实测 alpha=255），故**不存在透明合成、不存在 padding**：

```
logo-28x28.png     edge_alpha_min=255  dark_edge_px=  0/112  lum[min=116 max=253 mean=229.1]
logo-108x108.png   edge_alpha_min=255  dark_edge_px=  0/432  lum[min=113 max=255 mean=229.1]
logo-512x512.png   edge_alpha_min=255  dark_edge_px=  0/2048 lum[min=125 max=253 mean=229.1]
public/icon-512.png edge_alpha_min=255 dark_edge_px=  0/2048 lum[min=125 max=253 mean=229.1]

logo-28x28.png    max per-channel delta vs fresh LANCZOS reference = 0
logo-108x108.png  max per-channel delta vs fresh LANCZOS reference = 0
```

- `dark_edge_px = 0` → 四周**无黑边/暗边**；`edge_alpha_min = 255` → **满铺不透明**，画面铺满整方（微信图标不接受透明底）。
- `delta = 0` → 产物与"用同一算法当场重算"的结果**逐像素相同**，即缩放过程确定、未叠加任何边距/背景处理。
- 平均亮度三档一致（229.1）→ 未发生色调偏移。

### 1.4 上传注意事项（对照《应用审核规范》1.2）

- ✅ 1.2.1 清晰、无水印：缩放自 512px 矢量感图标，28px 下仍保留完整轮廓；**未添加任何水印**。
- ✅ 1.2.2 与应用名称一致：与 App 内实际启动图标同源同图。
- ✅ 1.2.3 不含腾讯/微信等官方品牌标识：图案为项目自有「蜜蜂」标识。
- ⚠️ 表单若提示「仅支持 PNG」，用 `.png` 两个文件；`.jpg` 仅作兜底备用。

---

## 二、任务 2 · Android「应用签名」与「包名」最终填报值

### 2.1 🔴 直接可填的两项

| 开放平台字段 | **填报值** |
| --- | --- |
| **Android 应用包名** | `cn.com.dbee.app` |
| **Android 应用签名** | `0abe7fc5005987ed9b6eae9a45fb9dc9` |

格式自检（脚本输出）：`len=32 lowercase_hex=True no_colon=True` → **32 位、全小写十六进制、无冒号**，与开放平台输入框要求逐字吻合。

### 2.2 🔴「应用签名」到底是证书 MD5 还是公钥 MD5 —— 已定论：**证书 MD5**

lead 要求的这一项**不靠猜**，我下载了微信官方签名生成工具并反编译取证：

**取证路径**：微信官方文档《Android Open SDK 资源下载》第 4 节「签名生成工具」下载链接
（`https://developers.weixin.qq.com/doc/oplatform/Downloads/Android_Resource.html`）
→ `https://res.wx.qq.com/op_res/AFn-TrBu2ieKClEtVX7Dacv1isThBKRcf8Vyuzi7R0rJhgzyaCSEDiKZGpwOdjjEAVFLCSYrqZ5j2k4SspZ7iQ`
→ 下载到 12,047 B 的 zip，内含 **`Gen_Signature_Android.apk`**（13,678 B，8 个条目，含 `classes.dex` 8,224 B）。

**证据 A · dex 字符串表里只有「证书」概念，完全没有「公钥」概念**（全表 173 条已 dump）：

```
'Landroid/content/pm/PackageInfo;'   'getPackageInfo'   'getPackageManager'
'[Landroid/content/pm/Signature;'    'signatures'       'Landroid/content/pm/Signature;'
'getRawSignature'  'getSign'  'sign'  'signMd5'  'toByteArray'
'Lcom/tencent/mm/openapi/MD5;'  'MD5'  'MD5.java'  'getMessageDigest'
'Ljava/security/MessageDigest;'  'getInstance'  'update'  'digest'
'hexDigits'  'buffer'  'mdTemp'  'byte0'  'valueOf'  'append'
```
→ 全表**零命中** `getPublicKey` / `X509` / `PublicKey` / `RSA` / `modulus`。算法唯一可能是：
`PackageInfo.signatures[0].toByteArray()` → `MessageDigest("MD5")` → hex。
而 `android.content.pm.Signature.toByteArray()` 返回的正是**签名证书（X.509）的 DER 编码**。

**证据 B · `hexDigits` 字符表实测为小写**（在 dex offset `0xb2c` 找到 16 个 uint16 的 array-data）：

```
hexDigits array-data hits: [('0xb2c', 'lowercase a-f')]   # 0-9 + a-f
（同处扫描 'UPPERCASE A-F' → 零命中）
```
→ 官方工具输出**天然就是 32 位小写、无冒号**，无需任何后处理。

**证据 C · 数值级闭环复算**（决定性）：从 vc31 正式包的 APK Signature Scheme v2 块中解出那张 X.509 证书，对它做 `MD5(cert DER)`：

```
cert DER bytes            : 883
MD5(cert DER)             : 0abe7fc5005987ed9b6eae9a45fb9dc9   <- == Signature.toByteArray() 的 MD5
lead-provided cert MD5    : 0abe7fc5005987ed9b6eae9a45fb9dc9
MATCH                     : True
```

**结论：微信要的「应用签名」= 签名证书（X.509）的 MD5 = `0abe7fc5005987ed9b6eae9a45fb9dc9`。**
公钥 MD5 `55746718174a9ed39e71b351b0a24945` 是 apksigner 对 **SPKI DER** 另算的指纹，**微信开放平台不要这个值**，填了必然校验失败。

> 旁证（官方文档原文，微信支付《开发指引》）：
> 「应用签名:根据项目的应用包名和编译使用的keystore,可由签名工具生成一个**32位的md5串**」
> 官方社区置顶答复：「应用签名 = MD5信息.replaceAll(":", "").toLowerCase()」
> 二者与证据 A/B/C 完全一致。

### 2.3 独立复核：三条互不依赖的路径，结果完全一致

被核对象：`release/D-Bee-1.7.9-vc31-dbee.cn-FORMAL-20261119.apk`（9,800,369 B，SHA-256 `59139461f1add10bdc519179bf901e9a325cc23fd514cf85fddb6b038731ab81`）

**路径 1 · apksigner 36.0.0（PowerShell + JDK 21）**

```
Verifies
Verified using v1 scheme (JAR signing): false        ← 与 lead 一致，V1 未签（预期）
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme: false / v3.1: false / v4: false
Number of signers: 1
Signer #1 certificate DN: CN=D-Bee, OU=Mobile, O=D-Bee, L=Shenzhen, ST=Guangdong, C=CN
Signer #1 certificate SHA-256 digest: cd132445e1e771b2c3cf3d28d335707324df60b19c1e9368984fccfa19d26b09
Signer #1 certificate SHA-1   digest: cd1daf206e606c6825286f81e8bf39c8869ae720
Signer #1 certificate MD5     digest: 0abe7fc5005987ed9b6eae9a45fb9dc9   ← 填这个
Signer #1 key algorithm: RSA / key size (bits): 2048
Signer #1 public key SHA-256 digest: ea7e3f4249448726cbc62b5f45842a20581529fa949fc5ae2deba9909b1e969a
Signer #1 public key SHA-1   digest: 1136f2a0af7d550b8fc14f6acad5ada99431b079
Signer #1 public key MD5     digest: 55746718174a9ed39e71b351b0a24945   ← 微信不要这个
```

**路径 2 · 自写 v2 签名块解析器（不用 apksigner / openssl / keytool，纯 Python + cryptography）**

自行定位 EOCD → 中央目录 → `APK Sig Block 42` 魔数 → 遍历 id-length 对，取出 `0x7109871a`（v2）块，再按 DER 扫描提取 X.509：

```
signing block IDs: ['0x7109871a', '0x504b4453', '0x42726577']
X.509 certificates found in v2 block: 1        ← 单签名者，无证书链歧义
  subject       : CN=D-Bee,OU=Mobile,O=D-Bee,L=Shenzhen,ST=Guangdong,C=CN
  issuer        : CN=D-Bee,OU=Mobile,O=D-Bee,L=Shenzhen,ST=Guangdong,C=CN   ← 自签名
  serial        : 2BE04D1497C2C4C9
  validity      : 2026-10-23 -> 2056-10-15
  key alg/size  : RSA 2048
  CERT MD5      : 0abe7fc5005987ed9b6eae9a45fb9dc9
  CERT SHA-1    : cd1daf206e606c6825286f81e8bf39c8869ae720
  CERT SHA-256  : cd132445e1e771b2c3cf3d28d335707324df60b19c1e9368984fccfa19d26b09
  PUBKEY MD5    : 55746718174a9ed39e71b351b0a24945
```

**路径 3 · 仓库既有工具（keystore ↔ APK 双向交叉校验）**
`python tools/app-beian-signing.py android --apk release/D-Bee-1.7.9-vc31-dbee.cn-FORMAL-20261119.apk`（只读，密码经环境变量传 keytool、不回显不落盘）：

```
证书主体 DN：CN=D-Bee,OU=Mobile,O=D-Bee,L=Shenzhen,ST=Guangdong,C=CN
密钥算法：RSA 2048 ｜ 有效期：2026-10-23 → 2056-10-15
MD5    : 0abe7fc5005987ed9b6eae9a45fb9dc9
SHA-1  : cd1daf206e606c6825286f81e8bf39c8869ae720
SHA-256: cd132445e1e771b2c3cf3d28d335707324df60b19c1e9368984fccfa19d26b09
APK 交叉校验：…（37.0.0）verify=True，证书 SHA-256 与 keystore PASS；
              APK 内 MD5=0abe7fc5005987ed9b6eae9a45fb9dc9、SHA-1=cd1daf206e606c6825286f81e8bf39c8869ae720
包名：cn.com.dbee.app
```

→ **`android/keys/dbee-release.keystore`（alias `dbee`）里的证书 == 已发布 APK 里的证书**（SHA-256 逐字相同，cross_check = **PASS**）。
这条最关键：微信校验的是「平台上登记的签名」与「用户手机上实际安装的那个 APK 的签名」是否一致，keystore 与产物已对齐 = **后续所有版本（vc32/vc33…）只要仍用这把 keystore 签名，应用签名值永久不变**，无需回填开放平台。

### 2.4 包名的三处一致性（防止"改了包名忘了改平台"）

| 位置 | 值 | 证据 |
| --- | --- | --- |
| `applicationId` | `cn.com.dbee.app` | `android/app/build.gradle:16` |
| `namespace` | `cn.com.dbee.app` | `android/app/build.gradle:13` |
| Capacitor `appId` | `cn.com.dbee.app` | `capacitor.config.ts:25`；`ios/App/App/capacitor.config.json`、`android/app/src/main/assets/capacitor.config.json` 同值 |
| **已发布 APK 二进制 Manifest** | `package=cn.com.dbee.app` | 自写 AXML 解析器实测：`<manifest> versionCode=31 versionName=1.7.9 … package=cn.com.dbee.app` |
| iOS Bundle ID | `cn.com.dbee.app` | `ios/App/App.xcodeproj/project.pbxproj:320`、`:343`（行号已按 2026-11-22 加入 DEVELOPMENT_TEAM 后重测）|

→ Android 包名与 iOS Bundle ID 同为 `cn.com.dbee.app`，符合审核规范 1.1.5「同一应用在不同平台的版本应共用一个 AppID」。

### 2.5 ⚠️ 填报时必须避开的坑（工程侧已发现，务必转达用户）

1. 🔴 **不要用 `.env` 里现有的 AppID 当"移动应用 AppID"**。
   `.env:41` 实测 `VITE_WECHAT_APPID=wxb7c7122de9c3ab1f` —— 该值在仓库 8+ 处被明确标注为**小程序** AppID
   （证据：`docs/公安联网备案-四类申请材料清单与填报值-2026-11-20.md` §〇「新增小程序（`wxb7c7122de9c3ab1f`）」、`mini/project.config.json` 的 `appid`）。
   小程序 AppID 与移动应用 AppID **是两个不同应用、两套不同凭据**，混填必然报 `errcode=-6`（签名校验失败）或 invalid appid。
   → **本次在开放平台创建"移动应用"后会拿到一个新的 AppID，届时需替换 `.env:41`（另开会话做，本次禁改文件）。**
2. **签名值区分三个口径，不要串用**：
   | 用途 | 该填什么 | 值 |
   | --- | --- | --- |
   | **微信开放平台 · 移动应用 · 应用签名** | 证书 **MD5**（32 位小写无冒号） | `0abe7fc5005987ed9b6eae9a45fb9dc9` |
   | App 备案 · Android · 签名 MD5 值 | 证书 **MD5** | 同上（口径巧合一致，见 `signing/README.md`「Android：公钥填**模数**、签名值填 **MD5**」） |
   | App 备案 · Android · 平台公钥 | **RSA 模数**（不是公钥 MD5！） | 见 `release/App备案-三平台签名信息-20261107.md`（`B75808AA…4AD1`） |
   | 苹果/Google 侧校验 | 证书 **SHA-256** | `cd132445…6b09` |
3. **必须用"最终发布包"的签名**：本值取自 FORMAL 正式包（非 debug）。debug keystore 签名不同，若误用调试包的值登记，正式包会全量校验失败。
4. 该 APK **仅 V2 签名（V1=false）**属预期：`META-INF/` 内确认**无** `.RSA`/`.SF`（实测条目全为 `*.version` / `LICENSE.txt` / `services/*`），故 `keytool -printcert -jarfile` 报"不是已签名的 jar 文件"**不是错误**，请直接用 apksigner。

---

## 三、任务 3 · 微信 SDK 接入完备性核查（只读，未改任何代码）

图例：✅ 符合 ｜ ❌ 缺失 ｜ ⚠️ 需注意

### 3.a AndroidManifest.xml —— ✅ 符合（含 Android 13 坑已避开）

**源码层证据** `android/app/src/main/AndroidManifest.xml`：

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| `WXEntryActivity` `android:exported="true"` | ✅ | `:36` |
| `WXEntryActivity` `android:taskAffinity="${applicationId}"` | ✅ | `:38`（占位符由 AGP 展开为 `cn.com.dbee.app`） |
| `WXEntryActivity` `android:launchMode="singleTask"` | ✅ | `:37` |
| 🔴 `WXEntryActivity` **无 intent-filter**（Android 13 回跳坑） | ✅ **已避开** | `:34-39` 为**自闭合标签** `<activity … />`，标签内不可能有子元素；`:41-46`（WXPay）同理 |
| `WXPayEntryActivity` 三属性齐备 | ✅ | `:43`、`:45`、`:44` |
| 透明主题（避免回跳黑屏） | ✅ | `:39`、`:46` `Theme.Translucent.NoTitleBar` |
| 类路径 = `<applicationId>.wxapi.*` | ✅ | `:35` `.wxapi.WXEntryActivity` + `namespace=cn.com.dbee.app`；实体文件 `android/app/src/main/java/cn/com/dbee/app/wxapi/WXEntryActivity.java:1` `package cn.com.dbee.app.wxapi;` |

写法与微信官方《Android 接入指南》"Android 13 可能存在的问题适配"给出的正例**逐属性一致**（官方原文：「在 manifest 中，尝试去除 `WXEntryActivity` 的 intent-filter」；正例只含 `label`/`theme`/`exported`/`taskAffinity`/`launchMode`）。

**合并产物层证据**（`android/app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml:131-142`）：

```xml
<activity android:name="cn.com.dbee.app.wxapi.WXEntryActivity"
    android:exported="true" android:launchMode="singleTask"
    android:taskAffinity="cn.com.dbee.app"
    android:theme="@android:style/Theme.Translucent.NoTitleBar" />
<activity android:name="cn.com.dbee.app.wxapi.WXPayEntryActivity" … 同上 />
```
→ 两者均为自闭合，**合并后依然零 intent-filter**；`${applicationId}` 已正确展开。

**🔴 已发布 APK 二进制层证据（最强证据，自写 AXML 解析器直接解 `release/…vc31….apk!/AndroidManifest.xml`，15,072 B）**：

```
<activity> theme=0x1030010 name=cn.com.dbee.app.wxapi.WXEntryActivity    exported=true taskAffinity=cn.com.dbee.app launchMode=2
<activity> theme=0x1030010 name=cn.com.dbee.app.wxapi.WXPayEntryActivity exported=true taskAffinity=cn.com.dbee.app launchMode=2
```
两行**后面紧跟的就是下一个兄弟节点 `<provider>`**，即用户手机上装的那个包里，这两个 Activity **确实没有任何子节点**。
（`launchMode=2` = `singleTask`；`theme=0x1030010` = 框架透明主题。二进制里 `singleTask` 是枚举整数，故字符串池中查不到该字面量，属正常。）

### 3.a-2 软件包可见性 `<queries><package android:name="com.tencent.mm"/></queries>` —— ✅ 生效，但 ⚠️ 来源脆弱

| 层 | 结论 | 证据 |
| --- | --- | --- |
| 项目自身 Manifest | ⚠️ **没有**显式声明 | `android/app/src/main/AndroidManifest.xml` 全文 65 行**零** `<queries>` 标签（该文件 `:61-64` 只有 INTERNET / CAMERA 两条 uses-permission） |
| 依赖 AAR 提供 | ✅ 由插件带入 | `node_modules/@capgo/capacitor-wechat/android/src/main/AndroidManifest.xml:8-10` → `<queries><package android:name="com.tencent.mm" /></queries>`，注释明写「Android 11+ package visibility: required for isWXAppInstalled()… Without this, the OS always reports WeChat as not installed.」 |
| manifest merger 归属 | ✅ 实证由插件 ADD | `android/app/build/outputs/logs/manifest-merger-release-report.txt:418-419` → `package#com.tencent.mm` / `ADDED from [:capgo-capacitor-wechat] …\@capgo\capacitor-wechat\android\build\intermediates\merged_manifest\release\processReleaseManifest\AndroidManifest.xml:11:9-50` |
| 合并后 release Manifest | ✅ 存在 | `…/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml:57`（位于 `:47`–`:78` 的 `<queries>` 块内）；`…/packaged_manifests/release/processReleaseManifestForPackage/AndroidManifest.xml:57` 同 |
| **已发布 APK 二进制** | ✅ **确实打进去了** | AXML 解析实测：`<queries>` → `<package> name=com.google.android.apps.healthdata` → … → **`<package> name=com.tencent.mm`** |

**判定：功能上 ✅ 不缺**（targetSdk=36，`android/variables.gradle` 的 `targetSdkVersion = 36`；APK 二进制 `<uses-sdk> minSdkVersion=26 targetSdkVersion=36`），微信可被正常拉起。

**⚠️ 但存在一个真实的脆弱性，建议后续（非本次）补显式声明**：
该条目**完全依赖 `@capgo/capacitor-wechat` 这个第三方插件的 AAR**。一旦：
- 该插件被移除/替换（iOS 侧已经这么干了，见 `capacitor.config.ts:55` 的 ios 白名单不含它）；
- 或插件升级后删掉自己 Manifest 的 `<queries>`；
- 或 `includePlugins` 白名单被误改（`capacitor.config.ts:52`）；

→ `<queries>` 会**静默消失、构建照常成功、零报错**，症状只是"微信死活拉不起来 / `isWXAppInstalled()` 恒 false"，排查成本极高。
微信官方明确要求写在**主工程** Manifest（原文：「需要在主工程的 `AndroidManifest.xml` 中增加标签」）。
**建议（待另开会话执行，本次未改）**：在 `android/app/src/main/AndroidManifest.xml` 顶层补
```xml
<queries>
    <package android:name="com.tencent.mm" />
</queries>
```
（与插件的声明重复无害，merger 会去重；把这条从"依赖副作用"提升为"工程自有契约"。）
> 同一 `<queries>` 块里已有的 4 条支付宝包名来自 `com.alipay.sdk:alipaysdk-android:15.8.42` 的 AAR（`android/variables.gradle` 注释 ③ 已记载该 AAR 自带 `<queries>`），属同类"依赖隐式带入"，本次一并留意。

### 3.b 微信 Open SDK 依赖 —— ✅ 版本达标（≥6.8.0），但 ⚠️ 停在已停更的 artifact

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| app 模块直接依赖 | ✅ `6.8.0` | `android/app/build.gradle:65` → `implementation "com.tencent.mm.opensdk:wechat-sdk-android-without-mta:6.8.0"`；`:59-64` 注释说明为何必须显式再声明一次（插件内部用 `implementation` 不透出，而 app 的 wxapi 类继承插件的 `WechatResponseActivity`，编译期需可见 `IWXAPIEventHandler`） |
| 插件模块依赖 | ✅ 同版 `6.8.0` | `node_modules/@capgo/capacitor-wechat/android/build.gradle:56` 逐字相同 → **无版本分裂** |
| 插件版本 | `8.0.52` | `node_modules/@capgo/capacitor-wechat/package.json` `"version": "8.0.52"`；`package.json:34` `"@capgo/capacitor-wechat": "^8.0.52"`；`CapacitorWechatPlugin.java:60` `pluginVersion = "8.0.52"` |
| Gradle 工程已纳入 | ✅ | `android/capacitor.settings.gradle:20-21`（`include ':capgo-capacitor-wechat'`）；`android/app/capacitor.build.gradle:17`（`implementation project(':capgo-capacitor-wechat')`）；`capacitor.config.ts:52` android 白名单含它 |
| 版本 ≥ 6.8.0（Android 11 适配下限） | ✅ **恰好等于下限** | 官方原文：「**1）第三方应用需要更新微信 Android SDK 至 6.8.0 版本**…无论第三方应用 targetSdkVersion 是否升级为 30，均需要进行微信 Android SDK 版本升级适配」；`6.8.0` 更新日志即「适配 Android 11」 |
| **SDK 二进制确实进了正式包** | ✅ | 解 `release/…vc31….apk` 的 `classes.dex`/`classes2.dex`：引用到 **186** 个 `Lcom/tencent/mm/opensdk/…;` 类型，含关键标记 `Lcom/tencent/mm/opensdk/openapi/WXAPIFactory;`、`Lcom/tencent/mm/opensdk/constants/Build;` |
| AAR 自身版本自证 | ✅ `android 6.8.0` | `javap -constants com.tencent.mm.opensdk.constants.Build` → `SDK_VERSION_NAME = "android 6.8.0"`、`SDK_INT = 638058496` |

**⚠️ 需注意（真实风险，非洁癖）——`without-mta` 这个 artifact 已被官方弃更：**

Maven Central `maven-metadata.xml` 实测（2026-11-21）：

| artifact | latest / release | lastUpdated | 可用版本 |
| --- | --- | --- | --- |
| `wechat-sdk-android-without-mta`（**本项目在用**） | **6.8.0** | **20210913122738** | 6.6.4 … 6.8.0，**共 9 个，2021-09 后再无新版** |
| `wechat-sdk-android`（官方现行推荐） | **6.8.40** | **20260717070726** | 6.8.0 / .9 / .11 / .15 / .18 / .20 / **.24** / .26 / .28 / .30 / **.34** / **.38** / **.40** |

官方《Android Open SDK 资源下载》原文已明示迁移：「**（从 6.8.0 版本开始，请使用 `wechat-sdk-android`）**」，当前 SDK 版本号标注为 **6.8.34**（页面"基本信息"处），并给出 `api 'com.tencent.mm.opensdk:wechat-sdk-android:+'`。
→ 即：本项目锁的是**旧 artifact 的最后一版**，此后 5 年（2021→2026）的 13 个版本全部收不到。

**已反编译确认的具体技术缺口（6.8.0 的字节级问题）**：

```
javap -p -c com.tencent.mm.opensdk.channel.MMessageActV2   # sendUsingPendingIntent
   8: iconst_3
  10: ldc  #157   // int 134217728          ← 0x08000000 = FLAG_UPDATE_CURRENT
  12: invokestatic // android/app/PendingIntent.getActivity(Context,I,Intent,I)
# 同类中检索 FLAG_IMMUTABLE(0x04000000 = 67108864) 的命中数：
#   MMessageActV2          -> 0
#   BaseWXApiImplV10       -> 0        ← 全 SDK 无 FLAG_IMMUTABLE
```

- 6.8.24 的更新日志正是「**适配 `PendingIntent.FLAG_IMMUTABLE` 配置**」；6.8.0 缺它。
- 且该路径**在本项目必然被触发**：`WXAPIFactory.createWXAPI(ctx, appId, checkSig)` 字节码里 `iconst_2` 把 `launchMode` 硬编码为 **2**，而 `MMessageActV2.send` 的分支条件是 `if (Build.VERSION.SDK_INT >= 29 && Args.launchMode == 2) sendUsingPendingIntent(...)`。插件 `WechatManager.java:40` 用的正是这个三参重载 → **Android 10+ 设备上 100% 走 PendingIntent 分支**。
- 后果**不致命但会降级**：`getActivity` 的异常表实测为 `from 0 to 15 → target 32 (Class java/lang/Exception)`，catch 块内 `invokevirtual Context.startActivity(Intent)` —— 即抛异常后**回落老路径**，同时打日志 `sendUsingPendingIntent fail, ex =`。`BaseWXApiImplV10.launchWXUsingPendingIntent` 同构（catch → `openWXApp()`）。
  所以表现为：**功能仍在，但每次都白跑一次异常 + 走 legacy 分支**；而 6.8.38 还修了「Android 15 sendPendingIntent 报错」、6.8.34 修了「Android 15 PendingIntent 需显式指定启动方式」。本项目 `targetSdkVersion=36`（= Android 16 档），这些修复一个都没有。
- 另：6.8.0 的 AAR 自带 Manifest 只有 `<uses-sdk android:minSdkVersion="16" android:targetSdkVersion="28" />`，**不带** `<queries>`（已解包确认）—— 这解释了为什么 `com.tencent.mm` 的可见性声明只能靠插件补（§3.a-2），也说明升级 SDK 本身不会自动带来该条目。

**建议（待另开会话，本次未改任何 gradle）**：把依赖换成
`implementation "com.tencent.mm.opensdk:wechat-sdk-android:6.8.40"`（精确钉版、不用 `+`，与本项目 `alipaySdkVersion` 的钉版纪律一致，理由见 `android/variables.gradle` 注释），并把 `@capgo/capacitor-wechat` 内那条同步或用 `resolutionStrategy` 强制对齐，避免同构建内出现两个 opensdk 版本。
⚠️ 变更需真机回归微信登录/分享回跳，且**不得在本次会话执行**（`android/variables.gradle`、`app/capacitor.build.gradle` 正被另一会话修改）。

### 3.c WXEntryActivity / WXPayEntryActivity —— ✅ 工作机制已查清（lead 的 grep 零命中是**设计使然**，非缺失）

两个文件的**全部实质代码各只有一行**：

```java
// android/app/src/main/java/cn/com/dbee/app/wxapi/WXEntryActivity.java
package cn.com.dbee.app.wxapi;                                        // :1
import ee.forgr.plugin.capacitor_wechat.WechatResponseActivity;      // :3
public class WXEntryActivity extends WechatResponseActivity {}       // :16
```
```java
// android/app/src/main/java/cn/com/dbee/app/wxapi/WXPayEntryActivity.java
package cn.com.dbee.app.wxapi;                                        // :1
import ee.forgr.plugin.capacitor_wechat.WechatResponseActivity;      // :3
public class WXPayEntryActivity extends WechatResponseActivity {}    // :13
```

→ 所以 lead grep `APP_ID|appId|createAPI|IWXAPI` 在这两个文件里**零命中是正确的**：它们**故意不含任何逻辑**，全部委托给插件基类。`WXEntryActivity.java:10-11` 的注释也写明「这里不写任何逻辑，全部交给插件基类处理」。

**AppID 究竟从哪来（完整链路，逐跳有据）**：

```
[1] 构建期    .env:41  VITE_WECHAT_APPID=…
              ↓ Vite 注入
[2] JS 侧     src/lib/wechat.ts:76-78   wechatAppId() = import.meta.env.VITE_WECHAT_APPID
              src/lib/wechat.ts:81-83   wechatUniversalLink() = import.meta.env.VITE_WECHAT_UNIVERSAL_LINK
              src/lib/wechat.ts:141     const appId = wechatAppId()
              src/lib/wechat.ts:156     await plugin.initialize(universalLink ? {appId, universalLink} : {appId})
              ↓ Capacitor bridge
[3] 插件      CapacitorWechatPlugin.java:93-101  initialize(call) → appId = call.getString("appId")
                                                     → configureSdk(appId, universal, /*persist*/true)
              CapacitorWechatPlugin.java:342-355 configureSdk() → WechatManager.configure(context, appId)
                                                                → WechatPreferences.persist(context, appId, universal)
              ↓
[4] SDK 注册  WechatManager.java:29-42   configure(): api = WXAPIFactory.createWXAPI(appContext, appId, true)
                                                     api.registerApp(appId)
              WechatManager.java:48-57   getOrCreateApi(): 若 api==null → 从 SharedPreferences 读回 storedAppId → configure()
              ↓ 微信回调时
[5] 回调      WechatResponseActivity.java  onCreate/onNewIntent → handleIntent(intent)
                → IWXAPI api = WechatManager.getInstance().getOrCreateApi(this)
                → if (api == null) { finish(); return; }     ← 🔴 未配置 AppID 时静默 finish
                → api.handleIntent(intent, this)             ← 官方要求的这一步
              → onReq/onResp → WechatManager.handleRequest/handleResponse
              → 分发回 WebView 侧等待中的 Promise，随后 finish()
```

**持久化位置**：`WechatPreferences.java` → SharedPreferences 文件名 `CapacitorWechatConfig`，键 `appId` / `universalLink`（`WechatConstants.java:5-7`）。
**意义**：正因有这层持久化，微信回调 Activity 在**插件 `load()` 尚未跑完 / 进程被系统重建**时，仍能用上次的 AppID 自行 `createWXAPI`，回调不丢。

**两条 AppID 注入通路，本项目当前只接了第 2 条**：

| 通路 | 现状 | 证据 |
| --- | --- | --- |
| ① 静态：`capacitor.config.ts` 的 `plugins.CapacitorWechat.appId`（插件 `load()` 时读） | ❌ **未配置** | `CapacitorWechatPlugin.java:72-80` 会读 `getConfig().getString("appId")`；但 `capacitor.config.ts` / `android/app/src/main/assets/capacitor.config.json` / `ios/App/App/capacitor.config.json` 三份配置里**均无 `CapacitorWechat` 插件块**（grep `CapacitorWechat` 只命中 `capacitor.config.ts:34,41` 两处**注释**里的报错文字）。两份 `capacitor.config.json` 的 `plugins` 只有 `CapacitorHttp` |
| ② 运行时：JS 调 `initialize({appId, universalLink})` | ✅ 代码就绪，但**当前不会执行** | `src/lib/wechat.ts:156`；被 `:70 WECHAT_LOGIN_ENABLED = false` 与 `:73 NATIVE_CODE_EXCHANGE_SUPPORTED = false` 两道开关拦在前面（`:105`、`:110` 提前 return），故 `initialize()` 从不被调用 |

**⚠️ 需注意（当前状态是"设计性休眠"，不是 bug，但填报前必须知情）**：

1. `VITE_WECHAT_APPID` 非空（实测 len=18，`wxb7…` 开头）但**两道开关为 false** → 原生端 `isWechatLoginAvailable()` 恒 false（`src/lib/wechat.ts:105,110`）→ UI 隐藏微信入口 → `initialize()` 不被调用 → `WechatManager.api == null` → 即便微信真回调过来，`WechatResponseActivity` 也走 `finish()` 静默丢弃。
   → **本次开放平台登记不会因此受影响**（登记只需包名 + 签名 + 图标），但**登记完成后要真正跑通微信登录，需要三步联动改造**（另开会话）：换真移动应用 AppID → 打开两道开关 → 云端补「移动应用 code 换会话」接口（`src/lib/wechat.ts:42-49` 注释已详述该云端缺口：现有 `cloud.auth.signInWithWechat(code, appid)` 是给小程序 `wx.login` 走 `jscode2session` 用的，与移动应用的 `sns/oauth2/access_token` **不是同一个接口，不能混用**）。
2. 🔴 `WXEntryActivity.java:13-14` 的注释是一条**易被忽略的维护陷阱**，请在任何改包名的动作前读它：「包名与 AndroidManifest 里的 package / applicationId 必须严格一致，改名（applicationId 变更）后**这个目录也要同步改名**，否则回调永远收不到。」—— 因为微信 SDK 是按 `<包名>.wxapi.WXEntryActivity` 的**字面类名**回投的（`MMessageActV2` 字节码里实测有 `ldc ".wxapi.WXEntryActivity"` 拼接 targetPkgName）。目录 `android/app/src/main/java/cn/com/dbee/app/wxapi/` 与包名 `cn.com.dbee.app` 当前**严格对应** ✅。
3. `WXPayEntryActivity` 当前无业务用途（支付走商店内购/支付宝），但**必须存在**（`WXPayEntryActivity.java:9-11` 注释：微信 SDK 初始化后会检查它，缺失导致 SDK 行为异常）。已在 Manifest `:41-46` 声明、已进 APK ✅。
4. `minifyEnabled false`（`android/app/build.gradle:40`）→ 官方要求的 `-keep class com.tencent.mm.opensdk.**` 等混淆规则**当前不需要**；但**一旦将来开启 minify，必须同步补 proguard 规则**，否则回调类被混淆 → 微信找不到 `.wxapi.WXEntryActivity` → 静默失败。此项属预防性提醒，非当前缺陷。

### 3.d iOS Universal Links —— 🔴 **当前仍不具备**，缺 4 样（逐条给证据；2026-11-22 更新：原第 1 样 Team ID 已回填 `96BW23KM2C`）

> 🔴🔴 **本节适用范围声明（2026-11-22 20:31 补，纠正此前的语境混淆）**：本节 5 样缺口**全部属于「微信开放平台 iOS 平台登记」这一条线**（即将来若要在 iOS App 上做微信登录/微信分享时才需要），**与 App Store 提审线零关系**。
> - 🟢 **iOS 提审（TestFlight / submit / 上架）对本节任何一项的依赖 = 0。** 提审前置条件见 `docs/iOS提审前置条件与实施步骤-2026-11-22.md`，其中**不含**微信 SDK、不含 AASA、不含 Universal Links。
> - 🔴 **iOS 端微信支付被架构性禁止，不是「待补的缺口」**：① 代码硬门控 `src/lib/payment/wechatPay.ts:92` `if (!isAndroid() && !isWeb()) return false`（iOS 恒 false，无开关可打开）② 付费墙 iOS 走独立分支 `src/pages/PaywallSheet.tsx:121` `APPPAY_SALE_ENABLED && isAndroid()`，iOS 由 `:114/:140/:340` 导向 StoreKit ③ Apple 审核指南 **3.1.1** 要求 App 内数字商品必须用 IAP（`capacitor.config.ts:46-47` 已自陈）。**在 iOS 装微信/支付宝 SDK 来收款 = 主动制造拒审理由。**
> - 🔴 **iOS 端微信登录当前全平台关闭**：`src/lib/wechat.ts:70` `WECHAT_LOGIN_ENABLED = false`（营业执照未办），`:105` 所有端一律 `return false`。
> - 🟢 **项目既有裁定**：`填报速查表-一页纸.md` §四「**只勾 Android 平台，iOS 暂缓**」。本节内容仅作**将来解除暂缓时的技术备忘**，**当前不构成任何待办**。

**iOS 侧现状：连微信 SDK 都没装。**

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| iOS 插件白名单含微信插件？ | ❌ **不含** | `capacitor.config.ts:55` 的 `ios.includePlugins` 列表为 `['@dbee/origin-proxy','@capacitor/share','@capacitor/filesystem','@dbee/health','@dbee/iap','@capacitor/camera','@capacitor/app','@capacitor/preferences','@capacitor/local-notifications']` —— **无 `@capgo/capacitor-wechat`**；`:39-42` 注释说明原因（「iOS 必须排除微信插件：其 SPM 包名带连字符，与 Capacitor 8 的 CapApp-SPM 模板叠加会触发 SwiftPM 模块名转换兼容 bug（报 `Missing package product Wechat_CapgoCapacitorWechat`），导致 iOS 编译失败」）；对照 `:51-52` 的 android 白名单**含**该插件 |
| SwiftPM 里有微信包？ | ❌ 无 | `ios/App/CapApp-SPM/Package.swift` 全文 11 个 dependency，**零** Wechat 项；`Package.resolved` 检索 `echat` **零命中** |
| iOS 源码里有 WXApi？ | ❌ 无 | `grep -rn "continueUserActivity\|WXApi\|universalLink\|handleOpenURL" ios/App/App/*.swift` → **零命中** |
| `ios/App/App/` 全部 Swift 文件 | 仅 2 个 | `AppDelegate.swift`（9-44 行为标准 Capacitor 生命周期 + `configurationForConnecting`）、`SceneDelegate.swift`（1-24 行） |

**Universal Link 五要件逐项核查：**

| # | 要件 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | `App.entitlements` 有 `com.apple.developer.associated-domains` | ❌ **缺失** | `ios/App/App/App.entitlements` 全文仅 10 行，dict 内只有 `com.apple.developer.healthkit`（`:5-6`）与 `com.apple.developer.healthkit.access`（`:7-8`）两键，**无** associated-domains、**无** `applinks:` |
| 2 | entitlements 是否真的挂到 target | ✅ 已挂（好消息） | `ios/App/App.xcodeproj/project.pbxproj:308`、`:332` → `CODE_SIGN_ENTITLEMENTS = App/App.entitlements;`（Debug + Release 两个 config 都有）→ **将来只需往该 plist 加一个键，无需动 Xcode 工程接线**（行号已按 2026-11-22 加入 DEVELOPMENT_TEAM 后重测）|
| 3 | 仓库有 `apple-app-site-association` | ❌ **不存在** | `find . -iname "apple-app-site-association*" -not -path "./node_modules/*"` → **零结果**；`public/.well-known/` → `ls: cannot access 'public/.well-known': No such file or directory`（`public/` 只有 7 个文件：apple-touch-icon.png、favicon.png、icon-192/512.png、icon-maskable-512.png、manifest.webmanifest、sw.js） |
| 4 | 服务器侧有 `.well-known` 路由 | ❌ **没有，且会被 SPA 兜底吞掉** | `deploy/nginx.selfhost.conf.example` 的 location 清单为 `/assets/`(:41)、`= /sw.js`(:46)、`= /manifest.webmanifest`(:50)、`/.cloud/`(:59)、`/auth/`(:78)、`/`(:90) —— **无 `.well-known`**。而 `:90` 的 `location / { try_files $uri $uri/ /index.html; }` 意味着请求 `/.well-known/apple-app-site-association` 会**回落到 index.html（返回 HTML 而非 JSON）** → Apple 侧判定 AASA 无效。**必须新增一个精确 location 块** |
| 5 | `CFBundleURLSchemes` = 真 AppID | ❌ **仍是占位** | `ios/App/App/Info.plist:54` → `<string>wx0000000000000000</string>`；`:35-37` 注释自陈「此处保留占位值不会造成副作用…**但提审前必须替换**」 |
| — | `LSApplicationQueriesSchemes` 三项齐备 | ✅ | `ios/App/App/Info.plist:58-63` → `weixin`(:60)、`weixinULAPI`(:61)、`weixinURLParamsAPI`(:62)；仅 3 项，远在官方要求的"前 50 个"之内（官方：iOS 15 + Xcode 13 下第 50 个之后的 scheme 不生效） |
| — | Scene 侧 UL 转发钩子 | ✅ 骨架已在 | `ios/App/App/SceneDelegate.swift:21-23` → `func scene(_ scene: UIScene, continue userActivity: NSUserActivity) { SceneDelegateProxy.shared.scene(scene, continue: userActivity) }`。符合官方「适配了 SceneDelegate 的 App，系统将会回调 SceneDelegate 的 `continueUserActivity`」的要求；Capacitor 的 `SceneDelegateProxy` 会把它转给插件。**但因 iOS 未装微信插件，这条链目前是空转** |
| — | Apple Team ID（AASA 的 `appID` 前缀必需） | 🟢 **已回填 `96BW23KM2C`** | 2026-11-22 用户本人从 Apple Developer 后台取得并提供。已写入 `project.pbxproj:311`（Debug）、`:335`（Release）→ `DEVELOPMENT_TEAM = 96BW23KM2C;`（git 可追溯）。AASA 的 `appID` 据此可确定为 `96BW23KM2C.cn.com.dbee.app`（`<TeamID>.<BundleID>`，BundleID 见 `:320`、`:343`）|
| — | Bundle ID（AASA 后半段） | ✅ 已知 | `project.pbxproj:320`、`:343` → `PRODUCT_BUNDLE_IDENTIFIER = cn.com.dbee.app`（行号已按 2026-11-22 加入 DEVELOPMENT_TEAM 后重测）|
| — | 可用的已备案 HTTPS 域名 | ✅ 具备 | `d-bee.cn` 已上线（ICP `京ICP备2026075565号-2`），实测 HTTP 200 + 证书校验通过，见 `docs/公安联网备案-四类申请材料清单与填报值-2026-11-20.md` §1.1 表格；`.env.example:34` 也已预留 `VITE_WECHAT_UNIVERSAL_LINK=https://d-bee.cn/app/` |

**结论：iOS 要填 Universal Links 时，当前缺 4 样（按依赖顺序；2026-11-22 更新：原第 1 项 Team ID 已回填）**

1. ~~🔴 **Apple Developer Team ID**~~ 🟢 **已解决（2026-11-22）**：用户提供 `96BW23KM2C`，已写入 `project.pbxproj:311,335`。AASA 的 `appID` 可确定为 `96BW23KM2C.cn.com.dbee.app`，**不再阻塞 AASA 内容编写**。
2. 🔴 **Associated Domains 权限 + `applinks:d-bee.cn` 条目** → 需先在 Apple Developer 后台为 App ID `cn.com.dbee.app` 勾选 Associated Domains capability（签名主体 `DEVELOPMENT_TEAM = 96BW23KM2C` 现已配好，`CODE_SIGN_STYLE = Automatic` 下 Xcode 会自动管理证书），再往 `App.entitlements` 加键。官方原文：「**2）打开 Associated Domains 开关，将 Universal Links 域名加到配置上**」。
3. 🔴 **`apple-app-site-association` 文件 + nginx 路由** → 文件本身工程侧可写（JSON，无需签名，内容已可完整确定：`{"applinks":{"apps":[],"details":[{"appID":"96BW23KM2C.cn.com.dbee.app","paths":["/app/*"]}]}}`，Team ID 阻塞已解除）；但 `deploy/nginx.selfhost.conf.example` 仍需新增 `.well-known` location 并保证 `Content-Type: application/json` + 不缓存 + 不被 SPA 兜底覆盖（本次**禁止改既有文件**，故未动）。
4. 🔴 **iOS 侧微信 SDK 集成** → 需先解决 `capacitor.config.ts:39-42` 记载的 SwiftPM 模块名兼容 bug（`Missing package product Wechat_CapgoCapacitorWechat`），或改用 CocoaPods `pod 'WechatOpenSDK-XCFramework'`（官方 iOS 接入指南 §4.1；⚠️ 该工程当前**没有 Podfile**，`ios/App/` 下仅 `App/`、`App.xcodeproj/`、`CapApp-SPM/`、`DbeeProducts.storekit`，故走 CocoaPods 等于新建一套依赖管理）。**这是 UL 之前的更前置阻塞**：没有 SDK，配好 UL 也无处 `registerApp:universalLink:`。🟢 **2026-11-22 20:20 实测补充**：`@capgo/capacitor-wechat@8.0.52` 包**自带完整 iOS 实现**（`ios/Sources/CapacitorWechatPlugin/` 6 个 Swift 文件 + `CapgoCapacitorWechat.podspec` + 自带 `Package.swift`），当前未装**纯粹是 `capacitor.config.ts:55` iOS 白名单主动排除**（Android 白名单 :52 含它）。两条集成路径实测细节：**CocoaPods 路径更短**——podspec 现成（`s.dependency 'WechatOpenSDK', '~> 2.0'` = 官方 pod），`pod 'CapgoCapacitorWechat', :path => '../../node_modules/@capgo/capacitor-wechat'` 即可，无需手接裸 SDK；**SPM 路径有供应链隐患**——插件 `Package.swift:14` 依赖的是**个人镜像** `github.com/yanyin1986/WechatOpenSDK.git`（非 tencent 官方源，可用性/完整性不受控），叠加模块名转换 bug，故不推荐。
5. 🔴 **真 AppID 替换占位** → `Info.plist:54` 的 `wx0000000000000000` 换成移动应用 AppID；同时 `.env` 的 `VITE_WECHAT_UNIVERSAL_LINK`（实测**当前为空**）填 `https://d-bee.cn/app/`。

**微信对 Universal Link 的硬性格式要求（官方 iOS 接入指南原文，填报时照抄）**：
- 「a）Universal Links **必须支持 https**」
- 「b）Universal Links 配置的 **paths 不能带 query 参数**」
- 「c）微信使用 Universal Links 拉起第三方 App 时，会**在 Universal Links 末尾拼接路径和参数**，因此 App 配置的 **paths 必须加上通配符 `/*`**」
- 「**建议 Universal Links 配置 path，例如 `/app/*`，避免全域命中 Universal Links 跳转**」
- 示例：`{ "appID": "8P7343TG54.com.tencent.xin.SDKSample", "paths": ["/sdksample/*"] }`
- 开放平台表单侧口径：「Universal Links，请填写能唤起当前应用的 Universal Links 路径（**https 开头，以"/"结尾，建议带 path，比如 `https://your_domain/app/`**），在实际调用 SDK 时，会校验 Universal Links 是否匹配」

→ **推荐填报值**：`https://d-bee.cn/app/`（与 `.env.example:34` 预留值一致；域名已备案+已上线，path 带 `/app/` 前缀满足"避免全域命中"）。
→ **配套 AASA**：`https://d-bee.cn/.well-known/apple-app-site-association`，`paths` 写 `["/app/*"]`（务必带通配符，否则微信拼参数后回跳失败 → 官方明示症状：「授权登录如出现二次确认弹窗，原因是微信无法通过 App 提供的 Universal Links 返回」）。
⚠️ **但在 §3.d 的 1、4 两项落地前，开放平台 iOS 段的 Universal Links 字段建议先留空或暂不勾选 iOS 平台** —— 填一个尚未生效的 UL 会让后续 SDK 校验直接失败，且该字段修改需重新提审。

---

## 四、任务 4 · ❌ 工程侧无法代做、必须用户本人准备的缺口清单

### 4.1 🔴 硬阻塞（没有这些，移动应用**根本提交不了**）

| # | 缺口 | 为什么工程侧做不了 | 用户需做什么 |
| --- | --- | --- | --- |
| 1 | **微信开放平台企业主体账号 + 开发者资质认证** | 需营业执照、对公账户打款验证、法人/管理员身份与人脸识别，全程账号实名操作 | 主体：**北京迪蜂科技有限公司**（见 `docs/公安联网备案-…-2026-11-20.md` 抬头）。若尚未认证，先完成开放平台「开发者资质认证」（¥300/年） |
| 2 | **移动应用 AppID 本身** | AppID 是审核**通过后**由平台生成的，不存在于任何代码/文件中 | 提交创建申请 → 等审核 → 拿到新 AppID → 回填 `.env:41`（替换掉当前的小程序 AppID，见 §2.5-1） |
| 3 | **应用运行流程图（真实 App 截图，≤10 张）** | 官方明文：「这里指的是开发者的 **App 真实访问进去到 App 后看到的截图**，**不可提供小程序的截图**」。需真机安装 vc31 正式包实拍，**不可 PS** | 真机跑一遍主流程（首页 → 拍照/扫码识别 → 记录 → 我的/会员），逐屏截图。仓库 `deploy/screenshots/` 现有素材**不能直接用**：`cal-*.png`/`preview-*.png`/`legal-*.png` 是 **Web 端 127.0.0.1 或 d-bee.cn 的浏览器截图**（文件名即证据），`creative/` 是 16:9/21:9/3:2 的**营销宣传图**（`creative-16x9-5244x2950-v0.png` 等，5.2 MB），均非"App 内真实截图"，且宣传图属"已加工"性质 |

> ⚠️ **关于第 3 项的口径分歧（需 lead 裁决）**：本会话写报告期间，**另一会话并发产出**了 `deploy/wechat-open-platform/flow/`（4 张流程逻辑图，`render-flow.mjs` + `verify-flow.mjs` 渲染，实测 `flow-01` 3200×2598/0.53 MB、`flow-02` 3200×2202/0.39 MB、`flow-03` 3200×2408/0.62 MB、`flow-04` 3200×2202/0.58 MB，**全部满足 ≤5MB 上限**）。该脚本头注释（`render-flow.mjs:5-10`）主张平台原文允许「APP运行流程图，或**相关交互设计图、流程逻辑图**等」，并指出 `deploy/screenshots/store/*.png` 系 Playwright + `src/preview-mock.ts` **演示数据**生成（`shot-store.mjs:19` 自述"截图用演示数据，非真实用户记录"）故不符"真实截图"要求。
> 两条判断**并不冲突**：演示数据截图确实不能用，流程图确实是可用的补充材料。但本次我核到的官方《移动应用基本资料填写说明》§7 原文写的是「开发者的 **App 真实访问进去到 App 后看到的截图**，不可提供小程序的截图」，**未出现**"或交互设计图/流程逻辑图"字样 —— 该放宽口径可能来自平台**表单页面上的实时提示文案**（会随版本变动，我无法从工程侧取证）。
> **建议做法（最稳）**：以**真机实拍截图为主体**（满足 §7 硬要求），流程图作为**补充材料**一并上传（总额 ≤10 张，官方明文「总数量不可超过 10 张」，且允许在此处附著作权/授权证明）。若用户暂时无法真机实拍，则退而只用流程图，并在「申请/修改应用说明」里说明"App 处于内测阶段，附业务流程图"。**是否接受纯流程图，请 lead 向平台侧或用户确认后再定，本会话不做推测性结论。**
| 4 | **应用官网内容合规** | 官网代码**不在本仓库**（`packages/shared/src/constants/index.ts:67` 明写「官网不在本仓库」；nginx 走独立 server 块 root `/var/www/d-bee-corp`） | 官网 `d-bee.com.cn` 需含齐 5 项：应用服务功能详情、用户协议、版权所有者、网站备案信息、联系方式；且功能描述要与「移动应用简介」一一对应。⚠️ 官方还要求「**官网不支持提供手机端小程序、公众号和 H5 等页面类型**」，且「所提供的官网不得是无法访问应用详细信息的登录界面」 |
| 5 | **应用类目** | 需在开放平台后台「管理中心 → 应用类目 → 添加应用类目」先行申请，与账号绑定 | 按 App 实际服务选（本项目为饮食/热量记录 + 健康管理方向）。官方：「你在申请或变更应用前需先自行添加和应用匹配的类目，**再发起应用的申请和变更**」——顺序不能反 |

### 4.2 🟠 填报时需用户判断的字段（工程侧只能给事实，不能替填）

| 字段 | 工程侧能提供的事实 | 需用户决定 |
| --- | --- | --- |
| **移动应用名称** | 代码内一致名称为「自律蜜蜂」（`capacitor.config.ts:26` `appName`）/「D-Bee」（`Info.plist:10` `CFBundleDisplayName`）；Android 桌面名取 `@string/app_name` | 官方限制：≤10 中文字符或 ≤20 英文字符；只允许字母间一个空格；**不得含"微信/腾讯/小程序/公众号"及"小米/百度/360/魅族/vivo"等品牌字样**；不得含"测试/test/DEMO"；不得带平台字样（如"自律蜜蜂Android版"会被驳）；半年只能改 1 次 → 建议填 **自律蜜蜂**（不带任何平台后缀） |
| **应用简介（≤80 字）** | 官网标题可参考：「AI 拍照识别饮食热量，让每一口都吃得明白」（`docs/公安联网备案-…md` §1.1 实测记录） | 需与官网介绍**一一对应**，且不得含营销口号（"**赚、**分享"类会被驳） |
| **应用已上架 / 应用市场** | 事实：Android 有自建下载页（`tools/gen-download-page.mjs`、`VITE_APP_DOWNLOAD_LINK` 预留 `https://d-bee.cn/download/`），但**自建下载页 ≠ 应用市场**；iOS 未上架 App Store | 官方：「如你的应用当前仍处于开发调试阶段（即 App 尚未上架任何应用市场），则选择「未上架任何应用市场」」，但**同时警告**：「未上架应用的相关能力会受限，且如果选择「未上架任何应用市场」会**同时影响 Android、iOS 以及鸿蒙应用的上架状态**，开发者需谨慎操作」→ 🔴 这是个有副作用的选择题，需用户拍板 |
| **App 备案号** | ✅ **已有值**：`京ICP备2026075565号-3A`（App 备案号，2026-11-18 下证；证据 `docs/公安联网备案-…-2026-11-20.md` §1.2 表格「**App 备案**｜应用（非域名）｜✅ 已下证（11-18）」） | 仅当上一项选「已上架至少一个应用市场」时才需填；🔴 **务必填 `-3A`（App 备案号），不要误填网站 ICP 的 `-1`/`-2`**（官方口径见同文档 §1.2：「需精确到 `-1` 和 `-2`」，三号严格区分） |
| **iOS 平台信息（Bundle ID / UL / AppStore 地址）** | Bundle ID = `cn.com.dbee.app` ✅；UL = 建议 `https://d-bee.cn/app/` 但**当前不生效**（§3.d）；AppStore 下载地址 = 未上架，可置空 | 🔴 建议**本次先只勾 Android 平台**，待 §3.d 五项落地后再补 iOS —— 否则 UL 填了个空壳，SDK 校验必失败且改字段需重新提审 |
| **申请/修改应用说明（≤200 字）** | 事实依据：本项目当前微信能力处于**关闭**状态（`src/lib/wechat.ts:70,73` 两道开关 false） | 按需说明申请该能力的理由（如"为 App 增加微信登录能力"）。若官网需测试账号才能进，可在此备注账号信息 |

### 4.3 🟡 工程侧"能做但本次被禁止做"的事项（另开会话执行）

> 本次任务硬约束为「**不得修改任何既有文件**、不得 commit/push/build」，故以下**只记录、未执行**：

| # | 待办 | 涉及文件（均为既有文件，本次未碰） | 优先级 |
| --- | --- | --- | --- |
| 1 | 主工程 Manifest 显式补 `<queries><package android:name="com.tencent.mm"/></queries>`，把包可见性从"依赖副作用"变成工程自有契约 | `android/app/src/main/AndroidManifest.xml` | 中（当前功能正常，仅抗风险） |
| 2 | 微信 SDK 从停更的 `wechat-sdk-android-without-mta:6.8.0` 迁到 `wechat-sdk-android:6.8.40`（拿到 FLAG_IMMUTABLE / Android 15 PendingIntent 修复） | `android/app/build.gradle:65`、`android/variables.gradle`（钉版常量） | 中（当前有 catch 兜底，不致命） |
| 3 | 拿到真移动应用 AppID 后替换 `.env:41`（现为小程序 AppID），并按需打开 `WECHAT_LOGIN_ENABLED` / `NATIVE_CODE_EXCHANGE_SUPPORTED` | `.env`、`src/lib/wechat.ts:70,73` | 高（登记完成后） |
| 4 | iOS：解决 SwiftPM 模块名 bug 或改 CocoaPods 接入微信 SDK；补 `App.entitlements` 的 `applinks:d-bee.cn`；替换 `Info.plist:54` 占位 AppID | `capacitor.config.ts:55`、`ios/App/App/App.entitlements`、`ios/App/App/Info.plist:54`、`ios/App/CapApp-SPM/Package.swift` | 高（做 iOS 微信前必做，且需 Mac） |
| 5 | 部署 AASA：新建 `public/.well-known/apple-app-site-association`（或 nginx 静态目录）+ 新增 nginx 精确 location（`Content-Type: application/json`、不缓存、不被 SPA 兜底覆盖） | `deploy/nginx.selfhost.conf.example`、`public/`、`vite.config.ts`（确保 `.well-known` 进产物且不被改名） | 高（🟢 Team ID 阻塞已解除，AASA 内容可完整编写：`appID = 96BW23KM2C.cn.com.dbee.app`）|
| 6 | 云端补「移动应用 code 换会话」接口（走 `sns/oauth2/access_token`，**不是**小程序的 `jscode2session`） | 云端网关侧（`deploy/gateway/`，本次明令禁碰） | 🔴 **最高**：这是原生微信登录能否真正跑通的**唯一硬缺口**（`src/lib/wechat.ts:42-49` 已详述） |
| 7 | 若将来开启 `minifyEnabled`，同步补官方要求的 proguard keep 规则 | `android/app/build.gradle:40`、`android/app/proguard-rules.pro` | 低（当前 minify=false，不需要） |

---

## 五、本次操作合规自证（硬约束遵守情况）

| 约束 | 遵守情况 | 证据 |
| --- | --- | --- |
| 不修改任何既有文件 | ✅ | `git status --porcelain` 中 12 个 `^ M` 文件的 **mtime 全部早于本会话**（`android/variables.gradle` 11-20 11:58、`capacitor.config.ts` 11-20 12:31、`package.json` 11-20 12:01、`src/lib/payment/alipay.ts` 11-20 12:33 等，均为**另一条会话**的 vc32/支付宝改动）；本会话**唯一写入**是 `deploy/wechat-open-platform/` 下 6 个新文件，mtime 全为 `2026-11-21 15:00:54`（README.md 稍后） |
| 不删除任何文件 | ✅ | 全程零 `rm`/`del`；`deploy/wechat-open-platform/` 为**新建**目录（`ls -la deploy/` 显示其 mtime 为 11-21 15:00，其余条目未变） |
| 目录归属说明（⚠️ 有并发写入者） | 已如实标注 | 本报告完成后发现 `deploy/wechat-open-platform/flow/` 子目录（`flow-01…04-*.png`、`flow-assets.html`、`render-flow.mjs`、`verify-flow.mjs`，mtime 11-21 16:19–16:21）**不是本会话产物** —— 系另一会话/成员并发写入同一目录。本会话产物**严格限于**：`logo-28x28.png`、`logo-28x28.jpg`、`logo-108x108.png`、`logo-108x108.jpg`、`logo-512x512.png`（mtime 15:00:54）+ `README.md`（本文件）。两者无文件名冲突，未互相覆盖 |
| 不 commit / 不 push | ✅ | 未执行任何 `git add`/`commit`/`push`；`git check-ignore -v` 确认新目录**未被 gitignore 排除**（即处于可 add 的 untracked 状态，交由 lead 决定何时提交） |
| 不跑构建 | ✅ | **未执行** `npm run build` / `build:native` / `cap sync` / `gradlew`。仅调用了**只读**的 `apksigner verify --print-certs`、`javap`（读 AAR/jar）、`python tools/app-beian-signing.py android`（该工具只读 keystore + 调 keytool `-exportcert` 到内存、`--out` 未传即只打印 stdout，**不写文件**） |
| 敏感信息纪律 | ✅ | `android/keystore.properties` 仅以 `sed 's/=.*/=<REDACTED>/'` 掩码查看键名；密码全程经**进程环境变量**传 keytool（工具 `:161-183` 的 `-storepass:env` 机制），**未打印、未落盘、未进命令行参数**。`.env` 只读取 `VITE_WECHAT_APPID`（AppID 属**公开信息**，已存在于 HEAD 的 `mini/project.config.json` 等 8+ 跟踪文件，见 `.workbuddy/memory/2026-11-16.md:318` 的既有定性），其余键一律掩码 |
| 外部下载隔离 | ✅ | 官方 Gen_Signature 工具下载到 **`/tmp/dbw/`（仓库外）**，未进仓库、未安装到任何设备、未执行；仅静态解包读 `classes.dex` 字节 |

---

## 六、复现命令（供 QA / 后续会话原样重跑）

```bash
# 1. 图标生成 + 自验（Pillow 12.3.0，已探测可用）
python -c "import PIL; print(PIL.__version__)"          # -> 12.3.0
#   生成脚本核心：Image.open('public/icon-512.png').convert('RGB')
#                .resize((28|108, 28|108), Image.LANCZOS) -> PNG optimize / JPEG quality=92 subsampling=0
#   512 版为 shutil.copyfile 原样拷贝（不重编码）

# 2. Android 签名（路径 1：apksigner，需 JAVA_HOME）—— 建议用 PowerShell 调 .bat，Git Bash 下引号易错
#    $env:JAVA_HOME="E:\YuDevTools\jdk-21.0.12.1"
#    & "C:\Users\yuty\AppData\Local\Android\Sdk\build-tools\36.0.0\apksigner.bat" verify --print-certs -v `
#      "C:\...\zilv-mifeng\release\D-Bee-1.7.9-vc31-dbee.cn-FORMAL-20261119.apk"

# 3. Android 签名（路径 3：仓库既有工具，keystore<->APK 交叉校验，只读）
python tools/app-beian-signing.py android --apk "release/D-Bee-1.7.9-vc31-dbee.cn-FORMAL-20261119.apk"

# 4. 已发布 APK 的二进制 Manifest 结构核查（自写 AXML 解析器，只读；证明 wxapi 无 intent-filter、queries 含 com.tencent.mm）
#    关键：解 EOCD -> 中央目录偏移 -> 'APK Sig Block 42' -> id 0x7109871a(v2) -> DER 扫描取 X.509 -> MD5(cert DER)

# 5. 微信 SDK 版本事实
curl -s https://repo1.maven.org/maven2/com/tencent/mm/opensdk/wechat-sdk-android-without-mta/maven-metadata.xml | grep -E "latest|release|lastUpdated"
curl -s https://repo1.maven.org/maven2/com/tencent/mm/opensdk/wechat-sdk-android/maven-metadata.xml          | grep -E "latest|release|lastUpdated"
javap -cp "<gradle-cache>/…/wechat-sdk-android-without-mta-6.8.0/jars/classes.jar" -constants com.tencent.mm.opensdk.constants.Build
javap -cp "…" -p -c com.tencent.mm.opensdk.channel.MMessageActV2      # 看 sendUsingPendingIntent 的 flags=134217728(仅 FLAG_UPDATE_CURRENT)

# 6. 官方口径取证
#   《Android Open SDK 资源下载》 https://developers.weixin.qq.com/doc/oplatform/Downloads/Android_Resource.html   （第 4 节「签名生成工具」下载链接）
#   《Android 接入指南》          https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Access_Guide/Android.html（Android 11 <queries> / Android 13 intent-filter）
#   《iOS 接入指南》              https://developers.weixin.qq.com/doc/oplatform/Mobile_App/Access_Guide/iOS.html    （Universal Links a/b/c 三条硬性要求）
#   《应用审核规范》              https://developers.weixin.qq.com/doc/oplatform/Mobile_App/operation.html          （1.1 名称 / 1.2 图标）
#   《移动应用基本资料填写说明》   https://developers.weixin.qq.com/doc/oplatform/Mobile_App/guideline/basic_info.html（官网/图片/类目/流程图/备案号）
```

---

*报告完 · 生成于 2026-11-21 · 工程（Alex）· 所有数值均为本机实测，未使用任何记忆值或推断值*
