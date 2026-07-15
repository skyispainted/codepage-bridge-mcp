param(
  [string]$ServerName = "codepage-bridge",
  [string]$Scope = "user"
)

$ErrorActionPreference = "Stop"

function Require-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $name"
  }
}

Require-Command node
Require-Command npm
Require-Command claude

$repoRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $repoRoot "dist\src\server.js"

Write-Host "[1/4] Installing npm dependencies..."
npm --prefix $repoRoot install

Write-Host "[2/4] Building Codepage Bridge..."
npm --prefix $repoRoot run build

if (-not (Test-Path $entry)) {
  throw "Build did not produce $entry"
}

Write-Host "[3/4] Registering Claude Code MCP..."
try {
  claude mcp remove $ServerName --scope $Scope | Out-Null
} catch {}
claude mcp add --scope $Scope $ServerName -- node $entry

Write-Host "[4/4] Verifying MCP connection..."
claude mcp get $ServerName

Write-Host ""
Write-Host "Next required steps:" -ForegroundColor Yellow
Write-Host "1. Merge examples/claude-config/settings.fragment.json into ~/.claude/settings.json"
Write-Host "2. Add examples/minimal-project/CLAUDE.md to your project or ~/.claude/CLAUDE.md"
Write-Host "3. Add a .encoding-rules file to each legacy-encoded project"
Write-Host "4. Start a new Claude Code session and verify it uses mcp__codepage-bridge__Read/Grep/Edit/Write"