# Virelune Agent Village - Windows setup
# Run from the project folder:
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
# Safe to run again at any time. It never overwrites an existing .env.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host ''
Write-Host 'Virelune Agent Village setup' -ForegroundColor Yellow
Write-Host "Project folder: $root"
Write-Host ''

# 1. Node.js 22.18 or newer (24 LTS recommended)
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js is not installed.' -ForegroundColor Red
  Write-Host 'Install Node.js 24 LTS, then run this script again:'
  Write-Host '  winget install OpenJS.NodeJS.LTS'
  Write-Host '  (or download it from https://nodejs.org)'
  exit 1
}
$ver = (node -p "process.versions.node").Trim()
$parts = $ver.Split('.') | ForEach-Object { [int]$_ }
if ($parts[0] -lt 22 -or ($parts[0] -eq 22 -and $parts[1] -lt 18)) {
  Write-Host "Node.js $ver is too old. Virelune needs 22.18 or newer (24 LTS recommended)." -ForegroundColor Red
  Write-Host '  winget upgrade OpenJS.NodeJS.LTS'
  exit 1
}
Write-Host "Node.js $ver ... ok" -ForegroundColor Green

# 2. Git (residents work in git worktrees of registered projects)
if (Get-Command git -ErrorAction SilentlyContinue) {
  Write-Host "$(git --version) ... ok" -ForegroundColor Green
} else {
  Write-Host 'Git not found. Install it for agent work (the village itself still runs):' -ForegroundColor Yellow
  Write-Host '  winget install Git.Git'
}

# 3. Machine settings (.env is git-ignored and excluded from ZIP exports)
if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
  (Get-Content '.env') -replace '^VILLAGE_MACHINE_NAME=$', "VILLAGE_MACHINE_NAME=$env:COMPUTERNAME" | Set-Content '.env' -Encoding UTF8
  Write-Host "Created .env for machine '$env:COMPUTERNAME'. Edit it to add keys and tool paths." -ForegroundColor Green
} else {
  Write-Host '.env already exists ... kept as is' -ForegroundColor Green
}
New-Item -ItemType Directory -Force -Path 'data' | Out-Null

# 4. Integration check for THIS machine
Write-Host ''
Write-Host 'Checking which agent integrations this machine has...' -ForegroundColor Yellow
npm run --silent doctor

Write-Host ''
Write-Host 'Start the village with:' -ForegroundColor Yellow
Write-Host '  npm start'
Write-Host '  (or double-click scripts\start-village.cmd)'
Write-Host 'Then open http://127.0.0.1:4317'
Write-Host ''
