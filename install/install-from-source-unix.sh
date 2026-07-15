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
require_command npm
require_command claude

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$REPO_ROOT/dist/src/server.js"

echo "[1/4] Installing npm dependencies..."
npm --prefix "$REPO_ROOT" install

echo "[2/4] Building Codepage Bridge..."
npm --prefix "$REPO_ROOT" run build

if [ ! -f "$ENTRY" ]; then
  echo "Build did not produce $ENTRY" >&2
  exit 1
fi

echo "[3/4] Registering Claude Code MCP..."
claude mcp remove "$SERVER_NAME" --scope "$SCOPE" >/dev/null 2>&1 || true
claude mcp add --scope "$SCOPE" "$SERVER_NAME" -- node "$ENTRY"

echo "[4/4] Verifying MCP connection..."
claude mcp get "$SERVER_NAME"

echo
echo "Next required steps:"
echo "1. Merge examples/claude-config/settings.fragment.json into ~/.claude/settings.json"
echo "2. Add examples/minimal-project/CLAUDE.md to your project or ~/.claude/CLAUDE.md"
echo "3. Add a .encoding-rules file to each legacy-encoded project"
echo "4. Start a new Claude Code session and verify it uses mcp__codepage-bridge__Read/Grep/Edit/Write"