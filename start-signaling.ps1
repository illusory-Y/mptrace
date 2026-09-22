# ============================================================
# 启动信令服务（日常使用）
# 用法：.\start-signaling.ps1
# 监听：ws://0.0.0.0:8787/ws ，健康检查 http://127.0.0.1:8787/health
# 关闭：直接关闭窗口或按 Ctrl+C
# ============================================================

$ErrorActionPreference = "Stop"
# 通过 .bat 以 UTF-8 调用时，$MyInvocation.MyCommand.Path 可能为空，改用当前工作目录
$ProjectRoot = (Get-Location).Path
$serverDir = Join-Path $ProjectRoot "server"
if (-not (Test-Path (Join-Path $serverDir "signaling.mjs"))) {
    Write-Host "[ERROR] Please run this script from the project root (current: $ProjectRoot)" -ForegroundColor Red
    exit 1
}
Set-Location $serverDir

if (-not (Test-Path "node_modules")) {
    Write-Host "首次启动，安装依赖..." -ForegroundColor Cyan
    npm install
}

if (-not (Test-Path ".env")) {
    Write-Host ".env 不存在，复制 .env.example" -ForegroundColor Yellow
    Copy-Item ".env.example" ".env"
}

Write-Host ""
Write-Host "信令服务启动中..." -ForegroundColor Cyan
Write-Host "  WebSocket: ws://0.0.0.0:8787/ws"
Write-Host "  健康检查:  http://127.0.0.1:8787/health"
Write-Host "  按 Ctrl+C 停止"
Write-Host ""

node signaling.mjs
