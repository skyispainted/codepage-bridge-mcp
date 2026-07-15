# Codepage Bridge MCP

[中文说明 / README_CN](README_CN.md)

Encoding-transparent file tools for Claude Code and other MCP clients.

Codepage Bridge exposes `Read`, `Grep`, `Edit`, and `Write` over MCP while transparently converting project files between their on-disk legacy encoding and Unicode text for the LLM. The model sees normal Unicode text; files are written back in the encoding selected by the nearest `.encoding-rules`.

It is designed for legacy codebases that still use GBK/GB2312/GB18030, Big5, Shift-JIS, EUC-KR, Windows codepages, UTF-16, and other non-UTF-8 encodings.

## Recommended install

This is now the single recommended installation path for end users.

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\install\install-windows.ps1
```

### macOS / Linux

```bash
bash ./install/install-unix.sh
```

What this does:

- registers Claude Code MCP using the published npm package;
- uses `npx -y codepage-bridge-mcp` as the MCP server command;
- verifies that the MCP is connected.

What this requires locally:

- `claude`
- `node`

What it does **not** require:

- `git clone`
- `npm install`
- `npm run build`
- downloading a GitHub Release package first

---

## Why

Claude Code built-in file tools assume UTF-8 for normal text reads. In legacy projects this can lead to:

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

---

## Required Claude Code configuration

Installing the MCP is **not sufficient by itself**.

Claude Code may still choose its built-in:

- `Read`
- `Grep`
- `Edit`
- `Write`
- `NotebookEdit`

Those tools bypass `.encoding-rules`.

### Step 1 — merge `settings.fragment.json`

Merge this into your existing `~/.claude/settings.json`:

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

Template file:

- `examples/claude-config/settings.fragment.json`

**Do not replace your whole settings file unless it is empty.** Merge these arrays into your existing configuration.

### Step 2 — add a `CLAUDE.md` policy

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

Template file:

- `examples/minimal-project/CLAUDE.md`

### Step 3 — add `.encoding-rules`

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

Template file:

- `examples/minimal-project/.encoding-rules`

Rules:

- Empty lines and lines beginning with `#` are ignored.
- `*`, `**`, and `?` use glob semantics.
- Patterns without `/`, such as `*.cpp`, match basenames at every directory depth.
- Patterns containing `/` are relative to the `.encoding-rules` directory.
- The last matching rule wins.
- `!pattern` cancels previous matches and selects strict UTF-8.
- Files with no matching rule use strict UTF-8.
- The nearest `.encoding-rules` is used; its directory is the allowed project root.

---

## Verify the setup

### 1. Check the MCP is connected

```bash
claude mcp get codepage-bridge
```

Expected:

- name: `codepage-bridge`
- status: `Connected`

### 2. Start a fresh Claude Code session in a legacy project

### 3. Ask Claude to read or search a legacy-encoded file

Examples:

```text
Read SourceCode/Main.cpp and show the first 10 lines.
```

```text
Search SourceCode for the string 错误码.
```

### 4. Confirm the model uses Codepage Bridge tools

In a verbose / print-mode session, the tool call should be one of:

- `mcp__codepage-bridge__Read`
- `mcp__codepage-bridge__Grep`
- `mcp__codepage-bridge__Edit`
- `mcp__codepage-bridge__Write`

It should **not** call built-in `Read`, `Grep`, `Edit`, or `Write`.

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

## Maintainer notes

### npm package

The package is published and installable via:

```bash
npx -y codepage-bridge-mcp
```

### Plugin / marketplace status

This repository is plugin-ready and marketplace-ready.

Plugin files:

- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.mcp.json`
- `commands/setup.md`
- `commands/setup-project.md`
- `commands/doctor.md`

### Release artifacts

GitHub Release packaging is still maintained for users who prefer downloadable archives, but that is no longer the primary installation path described in this README.

### Release workflow

The GitHub release workflow uses npm Trusted Publishing with GitHub OIDC.

---

## Development

```bash
npm install
npm run check
npm test
npm run build
npm start
```

## License

MIT. See [LICENSE](LICENSE).
