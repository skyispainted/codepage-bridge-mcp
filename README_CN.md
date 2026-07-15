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

- market 一键安装
- 自动注册 MCP
- 不需要本地 `git clone`
- 不需要本地 `npm install`
- 安装后只需完成极少量配置

目前还没上 market，所以现在请使用 **GitHub Release 安装**。

### 方案 B：GitHub Release 安装（当前最推荐）

这是当前最适合普通用户的安装方式。

它**不需要**：

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

## 通过 GitHub Release 安装（推荐给普通用户）

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
- npm
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

## 通过 GitHub Release 安装（当前最推荐）

这是当前最适合普通用户的安装方式。

它会自动：

- 下载当前平台对应的预构建发布包；
- 解压到用户目录；
- 自动注册 Claude Code MCP。

它**不需要**：

- 本地 `git clone`
- 本地 `npm install`
- 本地 `npm run build`

但仍然要求本机已有：

- `claude`
- `node`

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install\install-from-release-windows.ps1
```

### macOS / Linux

```bash
bash ./install/install-from-release-unix.sh
```

安装指定版本：

#### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install\install-from-release-windows.ps1 -Version v0.1.0
```

#### macOS / Linux

```bash
bash ./install/install-from-release-unix.sh v0.1.0
```

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

#### macOS / Linux

```bash
test -f ./dist/src/server.js && echo ok
```

---

## 配置 Claude Code MCP

### 方案 A：用户级安装

适合你希望所有项目都可用。

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

应看到：

- 名称：`codepage-bridge`
- 状态：`Connected`

### 方案 B：项目级安装

适合你想把 MCP 配置和项目一起提交。

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

第一次打开项目时，Claude Code 可能需要审批该项目 MCP。

---

## 最重要：必须禁用 Claude Code 内置文件工具

**只安装 MCP 还不够。**

如果不禁用 Claude Code 内置工具，模型仍然可能继续调用：

- `Read`
- `Grep`
- `Edit`
- `Write`
- `NotebookEdit`

这些工具不会遵循 `.encoding-rules`。

### 修改 `~/.claude/settings.json`

把以下内容合并进你现有的 settings 文件：

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

### 重要提醒

- 不要整份覆盖已有 `settings.json`，除非该文件原本就是空的。
- 应该把上述 `allow` 和 `deny` 项合并进你已有的配置。

仓库里有最小片段示例：

- `examples/claude-config/settings.fragment.json`

---

## 还要加一个 `CLAUDE.md`

即使内置工具被 deny，模型仍然可能试图用 shell / PowerShell / Python 绕过编码桥。

建议在项目 `CLAUDE.md` 或全局 `~/.claude/CLAUDE.md` 中加入：

```markdown
## File encoding policy

Use Codepage Bridge for all project file content operations:

- Read with `mcp__codepage-bridge__Read`.
- Search with `mcp__codepage-bridge__Grep`.
- Edit with `mcp__codepage-bridge__Edit`.
- Create or completely rewrite with `mcp__codepage-bridge__Write`.

Do not use built-in Read, Grep, Edit, Write, NotebookEdit, shell commands,
PowerShell commands, or scripts as substitutes for project file content access.
Glob may only be used to discover paths.

Do not manually transcode files or normalize line endings. `.encoding-rules`
is the source of truth.
```

为什么要同时配：

- `settings.json`：从工具列表层面禁掉内置工具；
- `CLAUDE.md`：防止模型用脚本或 shell 绕过。

模板见：

- `examples/minimal-project/CLAUDE.md`

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
- `#` 开头行为注释；
- 支持 `*`、`**`、`?`；
- 无 `/` 的模式（如 `*.cpp`）会匹配任意目录层级的 basename；
- 含 `/` 的模式相对于 `.encoding-rules` 所在目录；
- 最后一条匹配规则生效；
- `!pattern` 取消先前匹配，回到严格 UTF-8；
- 未命中规则的文件使用严格 UTF-8；
- 最近的 `.encoding-rules` 同时决定项目根边界。

支持的编码示例：

```text
utf8
utf-16le
gbk
gb2312
gb18030
big5
shift_jis
euc-kr
windows-1251
windows-1252
```

模板见：

- `examples/minimal-project/.encoding-rules`

---

## 最小模板目录

仓库已自带最小配置模板：

- `examples/minimal-project/.encoding-rules`
- `examples/minimal-project/.mcp.json`
- `examples/minimal-project/CLAUDE.md`
- `examples/claude-config/settings.fragment.json`

可以直接复制后改路径使用。

---

## 如何验证是否真的生效

### 1. 检查 MCP 连接状态

