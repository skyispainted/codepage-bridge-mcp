param(
  [string]$ServerName = 'codepage-bridge',
  [string]$Scope = 'user'
)

$ErrorActionPreference = 'Stop'

function Require-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $name"
  }
}

Require-Command node
Require-Command claude

$packageRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $packageRoot 'dist\src\server.js'

if (-not (Test-Path $entry)) {
  throw "This directory does not look like an extracted Codepage Bridge release package. Missing: $entry"
}

Write-Host "[1/2] Registering Claude Code MCP from this release package..."
try { claude mcp remove $ServerName --scope $Scope | Out-Null } catch {}
claude mcp add --scope $Scope $ServerName -- node $entry

Write-Host "[2/2] Verifying MCP connection..."
claude mcp get $ServerName

Write-Host ""
Write-Host "Installed $ServerName from the current extracted release package." -ForegroundColor Green
Write-Host "Next required steps:" -ForegroundColor Yellow
Write-Host "1. Merge examples/claude-config/settings.fragment.json into ~/.claude/settings.json"
Write-Host "2. Add CLAUDE.md policy from examples/minimal-project/CLAUDE.md"
Write-Host "3. Add a .encoding-rules file to each legacy-encoded project"
