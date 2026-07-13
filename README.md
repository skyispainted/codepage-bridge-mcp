# Codepage Bridge MCP

Encoding-transparent file tools for Claude Code and other MCP clients.

Codepage Bridge exposes `Read`, `Grep`, `Edit`, and `Write` over MCP while transparently converting project files between their on-disk legacy codepage and Unicode text for the LLM. The model sees normal Unicode; files are written back in the encoding selected by the nearest `.encoding-rules`.

It is designed for legacy codebases that still use GBK/GB2312, Big5, Shift-JIS, EUC-KR, Windows-1251, or other non-UTF-8 encodings.

## Why

Claude Code's built-in file tools assume UTF-8 for normal text reads. In legacy projects this can lead to:

- unreadable C/C++ comments and string literals;
- searches that silently miss text;
- edits that corrupt the original codepage;
- accidental UTF-8 rewrites of GBK or other legacy files.

Codepage Bridge keeps encoding conversion below the model boundary:

```text
legacy bytes on disk -> decode by .encoding-rules -> Unicode for the LLM
Unicode from the LLM -> strict encode by .encoding-rules -> legacy bytes on disk
```

If new text cannot be represented in the target encoding, the write fails instead of silently replacing characters with `?`.

## Features

- Encoding-aware `Read`, `Grep`, `Edit`, and `Write` tools.
- Project-level `.encoding-rules` with gitignore-like glob behavior.
- The nearest `.encoding-rules` defines both the project root and active rules.
- Last matching rule wins; `!pattern` resets matching files to strict UTF-8.
- Basename patterns such as `*.cpp` match at every directory depth.
- Strict UTF-8 fallback for files not matched by a rule.
- GBK/GB2312, Big5, Shift-JIS, EUC-KR, Windows codepages, UTF-8, and UTF-16 support.
- BOM and dominant line-ending preservation for edits.
- Read-before-write protection and stale-write detection using byte hashes.
- Atomic temporary-file writes and per-path write locks.
- Symlink and project-root boundary checks.
- Image, PDF, and Jupyter Notebook reading.
- Grep output modes, context lines, glob/type filters, regex flags, and pagination.

## Requirements

- Node.js 20 or newer.
- Claude Code or another MCP client with stdio server support.
- Optional: Poppler commands `pdfinfo` and `pdftoppm` for PDF page rendering.

## Installation

Clone and build:

```bash
git clone git@github.com:skyispainted/codepage-bridge-mcp.git
cd codepage-bridge-mcp
npm install
npm run build
```

The server entry point is:

```text
dist/src/server.js
```

## MCP Configuration

### Claude Code user-level installation

Available in all projects:

```bash
claude mcp add --scope user codepage-bridge -- node /absolute/path/to/codepage-bridge-mcp/dist/src/server.js
```

Verify:

```bash
claude mcp get codepage-bridge
claude mcp list
```

### Claude Code project-level installation

Create `.mcp.json` in the project root:

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

Shared project MCP configurations may require approval the first time Claude Code opens the project.

## Important: Disable the Built-in File Tools

Installing the MCP is not sufficient by itself. Claude Code may continue choosing its built-in `Read`, `Grep`, `Edit`, `Write`, or `NotebookEdit` tools, which bypass `.encoding-rules`.

Add the bridge tools to `permissions.allow` and the built-in tools to `permissions.deny` in `~/.claude/settings.json`:

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

Merge these entries into your existing settings instead of replacing the entire file.

### Recommended Claude instructions

Add this to the project `CLAUDE.md`, or to `~/.claude/CLAUDE.md` for a global policy:

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

Why both settings and instructions?

- `deny` removes the unsafe built-in tools from the model's available tool list.
- `CLAUDE.md` prevents the model from bypassing the bridge with shell commands or scripts.

## `.encoding-rules`

Every project using Codepage Bridge must contain `.encoding-rules` at its root.

Example:

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

Syntax:

```text
<glob-pattern> <encoding>
```

Rules:

