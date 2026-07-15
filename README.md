# Codepage Bridge MCP

Encoding-transparent file tools for Claude Code and other MCP clients.

Codepage Bridge exposes `Read`, `Grep`, `Edit`, and `Write` over MCP while transparently converting project files between their on-disk legacy encoding and Unicode text for the LLM. The model sees normal Unicode text; files are written back in the encoding selected by the nearest `.encoding-rules`.

It is designed for legacy codebases that still use GBK/GB2312/GB18030, Big5, Shift-JIS, EUC-KR, Windows codepages, UTF-16, and other non-UTF-8 encodings.

## Quick Start

1. Install Node.js 20 or newer.
2. Clone this repository.
3. Run `npm install` and `npm run build`.
4. Register the MCP in Claude Code.
5. Add a project `.encoding-rules` file.
6. Disable Claude Code built-in `Read`, `Grep`, `Edit`, `Write`, and `NotebookEdit`.
7. Add a `CLAUDE.md` policy telling the model to use Codepage Bridge for file access.
8. Verify the model is actually calling `mcp__codepage-bridge__Read` and `mcp__codepage-bridge__Grep`.

If you skip steps 6 and 7, Claude Code may continue using its built-in file tools and bypass `.encoding-rules`.

---

## What Problem It Solves

Claude Code built-in file tools assume UTF-8 for normal text reads. In legacy projects this can lead to:

- unreadable C/C++ comments and string literals;
- searches that silently miss text in GBK or other codepages;
- edits that rewrite files in UTF-8;
- accidental encoding corruption during refactors.

Codepage Bridge keeps encoding conversion below the model boundary:

```text
legacy bytes on disk -> decode by .encoding-rules -> Unicode for the LLM
Unicode from the LLM -> strict encode by .encoding-rules -> legacy bytes on disk
```

If new text cannot be represented in the target encoding, the write fails instead of silently replacing characters with `?`.

---

## Features

- Encoding-aware `Read`, `Grep`, `Edit`, and `Write` tools.
- Project-level `.encoding-rules` with gitignore-like glob behavior.
- The nearest `.encoding-rules` defines both the project root and active rules.
- Last matching rule wins; `!pattern` resets matching files to strict UTF-8.
- Basename patterns such as `*.cpp` match at every directory depth.
- Strict UTF-8 fallback for files not matched by a rule.
- GBK/GB2312/GB18030, Big5, Shift-JIS, EUC-KR, Windows codepages, UTF-8, and UTF-16 support.
- BOM and dominant line-ending preservation for edits.
- Read-before-write protection and stale-write detection using byte hashes.
- Atomic temporary-file writes and per-path write locks.
- Symlink and project-root boundary checks.
- Image, PDF, and Jupyter Notebook reading.
- Grep output modes, context lines, glob/type filters, regex flags, and pagination.
- Large-file partial edit authorization: the model only needs to read the target lines it wants to edit, not the entire file.

---

## Requirements

- Node.js 20 or newer.
- Claude Code or another MCP client with stdio server support.
- Optional: Poppler commands `pdfinfo` and `pdftoppm` for PDF page rendering.

Check prerequisites:

### Windows

```powershell
node --version
npm --version
claude --version
```

### macOS / Linux

```bash
node --version
npm --version
claude --version
```

---

## Installation

### 1. Clone the repository

```bash
git clone git@github.com:skyispainted/codepage-bridge-mcp.git
cd codepage-bridge-mcp
```

### 2. Install dependencies

```bash
npm install
```

### 3. Build

```bash
npm run build
```

The server entry point is:

```text
dist/src/server.js
```

Check that it exists:

### Windows

```powershell
Test-Path .\dist\src\server.js
```

### macOS / Linux

```bash
test -f ./dist/src/server.js && echo ok
```

---

## Claude Code Setup

You can install Codepage Bridge either:

- **user-level**: available in all your projects;
- **project-level**: committed as part of a single repository.

