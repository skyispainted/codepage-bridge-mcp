# Codepage Bridge MCP（中文说明）

[English README](README.md)

Codepage Bridge 是一套面向 Claude Code 和其他 MCP 客户端的**编码透明文件工具**。

它提供以下四个 MCP 工具：

- `Read`
- `Grep`
- `Edit`
- `Write`

这些工具会根据最近的 `.encoding-rules`，把项目文件从磁盘上的传统编码（如 GBK、Big5、Shift-JIS 等）解码成 Unicode 提供给模型；写回时再严格编码回原规则指定的编码。

也就是说：

- LLM 看到的是正常 Unicode 文本；
- 磁盘上的文件仍保持项目原本的编码体系；
- 如果新文本无法表示为目标编码，会直接报错，而不是偷偷写成 `?`。

---

## 安装方式概览

你现在有三种安装方式：

### 方案 A：Marketplace 安装（即将提供）

这将来会成为普通用户最简单的安装方式。

目标体验：

- market 一键安装；
- 自动注册 MCP；
- 不需要本地 `git clone`；
- 不需要本地 `npm install`；
- 安装后只需极少量手动配置。

目前还没上 market，所以现在请使用 **GitHub Release 安装**。

### 方案 B：GitHub Release 安装（当前最推荐）

这是当前最适合普通用户的安装方式。

你有两种使用路径：

1. **你已经下载并解压好了 Release 包**；
2. **你想让脚本帮你下载 Release 包**。

这两种方式都**不需要**：

- 本地 `git clone`
- 本地 `npm install`
- 本地 `npm run build`

但仍然要求本机已有：

- `claude`
- `node`

### 方案 C：源码安装（仅面向开发者）

只有在以下场景才建议使用：

- 你要开发 Codepage Bridge 本身；
- 你要调试安装问题；
- 你要修改或审查源码实现。

如果你只是普通使用者，不建议把源码安装作为首选入口。

---

## 通过 GitHub Release 安装（当前最推荐）

这是普通用户当前最合适的安装方式。

### 路径 1：你已经下载并解压好了 Release 包

如果你当前就处于一个已解压好的 Release 包目录中，推荐直接使用本地包安装脚本。

#### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install\install-this-release-windows.ps1
```

#### macOS / Linux

```bash
bash ./install/install-this-release-unix.sh
```

它会：

- 检查当前目录是否真的包含 `dist/src/server.js`；
- 直接使用当前解压包注册 Claude Code MCP；
- **不会再次下载**。

### 路径 2：你还没下载 Release 包

如果你希望脚本自动去 GitHub Release 下载，再注册 MCP，使用下载脚本。

#### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install\download-release-windows.ps1
```

#### macOS / Linux

```bash
bash ./install/download-release-unix.sh
```

它会：

- 请求 GitHub Release API；
- 下载当前平台对应的发布包；
- 解压到用户目录；
- 自动注册 Claude Code MCP。

### 安装指定版本

#### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install\download-release-windows.ps1 -Version v0.1.0
```

#### macOS / Linux

```bash
bash ./install/download-release-unix.sh v0.1.0
```

### 兼容脚本

仓库中保留了兼容入口：

- `install-from-release-windows.ps1`
- `install-from-release-unix.sh`

它们的行为是：

- 如果当前目录已经是解压包，就直接本地安装；
- 如果当前目录不是解压包，就回退到下载模式。

因此更清晰的推荐是直接使用：

- `install-this-release-*`
- `download-release-*`

而不是继续依赖兼容入口。

---

## 源码安装（仅面向开发者）

只有在以下场景才建议使用：

- 你要开发 Codepage Bridge 本身；
- 你要调试安装问题；
- 你要修改或审查源码实现。

### 1. 克隆仓库

```bash
git clone git@github.com:skyispainted/codepage-bridge-mcp.git
cd codepage-bridge-mcp
```

### 2. 安装依赖

```bash
npm install
```

### 3. 构建

```bash
npm run build
```

入口文件：

```text
dist/src/server.js
```

### 4. 确认构建产物存在

#### Windows

```powershell
Test-Path .\dist\src\server.js
```

#### macOS / Linux

```bash
test -f ./dist/src/server.js && echo ok
```

### 5. 或使用源码安装脚本

#### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install\install-from-source-windows.ps1
```