- Empty lines and lines beginning with `#` are ignored.
- `*`, `**`, and `?` use glob semantics.
- Patterns without `/`, such as `*.cpp`, match basenames at every directory depth.
- Patterns containing `/` are relative to the `.encoding-rules` directory.
- The last matching rule wins.
- `!pattern` cancels previous matches and selects strict UTF-8.
- Files with no matching rule use strict UTF-8.
- The nearest `.encoding-rules` is used; its directory is the allowed project root.

Use encoding labels accepted by WHATWG `TextDecoder` and `iconv-lite`, for example:

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

## Tools

### `Read`

```json
{
  "file_path": "C:\\project\\SourceCode\\Main.cpp",
  "offset": 1,
  "limit": 200,
  "pages": "1-5"
}
```

- Text is decoded according to `.encoding-rules` and returned as Unicode.
- Output uses numbered lines compatible with Claude Code workflows.
- Files larger than 256 KiB require `offset` and `limit`.
- Supports PNG, JPEG, GIF, WebP, PDF pages, and Notebook cells.
- Notebook reads do not accept text-line `offset` or `limit`.

### `Grep`

```json
{
  "pattern": "错误|失败",
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

Supported options:

- `output_mode`: `content`, `files_with_matches`, or `count`.
- `glob` and common `type` filters.
- `-i`, `-n`, and `-o`.
- `-A`, `-B`, `-C`, and `context`.
- `multiline`.
- `head_limit` and `offset`.

Each candidate file is decoded using its own nearest `.encoding-rules`. Explicit single-file decode failures are reported as errors rather than being misreported as zero matches.

### `Edit`

```json
{
  "file_path": "C:\\project\\SourceCode\\Main.cpp",
  "old_string": "旧文本",
  "new_string": "新文本",
  "replace_all": false
}
```

- Existing files require a complete prior `Read`.
- Partial reads do not authorize edits.
- The file is re-read and hashed immediately before writing.
- Multiple matches are rejected unless `replace_all` is true.
- Straight/curly quote compatibility follows Claude Code edit behavior.
- The original encoding, BOM, and dominant line ending are preserved.

### `Write`

```json
{
  "file_path": "C:\\project\\SourceCode\\NewFile.cpp",
  "content": "完整内容"
}
```

- New files use the encoding selected by `.encoding-rules`.
- Existing files require a complete prior `Read`.
- Existing files retain encoding and BOM metadata.
- Complete rewrites use the line endings supplied by the caller.

## Safety Notes

1. **Commit `.encoding-rules` with the project.** Without it, Codepage Bridge refuses access instead of guessing a project root.
2. **Test rules before large edits.** Start with `Read` or `Grep` on representative nested files.
3. **Use basename globs for language-wide rules.** `*.cpp gbk` applies at any depth; `SourceCode/**/*.cpp gbk` applies only below that path.
4. **Do not silently convert encodings.** If text cannot be represented in the configured encoding, update the rule deliberately or choose representable text.
5. **Do not bypass the bridge.** Shell tools, scripts, IDE formatters, and other MCP servers can still rewrite files using the wrong encoding.
6. **Keep the MCP process trusted.** It has read/write access inside roots defined by `.encoding-rules`.
7. **Review generated diffs.** Encoding preservation prevents byte-level corruption, but semantic edits still require review.
8. **PDF support is optional.** Install Poppler or avoid PDF reads.
9. **Notebook editing is intentionally unavailable.** Notebook reading is supported, but the MCP does not expose `NotebookEdit`.
10. **Windows network/device paths are rejected before I/O.** This avoids unintended SMB access and credential leakage.

## Development

```bash
npm install
npm run check
npm test
npm run build
npm start
```

Current automated coverage includes encoding rule precedence, nested basename matching, strict codecs, lossy-write rejection, stale-write protection, atomic writes, symlink boundaries, images, PDFs, Notebook reads, GBK read/edit/write flows, Grep modes, and MCP protocol registration.

## License

MIT. See [LICENSE](LICENSE).