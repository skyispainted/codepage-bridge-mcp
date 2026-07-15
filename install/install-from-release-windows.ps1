param(
  [string]$Version = 'latest',
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
Require-Command powershell

$Repo = 'skyispainted/codepage-bridge-mcp'
$InstallRoot = Join-Path $env:USERPROFILE '.codepage-bridge'
$ReleaseRoot = Join-Path $InstallRoot 'releases'
New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null

function Get-ReleaseInfo {
  param([string]$Version)
  if ($Version -eq 'latest') {
    $url = "https://api.github.com/repos/$Repo/releases/latest"
  } else {
    $url = "https://api.github.com/repos/$Repo/releases/tags/$Version"
  }
  Invoke-RestMethod -Uri $url -Headers @{ 'User-Agent' = 'codepage-bridge-installer' }
}

$release = Get-ReleaseInfo -Version $Version
$tag = $release.tag_name
$assetName = "codepage-bridge-$tag-win32-x64.zip"
$asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
if (-not $asset) {
  throw "Release asset not found: $assetName"
}

$zipPath = Join-Path $InstallRoot $assetName
$targetDir = Join-Path $ReleaseRoot $tag
if (Test-Path $targetDir) {
  Remove-Item -Recurse -Force $targetDir
}

Write-Host "[1/4] Downloading $assetName ..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -Headers @{ 'User-Agent' = 'codepage-bridge-installer' }

Write-Host "[2/4] Extracting release ..."
Expand-Archive -Path $zipPath -DestinationPath $targetDir -Force
Remove-Item -Force $zipPath

$entry = Join-Path $targetDir 'dist\src\server.js'
if (-not (Test-Path $entry)) {
  throw "Release package does not contain $entry"
}

Write-Host "[3/4] Registering Claude Code MCP ..."
try { claude mcp remove $ServerName --scope $Scope | Out-Null } catch {}
claude mcp add --scope $Scope $ServerName -- node $entry

Write-Host "[4/4] Verifying MCP connection ..."
claude mcp get $ServerName

Write-Host ""
Write-Host "Installed $ServerName from release $tag" -ForegroundColor Green
Write-Host "Next required steps:" -ForegroundColor Yellow
Write-Host "1. Merge examples/claude-config/settings.fragment.json into ~/.claude/settings.json"
Write-Host "2. Add CLAUDE.md policy from examples/minimal-project/CLAUDE.md"
Write-Host "3. Add a .encoding-rules file to each legacy-encoded project"