#### macOS / Linux

```bash
bash ./install/install-from-source-unix.sh
```

---

## 适用场景

如果你的项目还在使用这些编码：

- GBK / GB2312 / GB18030
- Big5
- Shift-JIS
- EUC-KR
- Windows-1251 / Windows-1252
- UTF-16

那么 Claude Code 的内置 `Read` / `Grep` / `Edit` / `Write` 很容易出现：

- 中文注释乱码；
- 搜索不到真实内容；
- 编辑后把文件误写成 UTF-8；
- 旧代码页文件被破坏。

Codepage Bridge 就是为了解决这个问题。

---

## 核心特性

- 按 `.encoding-rules` 透明解码/写回。
- 支持 `Read`、`Grep`、`Edit`、`Write`。
- 最近的 `.encoding-rules` 决定项目根与生效规则。
- 最后一条匹配规则生效。
- `!pattern` 表示取消之前匹配并回到严格 UTF-8。
- `*.cpp` 这类无目录分隔符规则会匹配任意层级目录。
- `Edit` 支持大文件局部编辑：只要模型读过目标行，就可以修改，不必整文件读取。
- 写入前会重新读取并做 hash 校验，防止 stale write。
- 保留 BOM 与主导换行风格。
- 原子写入、路径锁、符号链接边界保护。
- 支持图片、PDF、Notebook 的读取。

---

## 前置要求

需要本机已经安装：

- Node.js 20+
- npm（仅源码安装需要）
- Claude Code

可选：

- `pdfinfo`
- `pdftoppm`

用于 PDF 页面渲染。

### Windows 检查

```powershell
node --version
npm --version
claude --version
```

### macOS / Linux 检查

```bash
node --version
npm --version
claude --version
```

---

## 配置 Claude Code MCP

你可以按两种范围安装：

- **用户级**：所有项目通用；
- **项目级**：跟随某一个仓库。

### 方案 A：用户级安装

#### Windows

```powershell
claude mcp add --scope user codepage-bridge -- node C:\absolute\path\to\codepage-bridge-mcp\dist\src\server.js
```

#### macOS / Linux

```bash
claude mcp add --scope user codepage-bridge -- node /absolute/path/to/codepage-bridge-mcp/dist/src/server.js
```

验证：

```bash
claude mcp get codepage-bridge
claude mcp list
```

### 方案 B：项目级安装

