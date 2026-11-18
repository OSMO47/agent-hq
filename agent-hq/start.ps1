# OSMO AGENT launcher (Windows). Usage:  powershell -ExecutionPolicy Bypass -File .\start.ps1 [-Dev]
param([switch]$Dev)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) { throw "Node.js 24+ required (found $(node --version))." }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { throw "Claude Code CLI not found on PATH. Install it and run 'claude' once to log in." }
if (-not (Test-Path node_modules)) { npm install }

if ($Dev) {
  Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$PSScriptRoot'; npm run dev:server"
  npm run dev:web          # http://127.0.0.1:5173 (hot reload, proxies to the API)
} else {
  if (-not (Test-Path web/dist/index.html)) { npm run build }
  Start-Process 'http://127.0.0.1:4317'
  npm start                # Ctrl+C stops the server and every running agent session
}
