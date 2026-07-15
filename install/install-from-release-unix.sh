#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-latest}"
SERVER_NAME="${SERVER_NAME:-codepage-bridge}"
SCOPE="${SCOPE:-user}"
REPO="skyispainted/codepage-bridge-mcp"
INSTALL_ROOT="${HOME}/.codepage-bridge"
RELEASE_ROOT="${INSTALL_ROOT}/releases"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command not found: $1" >&2
    exit 1
  }
}

require_command node
require_command claude
require_command curl
require_command tar
require_command uname

mkdir -p "$RELEASE_ROOT"

platform="$(uname -s)"
arch="$(uname -m)"
case "$platform" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) echo "Unsupported platform: $platform" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) cpu="x64" ;;
  arm64|aarch64) cpu="arm64" ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
  api_url="https://api.github.com/repos/$REPO/releases/latest"
else
  api_url="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
fi

release_json="$(curl -fsSL -H 'User-Agent: codepage-bridge-installer' "$api_url")"
tag="$(printf '%s' "$release_json" | node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(data.tag_name)")"
asset_name="codepage-bridge-${tag}-${os}-${cpu}.tar.gz"
asset_url="$(printf '%s' "$release_json" | node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); const asset=data.assets.find(a=>a.name===process.argv[1]); if(!asset){process.exit(2)} process.stdout.write(asset.browser_download_url)" "$asset_name")" || {
  echo "Release asset not found: $asset_name" >&2
  exit 1
}

archive="$INSTALL_ROOT/$asset_name"
target_dir="$RELEASE_ROOT/$tag"
rm -rf "$target_dir"
mkdir -p "$target_dir"

echo "[1/4] Downloading $asset_name ..."
curl -fsSL -H 'User-Agent: codepage-bridge-installer' "$asset_url" -o "$archive"

echo "[2/4] Extracting release ..."
tar -xzf "$archive" -C "$target_dir"
rm -f "$archive"

entry="$target_dir/dist/src/server.js"
if [ ! -f "$entry" ]; then
  echo "Release package does not contain $entry" >&2
  exit 1
fi

echo "[3/4] Registering Claude Code MCP ..."
claude mcp remove "$SERVER_NAME" --scope "$SCOPE" >/dev/null 2>&1 || true
claude mcp add --scope "$SCOPE" "$SERVER_NAME" -- node "$entry"

echo "[4/4] Verifying MCP connection ..."
claude mcp get "$SERVER_NAME"

echo
echo "Installed $SERVER_NAME from release $tag"
echo "Next required steps:"
echo "1. Merge examples/claude-config/settings.fragment.json into ~/.claude/settings.json"
echo "2. Add CLAUDE.md policy from examples/minimal-project/CLAUDE.md"
echo "3. Add a .encoding-rules file to each legacy-encoded project"
