#!/usr/bin/env bash
set -euo pipefail

SERVER_NAME="${1:-codepage-bridge}"
SCOPE="${SCOPE:-user}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command not found: $1" >&2
    exit 1
  }
}

require_command node
require_command claude

echo "[1/2] Registering Codepage Bridge from npm..."
claude mcp remove "$SERVER_NAME" --scope "$SCOPE" >/dev/null 2>&1 || true
claude mcp add --scope "$SCOPE" "$SERVER_NAME" -- npx -y codepage-bridge-mcp

echo "[2/2] Verifying MCP connection..."
claude mcp get "$SERVER_NAME"

echo
echo "Next required steps:"
echo "1. Merge examples/claude-config/settings.fragment.json into ~/.claude/settings.json"
echo "2. Add examples/minimal-project/CLAUDE.md to your project or ~/.claude/CLAUDE.md"
echo "3. Add a .encoding-rules file to each legacy-encoded project"
echo "4. Start a new Claude Code session and verify it uses mcp__codepage-bridge__Read/Grep/Edit/Write"
