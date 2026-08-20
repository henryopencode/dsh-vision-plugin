@echo off
REM dsh-vision-plugin - Windows one-click installer (double-click me)
REM Requires: Windows 10/11, PowerShell 5.1+

title dsh-vision-plugin installer
echo.
echo ==============================================
echo   dsh-vision-plugin installer (Windows)
echo ==============================================
echo.
echo This will:
echo   1. Install Ollama (if missing, via winget)
echo   2. Pull the vision model (qwen2.5vl:3b, ~2-4 GB)
echo   3. Copy plugin files into your DSH profile
echo   4. Register it in cordis.patch.yml
echo.
echo Note: you must already have DeepSeek Harness (DSH) installed
echo       and have run "dsh web" at least once.
echo.
choice /C YN /M "Continue"
if errorlevel 2 exit /b 0

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
    echo.
    echo Installation failed. See messages above.
    pause
    exit /b 1
)
pause
