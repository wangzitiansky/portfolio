[CmdletBinding()]
param(
    [int]$Port = 8889,
    [switch]$OpenBrowser,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

function Stop-ExistingServer {
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
        $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
        if ($process -and $process.ProcessName -in @('portfolio-server', 'go')) {
            Write-Host "Stopping existing $($process.ProcessName) process on port $Port..." -ForegroundColor Yellow
            Stop-Process -Id $process.Id -Force
        }
    }
}

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    throw 'Go was not found. Install Go 1.25 or newer, then reopen PowerShell.'
}

$goVersion = (& go version) 2>&1
Write-Host "Using $goVersion" -ForegroundColor DarkGray

if (-not $SkipTests) {
    Write-Host 'Running tests...' -ForegroundColor Cyan
    & go test ./...
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed; server was not started.' }
}

Stop-ExistingServer

$url = "http://127.0.0.1:$Port/assets/index.html"
Write-Host "Starting Portfolio at $url" -ForegroundColor Green
Write-Host 'Press Ctrl+C to stop.' -ForegroundColor DarkGray

if ($OpenBrowser) {
    Start-Process $url | Out-Null
}

$env:PORTFOLIO_PORT = [string]$Port
& go run .
exit $LASTEXITCODE
