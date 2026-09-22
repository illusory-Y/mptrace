@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   LocalTransferSuite - Start Signaling Server  (UTF-8)
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression (Get-Content -Path '.\start-signaling.ps1' -Raw -Encoding UTF8)"
echo.
pause
