# Git 工作流（Windows ↔ Mac mini 双机同步）

> 目的：让 Windows 侧（Android 构建 + 日常开发）与 Mac mini M4（iOS 构建）之间
> **只通过 Git 私有仓库交换代码**，不使用 iCloud / 共享目录 / U 盘。原因：macOS 与
> Windows 的换行符（CRLF/LF）与文件权限位差异，会在 Capacitor 的 iOS 原生工程里
> 制造极难排查的构建错误。

- 远端仓库：`https://github.com/yutaiyin139/d-bee.git`
- 默认分支：`main`
- 基线提交：`f99a2c5`

---

## 一、两端都必须做的一次性配置

```bash
# 1) 关闭自动换行转换：仓库内与工作区一律 LF（配合仓库里的 .gitattributes）
git config --global core.autocrlf false

# 2) 中文文件名正常显示，不转义成 \xxx
git config --global core.quotepath false

# 3) 身份（两台机器保持一致，避免提交作者不一致）
git config --global user.name  "yutaiyin"
git config --global user.email "13911111170@139.com"
```

`.gitattributes` 已随仓库提供并强制 `* text=auto eol=lf`：**Windows 上也不会把源码
转成 CRLF**。因此不要把 `core.autocrlf` 设成 `true`，否则会对冲掉这条规则。

---

## 二、首次克隆

### 常规（网络可达 GitHub）

```bash
git clone https://github.com/yutaiyin139/d-bee.git
cd d-bee
npm ci
```

### 离线（GitHub 不可达时的兜底）

仓库基线已导出为 `backups/d-bee-baseline-f99a2c5.bundle`（633 KB，含完整历史）。
把它拷到 Mac mini 后：

```bash
git clone d-bee-baseline-f99a2c5.bundle d-bee
cd d-bee
git remote add origin https://github.com/yutaiyin139/d-bee.git
# 网络恢复后再补推
git push -u origin main
```

> `git bundle` 是 Git 官方的离线传输格式，等价于「把一个仓库打包成一个文件」，
> 不是普通压缩包——克隆后可继续正常 commit / fetch / merge。
> 校验完整性：`git bundle verify <file>`

---

## 三、日常同步命令

```bash
# 开工前：拉取对方机器的提交
git pull --rebase origin main

# 收工前：提交并推送
git add -A
git commit -m "feat: 描述这次改了什么"
git push origin main
```

**纪律**：一台机器开始改代码前先 `git pull --rebase`；不要在两台机器上同时编辑同一个
文件——iOS 与 Android 的代码改动几乎不重叠，冲突本可避免。

---

## 四、入库规则（见 .gitignore）

| 路径 | 是否入库 | 原因 |
|---|---|---|
| `src/` `db/` `deploy/` `docs/` `public/` `tools/` | ✅ 入库 | 源码与文档 |
| `node_modules/` | ❌ | `npm ci` 可复原 |
| `dist/` | ❌ | 构建产物，两端各自生成 |
| `backups/` | ❌ | 体积大且含发布归档 |
| `db/CREDENTIALS.txt`、`.env` | ❌ | 凭据 |
| `.workbuddy/tmp/` | ❌ | 本地草稿 |
| `.workbuddy/memory/` | ✅ 入库 | 跨机保留工作上下文与进度记录 |

> **新增凭据类文件时，先加到 `.gitignore` 再创建**，避免误提交后需要重写历史。

---

## 五、提交信息约定

```
<类型>: <一句话说明>

<可选：为什么这么改 / 影响范围>
```

类型：`feat`（新功能）、`fix`（修缺陷）、`refactor`（重构）、`chore`（构建/配置）、
`docs`（文档）。阶段 2/3 的原生能力接入建议在正文注明对应的过审条款（如 `3.1.1`）。

---

## 六、GitHub 不可达时的处理

本机（Windows）当前**无法直连 github.com**：走本机代理会被拦（`CONNECT tunnel failed, 502`），
不走代理则连接超时。可行方案任选：

1. 在你有可用代理的网络环境下推送：
   ```bash
   git config --global http.proxy http://127.0.0.1:<你的代理端口>
   # 用完记得清掉，否则会影响其他仓库
   git config --global --unset http.proxy
   ```
2. 改用 SSH：`git remote set-url origin git@github.com:yutaiyin139/d-bee.git`（需先配 SSH key）。
3. 换 Gitee 私有仓库作为主远端（国内直连稳定），GitHub 作为镜像。
4. 用上文的 `git bundle` 在机器间离线传递。

> 第 3 条对双机协作的稳定性最好——但无论选哪条，**都不要退回共享目录方案**。