### Option A — User-level setup

Recommended if you use legacy-encoded projects regularly.

#### Windows

```powershell
claude mcp add --scope user codepage-bridge -- node C:\absolute\path\to\codepage-bridge-mcp\dist\src\server.js
```

#### macOS / Linux

```bash
claude mcp add --scope user codepage-bridge -- node /absolute/path/to/codepage-bridge-mcp/dist/src/server.js
```

Verify:

```bash
claude mcp get codepage-bridge
claude mcp list
```

Expected result:

- name: `codepage-bridge`
- status: `Connected`

### Option B — Project-level setup

Recommended if you want the repository itself to declare the MCP.

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

---

## Extremely Important: Disable the Built-in File Tools

Installing the MCP is **not sufficient by itself**.

Claude Code may continue choosing its built-in:

- `Read`
- `Grep`
- `Edit`
- `Write`
- `NotebookEdit`

Those tools bypass `.encoding-rules`.

You must block them and allow the Codepage Bridge tools.

### Edit `~/.claude/settings.json`

Add the following entries to your existing settings file:

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

**Do not replace your whole settings file unless it is empty.** Merge these arrays into your existing configuration.

### If your settings file already has `permissions.allow`

Append these four entries:

```json
"mcp__codepage-bridge__Read"
"mcp__codepage-bridge__Grep"
"mcp__codepage-bridge__Edit"
"mcp__codepage-bridge__Write"
```

### If your settings file already has `permissions.deny`

Append these five entries:

```json
"Read"
"Grep"
"Edit"
"Write"
"NotebookEdit"
```

---

## Add a `CLAUDE.md` Policy

Even with built-in tools denied, the model can still try to bypass the bridge with shell commands or scripts.

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

Why both `settings.json` and `CLAUDE.md`?

- `deny` removes unsafe built-in tools from the model's available tool list.
- `CLAUDE.md` prevents the model from bypassing the bridge using shell tools.

---

## Create `.encoding-rules`

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

Supported examples:

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

---

## Verify the Setup

### 1. Check the MCP is connected

```bash
claude mcp get codepage-bridge
```

Expected:

- `Scope`: user or project, depending on how you installed it
- `Status`: `Connected`

### 2. Start a fresh Claude Code session in a legacy project

### 3. Ask Claude to read a legacy-encoded file

For example:

```text
Read SourceCode/Main.cpp and show the first 10 lines.
```

### 4. Confirm the model uses Codepage Bridge tools

In a verbose / print-mode session, the tool call should be one of:

- `mcp__codepage-bridge__Read`
- `mcp__codepage-bridge__Grep`
- `mcp__codepage-bridge__Edit`
- `mcp__codepage-bridge__Write`

It should **not** call built-in `Read`, `Grep`, `Edit`, or `Write`.

---

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

Behavior:

- Text is decoded according to `.encoding-rules` and returned as Unicode.
- Output uses numbered lines compatible with Claude Code workflows.
- Files larger than 256 KiB require `offset` and `limit`.
- Multiple ranged reads of the same unchanged file are merged by line coverage.
- Ranges may be sequential, overlapping, out of order, or concurrent within one MCP process.
- If the file changes, accumulated coverage is invalidated.
- Supports PNG, JPEG, GIF, WebP, PDF pages, and Notebook cells.
- Notebook reads do not accept text-line `offset` or `limit`.

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

Supported options:

- `output_mode`: `content`, `files_with_matches`, or `count`
- `glob`
- common `type` filters
- `-i`, `-n`, `-o`
- `-A`, `-B`, `-C`, `context`
- `multiline`
- `head_limit`, `offset`

Each candidate file is decoded using its own nearest `.encoding-rules`. Explicit single-file decode failures are reported as errors rather than being misreported as zero matches.

### `Edit`

```json
{
  "file_path": "C:\\project\\SourceCode\\Main.cpp",
  "old_string": "old text",
  "new_string": "new text",
  "replace_all": false
}
```

