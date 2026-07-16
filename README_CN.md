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

## 当前唯一推荐安装方式

现在只推荐这一种用户安装路径：

### Windows

```powershell
claude mcp add --scope user codepage-bridge -- npx -y codepage-bridge-mcp
claude mcp get codepage-bridge
```

### macOS / Linux

```bash
claude mcp add --scope user codepage-bridge -- npx -y codepage-bridge-mcp
claude mcp get codepage-bridge
```

它做的事情是：

- 通过已发布的 npm 包注册 Claude Code MCP；
- 使用 `npx -y codepage-bridge-mcp` 启动 MCP；
- 自动验证 MCP 是否连接成功。

它要求本机已有：

- `claude`
- `node`

但**不需要**：

- `git clone`
- `npm install`
- `npm run build`
- 先手动下载 GitHub Release 包

---

## 为什么需要 Codepage Bridge

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

## 使用前提

需要本机已经安装：

- Node.js 20+
- Claude Code

可选：

- `pdfinfo`
- `pdftoppm`

用于 PDF 页面渲染。

### Windows 检查

```powershell
node --version
claude --version
```

### macOS / Linux 检查

```bash
node --version
claude --version
```

---

## 安装后必须做的配置

仅安装 MCP 还不够。

如果不做下面这些配置，Claude Code 仍然可能继续调用内置：

- `Read`
- `Grep`
- `Edit`
- `Write`
- `NotebookEdit`

这些工具不会遵循 `.encoding-rules`。

### 第 1 步：合并 `settings.fragment.json`

把下面内容合并到你的 `~/.claude/settings.json`：

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

模板文件：

- `examples/claude-config/settings.fragment.json`

注意：不要整份覆盖已有 `settings.json`，除非文件本来就是空的。

### 第 2 步：加一个 `CLAUDE.md`

把下面策略加到项目 `CLAUDE.md`，或者加到全局 `~/.claude/CLAUDE.md`：

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

模板文件：

- `examples/minimal-project/CLAUDE.md`

### 第 3 步：为项目添加 `.encoding-rules`

每个要使用 Codepage Bridge 的项目根目录都必须有 `.encoding-rules`。

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

模板文件：

- `examples/minimal-project/.encoding-rules`

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

---

## 如何验证是否真的生效

### 1. 检查 MCP 连接状态

```bash
claude mcp get codepage-bridge
```

你应该看到：

- 名称：`codepage-bridge`
- 状态：`Connected`

### 2. 启动一个新的 Claude Code 会话

### 3. 让 Claude 读取或搜索一个 legacy 编码文件

例如：

```text
Read SourceCode/Main.cpp and show the first 10 lines.
```

或者：

```text
Search SourceCode for the string 错误码.
```

### 4. 确认调用的是桥接工具

应调用：

- `mcp__codepage-bridge__Read`
- `mcp__codepage-bridge__Grep`
- `mcp__codepage-bridge__Edit`
- `mcp__codepage-bridge__Write`

不应调用内置：

- `Read`
- `Grep`
- `Edit`
- `Write`

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

### Claude 仍然使用内置工具

原因：

- 没有 deny 内置工具；
- 没有加 `CLAUDE.md`；
- 会话没有重开。

---

## 维护者说明

### npm 包状态

这个包已经发布到 npm，可以直接通过下面方式拉起：

```bash
npx -y codepage-bridge-mcp
```

### Plugin / Marketplace 状态

仓库已经具备：

- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.mcp.json`
- `commands/setup.md`
- `commands/setup-project.md`
- `commands/doctor.md`

### GitHub Release

仓库仍保留：

- GitHub Release 打包
- 多平台压缩包
- `.sha256`
- `checksums.txt`

但这些不再是本 README 的主要安装路径。

### 自动发布

GitHub Release workflow 已切换为 npm Trusted Publishing + GitHub OIDC。

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