在项目根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "codepage-bridge": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/codepage-bridge-mcp/dist/src/server.js"
      ]
    }
  }
}
```

项目级模板见：

- `examples/minimal-project/.mcp.json`

---

## 最重要：必须禁用 Claude Code 内置文件工具

仅安装 MCP 还不够。

如果不禁用 Claude Code 内置工具，模型仍然可能继续调用：

- `Read`
- `Grep`
- `Edit`
- `Write`
- `NotebookEdit`

这些工具不会遵循 `.encoding-rules`。

### 修改 `~/.claude/settings.json`

把以下内容合并到现有文件中：

```json
{
  "permissions": {
    "allow": [
      "mcp__codepage-bridge__Read",
      "mcp__codepage-bridge__Grep",
      "mcp__codepage-bridge__Edit",
      "mcp__codepage-bridge__Write"
    ],
    "deny": [
      "Read",
      "Grep",
      "Edit",
      "Write",
      "NotebookEdit"
    ]
  }
}
```

不要整份覆盖已有 `settings.json`，除非文件本来就是空的。

模板见：

- `examples/claude-config/settings.fragment.json`

---

## 还要加一个 `CLAUDE.md`

即使内置工具被 deny，模型仍可能尝试用 shell / PowerShell / Python 绕过编码桥。

建议在项目 `CLAUDE.md` 或全局 `~/.claude/CLAUDE.md` 里加入策略。

模板见：

- `examples/minimal-project/CLAUDE.md`

为什么要同时配：

- `settings.json`：从工具层禁用内置工具；
- `CLAUDE.md`：防止模型使用脚本绕过。

---

## `.encoding-rules` 怎么写

每个要使用 Codepage Bridge 的项目根目录，都必须有 `.encoding-rules`。

示例：

```text
# Last matching rule wins
*.c gbk
*.cpp gbk
*.h gbk
legacy/**/*.txt windows-1251
assets/**/*.csv shift_jis
**/*.json utf8

# Cancel earlier matches and return to strict UTF-8
!SourceCode/generated/**
```

语法：

```text
<glob-pattern> <encoding>
```

规则说明：

- 空行忽略；
- `#` 开头为注释；
- 支持 `*`、`**`、`?`；
- 无 `/` 的模式（如 `*.cpp`）会匹配任意层级 basename；
- 含 `/` 的模式相对于 `.encoding-rules` 所在目录；
- 最后一条匹配规则生效；
- `!pattern` 取消先前匹配，回到严格 UTF-8；
- 未命中规则的文件使用严格 UTF-8；
- 最近的 `.encoding-rules` 同时决定项目根边界。

模板见：

- `examples/minimal-project/.encoding-rules`

---

## 最小模板目录

仓库已自带最小配置模板：

- `examples/minimal-project/.encoding-rules`
- `examples/minimal-project/.mcp.json`
- `examples/minimal-project/CLAUDE.md`
- `examples/claude-config/settings.fragment.json`

---

## 如何验证是否真的生效

### 1. 检查 MCP 连接状态

```bash
claude mcp get codepage-bridge
```

### 2. 启动一个新 Claude Code 会话

### 3. 让 Claude 读取或搜索一个 legacy 编码文件

### 4. 确认调用的是：

- `mcp__codepage-bridge__Read`
- `mcp__codepage-bridge__Grep`
- `mcp__codepage-bridge__Edit`
- `mcp__codepage-bridge__Write`

而不是内置：

- `Read`
- `Grep`
- `Edit`
- `Write`

---

## 四个工具怎么工作

### `Read`

- 按 `.encoding-rules` 解码成 Unicode；
- 返回带行号文本；
- 超过 256 KiB 的文本文件要求使用 `offset` 和 `limit`；
- 同一文件多次分段 Read 会合并覆盖范围；
- 文件变化后覆盖状态会失效；
- 支持图片、PDF 页面和 Notebook 读取；
- Notebook 不支持文本行级 `offset/limit`。

### `Grep`

- 支持 `content` / `files_with_matches` / `count`；
- 支持 `glob`；
- 支持常见 `type` 过滤；
- 支持 `-i` / `-n` / `-o`；
- 支持 `-A` / `-B` / `-C` / `context`；
- 支持 `multiline`；
- 支持 `head_limit` / `offset`。

### `Edit`

- 不要求整文件都读完；
- 只要目标行已读，就允许编辑；
- `replace_all` 时所有匹配都必须已读；
- 未读目标会明确报缺失行号；
- 保留原编码、BOM 和主导换行；
- 无法表示的字符会拒绝写入。

### `Write`

- 新文件按 `.encoding-rules` 选择编码；
- 已存在文件仍要求完整 Read；
- 保留已有编码和 BOM；
- 整体重写按调用方换行内容写回。

---

## NPM_TOKEN 自动发布说明

GitHub Release workflow 现在会在打包 release 资产之前，先自动发布 npm 包。

仓库维护者必须在 GitHub Secrets 中配置：

- NPM_TOKEN`r

重要：如果某个 npm token 曾经被贴到聊天、终端截图、日志或其他公开位置，请立即在 npm 后台撤销并重新生成新的发布 token，再写入 GitHub Secrets。

## 维护者发布流程

发布新版本：

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Release workflow 会自动：`r`n`r`n- 使用 `NPM_TOKEN` 自动发布 npm 包；

- 执行类型检查；
- 执行完整测试；
- 构建项目；
- 裁剪开发依赖；
- 打包多平台产物；
- 生成 SHA256 校验文件；
- 上传到 GitHub Releases。

---

## npm 发布准备状态

仓库现在已经具备 npm 发布条件。

### 发布包内容

最终 npm 包只包含：

- `dist/src/`
- `.claude-plugin/`
- `.mcp.json`
- `install/`
- `examples/`
- `README.md`
- `README_CN.md`
- `LICENSE`

不会发布：

- `src/`
- `test/`
- `node_modules/`
- 项目私有 `.claude/`
- 本地构建缓存

### 发布前检查

`prepublishOnly` 已配置为自动执行：

```bash
npm run check
npm test
npm run build
```

### 打包预检查

正式发布前先执行：

```bash
npm pack --dry-run
```

用于确认最终发布包内容。

### 发布步骤

1. 登录 npm：

```bash
npm login
```

2. 发布包：

```bash
npm publish
```

3. 验证：

```bash
npx -y codepage-bridge-mcp
```

只要这一步成功，market / 插件安装链路就真正闭环了，因为插件根 `.mcp.json` 已经指向：

```json
{
  "mcpServers": {
    "codepage-bridge": {
      "command": "npx",
      "args": ["-y", "codepage-bridge-mcp"]
    }
  }
}
```
## 最终的 Marketplace 发布与安装方案

Codepage Bridge 现在已经同时具备：

- **插件结构就绪**
- **npm 发布就绪**

### 已经完成的部分

- 插件清单已就绪：
  - `.claude-plugin/plugin.json`
  - `.claude-plugin/marketplace.json`
- 插件根 MCP 声明已就绪：
  - `.mcp.json`
- 插件命令已就绪：
  - `/setup`
  - `/setup-project`
  - `/doctor`
- `package.json` 已具备 npm 发布所需元数据
- `npm pack --dry-run` 已验证通过
- `claude plugin validate . --strict` 已通过

### 在真正支持 market 安装之前，还差什么

1. 登录 npm
2. 发布 `codepage-bridge-mcp`
3. 把本仓库加入 Claude Code marketplace 源
4. 从 market 安装插件

### 实际发布清单

本地执行：

```bash
npm login
npm whoami
npm pack --dry-run
npm publish
```

发布后验证：

```bash
npx -y codepage-bridge-mcp
```

只要这一步成功，就说明插件里的 `.mcp.json` 启动方式已经可用于 marketplace 安装。

### npm 发布后，market 安装的目标流程

1. 在 Claude Code 中添加或更新 marketplace 源
2. 从 marketplace 安装插件
3. 执行 `/setup`
4. 合并 `examples/claude-config/settings.fragment.json`
5. 添加项目 `.encoding-rules`
6. 添加 `CLAUDE.md` 策略

### 重要限制

market 安装可以安装插件并声明 MCP，但想安全使用仍然依赖项目配置：

- deny 内置 `Read` / `Grep` / `Edit` / `Write` / `NotebookEdit`
- 所有文件内容操作必须走 Codepage Bridge
- legacy 编码项目必须提供 `.encoding-rules`
## 常见问题排查

### `No .encoding-rules found`

原因：

- 项目根没有 `.encoding-rules`；
- 访问文件不在项目树内。

### `Invalid byte sequence for utf-8`

原因：

- 文件实际不是 UTF-8；
- 规则没有匹配到目标文件。

### `Text contains characters not representable in ...`

原因：

- 新文本无法表示成目标编码。

### `The target text has not been read`

原因：

- 模型试图编辑它没真正看到的目标行。

### `Pending approval`

原因：

- 项目 `.mcp.json` 还没被批准。

### `Failed to connect`

检查：

- `node --version`
- `claude --version`
- `dist/src/server.js` 是否存在
- `claude mcp get codepage-bridge`

### Claude 仍然使用内置工具

原因：

- 没有 deny 内置工具；
- 没有加 `CLAUDE.md`；
- 会话未重开。

---

## 安全注意事项

1. `.encoding-rules` 要提交到项目中。
2. 在大规模编辑前，先用 `Read` 或 `Grep` 验证规则是否匹配正确。
3. 优先用 basename 规则描述整类源码，例如 `*.cpp gbk`。
4. 不要静默转换编码。
5. 不要用 shell 或脚本绕过桥接层。
6. 该 MCP 对项目根内文件有读写能力，只应在可信项目中启用。
7. 编码安全不等于语义正确，仍需审查 diff。
8. PDF 支持依赖 Poppler，可选安装。
9. 不提供 `NotebookEdit`。
10. Windows UNC / device path 会在 I/O 前直接拒绝。

---

## 开发

```bash
npm install
npm run check
npm test
npm run build
npm start
```

## 许可证

MIT，见 [LICENSE](LICENSE)。
