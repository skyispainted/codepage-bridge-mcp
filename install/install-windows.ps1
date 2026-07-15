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

Write-Host "[1/2] Registering Codepage Bridge from npm..."
try { claude mcp remove $ServerName --scope $Scope | Out-Null } catch {}
claude mcp add --scope $Scope $ServerName -- npx -y codepage-bridge-mcp

Write-Host "[2/2] Verifying MCP connection..."
claude mcp get $ServerName

Write-Host ""
Write-Host "Next required steps:" -ForegroundColor Yellow
Write-Host "1. Merge examples/claude-config/settings.fragment.json into ~/.claude/settings.json"
Write-Host "2. Add examples/minimal-project/CLAUDE.md to your project or ~/.claude/CLAUDE.md"
Write-Host "3. Add a .encoding-rules file to each legacy-encoded project"
Write-Host "4. Start a new Claude Code session and verify it uses mcp__codepage-bridge__Read/Grep/Edit/Write"