```bash
claude mcp get codepage-bridge
```

应看到：

- `Scope`：user 或 project
- `Status`：`Connected`

### 2. 启动一个新 Claude Code 会话

### 3. 让 Claude 读取一个 legacy 编码文件

例如：

```text
Read SourceCode/Main.cpp and show the first 10 lines.
```

### 4. 确认调用的是桥接工具

在 verbose / print 模式中，应看到调用的是：

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

```json
{
  "file_path": "C:\\project\\SourceCode\\Main.cpp",
  "offset": 1,
  "limit": 200,
  "pages": "1-5"
}
```

行为：

- 按 `.encoding-rules` 解码成 Unicode；
- 返回带行号文本；
- 超过 256 KiB 的文本文件要求使用 `offset` 和 `limit`；
- 同一文件多次分段 Read 会合并覆盖范围；
- 文件变化后覆盖状态会失效；
- 支持图片、PDF 页面和 Notebook 读取；
- Notebook 不支持文本行级 `offset/limit`。

### `Grep`

```json
{
  "pattern": "error|failed",
  "path": "C:\\project",
  "glob": "**/*.log",
  "output_mode": "content",
  "-i": false,
  "-n": true,
  "-C": 2,
  "head_limit": 250,
  "offset": 0
}
```

支持：

- `content` / `files_with_matches` / `count`
- `glob`
- 常见 `type` 过滤
- `-i` / `-n` / `-o`
- `-A` / `-B` / `-C` / `context`
- `multiline`
- `head_limit` / `offset`

每个候选文件会按自己的最近 `.encoding-rules` 解码后搜索。显式单文件解码失败会直接报错，而不是伪装成 0 匹配。

### `Edit`

```json
{
  "file_path": "C:\\project\\SourceCode\\Main.cpp",
  "old_string": "old text",
  "new_string": "new text",
  "replace_all": false
}
```

行为：

- 不要求整文件都读完；
- 只要 `old_string` 覆盖的每一行都被实际返回给模型，就允许编辑；
- 大文件中唯一目标只需读目标附近几行；
- `replace_all: true` 时，每个匹配都必须已读；
- 未读目标会明确提示缺失行号范围；
- 写入前会重新读文件并检查 hash；
- 保留原编码、BOM 和主导换行；
- 无法表示的字符会拒绝写入。

### `Write`

```json
{
  "file_path": "C:\\project\\SourceCode\\NewFile.cpp",
  "content": "full content"
}
```

行为：

- 新文件按 `.encoding-rules` 选择编码；
- 已存在文件仍要求完整 Read；
- 保留已有文件编码和 BOM；
- 整体重写按调用方提供的换行内容写回。

---

## 维护者发布流程

发布新版本：

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Release workflow 会自动：

- 执行类型检查；
- 执行完整测试；
- 构建项目；
- 裁剪开发依赖；
- 打包多平台发布产物；
- 生成 SHA256 校验文件；
- 上传到 GitHub Releases。
## 常见问题排查

### `No .encoding-rules found`

原因：

- 项目根没有 `.encoding-rules`；
- 访问的文件不在该项目树内。

### `Invalid byte sequence for utf-8`

原因：

- 该文件实际不是 UTF-8；
- 规则没匹配到目标文件。

修复：

- 确认规则文件存在；
- 确认规则匹配嵌套目录；
- 语言级规则优先写成 `*.cpp gbk` 这类 basename 模式。

### `Text contains characters not representable in ...`

原因：

- 新文本无法表示成目标编码。

修复：

- 修改文本；
- 或明确调整该文件编码规则。

### `The target text has not been read`

原因：

- 模型想编辑的目标行没有真正读过。

修复：

- 按报错提示读取精确行范围；
- 再执行 Edit。

### `Pending approval`

原因：

- 项目 `.mcp.json` 还没有被 Claude Code 批准。

### `Failed to connect`

检查：

- `node --version`
- `claude --version`
- `dist/src/server.js` 是否存在
- `claude mcp get codepage-bridge`

如有必要重新执行：

```bash
npm install
npm run build
```

### Claude 仍然使用内置工具

原因：

- 没有 deny 内置工具；
- 没有加 `CLAUDE.md`；
- 会话没有重开。

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

当前自动化覆盖：

- 规则优先级
- basename 递归匹配
- 严格解码与拒绝损失写入
- stale write 防护
- 原子写
- 符号链接边界
- 图片 / PDF / Notebook 读取
- GBK 读写编辑流程
- Grep 多种模式
- 大文件完整/局部编辑授权
- MCP 协议注册与端到端验证

## 许可证

MIT，见 [LICENSE](LICENSE)。
