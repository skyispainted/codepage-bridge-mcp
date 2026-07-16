# Codepage Bridge MCP（中文说明）

[English README](README.md)

Codepage Bridge 是给 Claude Code 用的一组文件工具。

它解决的问题很简单：

如果你的项目不是 UTF-8，而是 GBK、Big5、Shift-JIS、UTF-16 这类编码，Claude Code 自带的 `Read`、`Grep`、`Edit`、`Write` 很容易把文件读乱、搜错、改坏。

Codepage Bridge 会按项目里的 `.encoding-rules` 读写文件：

- 读文件时，先按规则解码，再把正常文字给模型；
- 改文件时，按原规则再写回去；
- 如果新内容不能用目标编码表示，会直接报错，而不是偷偷写坏。

---

## 适合什么项目

适合这些情况：

- C / C++ 老项目还在用 GBK；
- Windows 老项目用 `windows-1251`、`windows-1252`；
- 日文项目用 `Shift-JIS`；
- 一部分文件是 UTF-16；
- Claude Code 一读文件就乱码，或者一改文件就把编码改坏。

---

## 安装（推荐方式）

只需要执行下面两条命令：

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

如果第二条命令显示 `Connected`，说明安装成功。

---

## 安装前提

你的电脑里需要已经有：

- `claude`
- `node`

可以先检查：

### Windows

```powershell
claude --version
node --version
```

### macOS / Linux

```bash
claude --version
node --version
```

---

## 安装完以后，还必须做的三件事

安装 MCP 只是第一步。要让 Claude Code 真正稳定地使用它，还要做下面三件事。

### 1. 禁用 Claude Code 内置文件工具

不禁用的话，模型还是可能继续调用内置：

- `Read`
- `Grep`
- `Edit`
- `Write`
- `NotebookEdit`

这些工具不会遵循 `.encoding-rules`。

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

现成模板：

- `examples/claude-config/settings.fragment.json`

> 不要整份覆盖已有 `settings.json`，除非那个文件本来就是空的。

---

### 2. 加一个 `CLAUDE.md`

即使你禁掉了内置工具，模型仍可能想用 shell、PowerShell、Python 脚本去绕过编码桥。

所以建议在项目根目录加一个 `CLAUDE.md`，内容类似：

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

现成模板：

- `examples/minimal-project/CLAUDE.md`

---

### 3. 给项目加 `.encoding-rules`

每个要使用 Codepage Bridge 的项目根目录，都必须有 `.encoding-rules`。

例如：

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

现成模板：

- `examples/minimal-project/.encoding-rules`

规则含义：

- `*.cpp gbk`：所有 cpp 文件按 GBK 处理；
- `**/*.json utf8`：所有 JSON 按 UTF-8；
- `!pattern`：取消前面的规则，回到严格 UTF-8；
- 最后一条匹配规则生效。

---

## 怎么确认它真的在工作

### 第一步：检查 MCP 已连接

```bash
claude mcp get codepage-bridge
```

你应该看到：

- 名称：`codepage-bridge`
- 状态：`Connected`

### 第二步：重开一个新的 Claude Code 会话

### 第三步：让 Claude 读取或搜索一个旧编码文件

例如：

```text
Read SourceCode/Main.cpp and show the first 10 lines.
```

或者：

```text
Search SourceCode for the string 错误码.
```

### 第四步：确认它调用的是桥接工具

应该调用：

- `mcp__codepage-bridge__Read`
- `mcp__codepage-bridge__Grep`
- `mcp__codepage-bridge__Edit`
- `mcp__codepage-bridge__Write`

不应该调用：

- `Read`
- `Grep`
- `Edit`
- `Write`

---

## 它具体能做什么

### Read

- 按 `.encoding-rules` 解码文件；
- 大文件支持 `offset` / `limit` 分段读；
- 支持图片、PDF、Notebook 读取。

### Grep

- 支持按内容搜索；
- 支持 `content` / `files_with_matches` / `count`；
- 支持 `glob`、`type`、上下文行、分页。

### Edit

- 不要求整文件都读完；
- 只要目标行已经读过，就可以改；
- 改之前会重新检查文件有没有变化；
- 保留原编码、BOM 和换行风格。

### Write

- 新文件按 `.encoding-rules` 选择编码；
- 已有文件要求先完整读过；
- 会保留已有文件的编码和 BOM。

---

## 常见问题

### 1. `No .encoding-rules found`

说明项目根没有 `.encoding-rules`，或者你读的文件不在项目根范围内。

### 2. `Invalid byte sequence for utf-8`

说明这个文件实际上不是 UTF-8，但你的规则没匹配到它。

最常见修法：

```text
*.cpp gbk
*.h gbk
```

### 3. `Text contains characters not representable in ...`

说明你要写入的新字符，目标编码表示不了。

### 4. `The target text has not been read`

说明模型想改的那几行，它其实还没真正读过。按提示再补读那几行即可。

### 5. Claude 还是在用内置工具

通常是因为：

- 没有配置 `deny`
- 没加 `CLAUDE.md`
- 会话没重开

---

## 现成模板

仓库里已经带了最小模板：

- `examples/minimal-project/.encoding-rules`
- `examples/minimal-project/.mcp.json`
- `examples/minimal-project/CLAUDE.md`
- `examples/claude-config/settings.fragment.json`

---

## 开发者补充说明

如果你是维护者或贡献者：

- npm 包已经可用：
  ```bash
  npx -y codepage-bridge-mcp
  ```
- 仓库仍保留 GitHub Release 打包；
- 仓库也已经具备 plugin / marketplace 结构；
- 但这些都不是普通用户当前最推荐的安装路径。

---

## 许可证

MIT，见 [LICENSE](LICENSE)。