Behavior:

- Existing files do not require reading the whole file.
- An edit is authorized when every line covered by the selected `old_string` match was actually returned to the model.
- For unique targets in large files, the model only needs to read the relevant nearby lines.
- With `replace_all: true`, every matching range must have been read.
- If a target was not read, the error reports the exact missing line range(s).
- The file is re-read and hashed immediately before writing.
- Multiple matches are rejected unless `replace_all` is true.
- Straight/curly quote compatibility follows Claude Code edit behavior.
- The original encoding, BOM, and dominant line ending are preserved.

### `Write`

```json
{
  "file_path": "C:\\project\\SourceCode\\NewFile.cpp",
  "content": "full content"
}
```

Behavior:

- New files use the encoding selected by `.encoding-rules`.
- Existing files still require a complete prior `Read`.
- Existing files retain encoding and BOM metadata.
- Complete rewrites use the line endings supplied by the caller.

---

## Troubleshooting

### `No .encoding-rules found`

Cause:

- the project root does not contain `.encoding-rules`;
- you are pointing at a file outside the intended project root.

Fix:

- add `.encoding-rules` to the project root;
- ensure the target path is inside that project tree.

### `Invalid byte sequence for utf-8`

Cause:

- the file was decoded as UTF-8 but is actually in another encoding;
- your `.encoding-rules` did not match the file.

Fix:

- confirm the rule file exists;
- confirm the pattern matches nested paths;
- for language-wide rules, prefer patterns like `*.cpp gbk`.

### `Text contains characters not representable in ...`

Cause:

- the new text contains characters that the target encoding cannot represent.

Fix:

- change the text;
- or explicitly move the file to an encoding that can represent those characters.

### `The target text has not been read`

Cause:

- the model tried to edit a region it has not actually seen.

Fix:

- read the exact lines reported in the error;
- retry the edit.

### `Pending approval`

Cause:

- a project `.mcp.json` server has not been approved yet by Claude Code.

Fix:

- open Claude Code in the project and approve the server;
- or install Codepage Bridge at user scope.

### `Failed to connect`

Check:

- `node --version`
- `Test-Path dist/src/server.js` on Windows
- `test -f ./dist/src/server.js` on macOS/Linux
- `claude mcp get codepage-bridge`

Then rebuild:

```bash
npm install
npm run build
```

### Claude still uses built-in file tools

Cause:

- built-in tools were not denied;
- the model is bypassing through shell commands.

Fix:

- update `~/.claude/settings.json` `allow/deny` entries;
- add the `CLAUDE.md` policy;
- start a new Claude session.

---

## Safety Notes

1. Commit `.encoding-rules` with the project.
2. Test rules on representative nested files before large edits.
3. Use basename globs for language-wide rules, for example `*.cpp gbk`.
4. Do not silently convert encodings.
5. Do not bypass the bridge with shell tools or scripts.
6. Keep the MCP process trusted; it has read/write access inside roots defined by `.encoding-rules`.
7. Review generated diffs; encoding preservation does not guarantee semantic correctness.
8. PDF support is optional; install Poppler or avoid PDF reads.
9. Notebook editing is intentionally unavailable. Notebook reading is supported, but there is no `NotebookEdit` tool.
10. Windows network/device paths are rejected before I/O to avoid unintended SMB access and credential leakage.

---

## Development

```bash
npm install
npm run check
npm test
npm run build
npm start
```

Automated coverage currently includes:

- encoding rule precedence;
- nested basename matching;
- strict codecs;
- lossy-write rejection;
- stale-write protection;
- atomic writes;
- symlink boundaries;
- images, PDFs, and Notebook reads;
- GBK read/edit/write flows;
- Grep modes and error handling;
- full-file and target-range edit authorization;
- MCP protocol registration.

## License

MIT. See [LICENSE](LICENSE).
