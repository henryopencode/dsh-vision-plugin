# dsh-vision-plugin — Windows 一键安装脚本
# 用法：右键"使用 PowerShell 运行"，或：
#   powershell -ExecutionPolicy Bypass -File install.ps1
# 可选参数：-Model qwen2.5vl:3b -SkipModelPull
param(
    [string]$Model = 'qwen2.5vl:3b',
    [switch]$SkipModelPull
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginName = 'dsh-client-ui-vision-bridge'

Write-Host ''
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '  dsh-vision-plugin 安装器 (Windows)' -ForegroundColor Cyan
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host ''

# ── 1. 检查 Ollama ──────────────────────────────────────────────
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
    Write-Host '[1/4] 未检测到 Ollama，正在安装…' -ForegroundColor Yellow
    try {
        winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
    } catch {
        Write-Host 'winget 安装失败。请手动安装：' -ForegroundColor Red
        Write-Host '  打开 https://ollama.com/download/windows 下载安装'
        Write-Host '  安装完成后重新运行本脚本'
        exit 1
    }
    # 安装后重新找 ollama（可能需要新开终端）
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $ollama = Get-Command ollama -ErrorAction SilentlyContinue
    if (-not $ollama) {
        Write-Host 'Ollama 已安装，请重新打开终端/脚本后再运行。' -ForegroundColor Yellow
        exit 0
    }
}
Write-Host "[1/4] Ollama: OK ($($ollama.Source))" -ForegroundColor Green

# 确保 Ollama 服务在运行
$null = Start-Process -FilePath $ollama.Source -ArgumentList 'serve' -WindowStyle Hidden -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# ── 2. 拉取视觉模型 ─────────────────────────────────────────────
if (-not $SkipModelPull) {
    Write-Host "[2/4] 拉取视觉模型 $Model …（约 2-4 GB，视网速而定）" -ForegroundColor Yellow
    & $ollama.Source pull $Model
    if ($LASTEXITCODE -ne 0) {
        Write-Host '模型拉取失败，请检查网络后重试。' -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[2/4] 跳过模型拉取 (-SkipModelPull)" -ForegroundColor Green
}

# ── 3. 定位 DSH 用户目录 ────────────────────────────────────────
$dshHome = $env:DSH_HOME
if (-not $dshHome) { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles'
$webDir = Join-Path $profileDir 'web'

if (-not (Test-Path $webDir)) {
    Write-Host "[3/4] 未找到 DSH web profile：$webDir" -ForegroundColor Red
    Write-Host '     请先安装并启动一次 DSH Web（dsh web）生成 profile，再运行本脚本。'
    exit 1
}
Write-Host "[3/4] DSH 用户目录: $dshHome" -ForegroundColor Green

# ── 4. 安装插件文件 ─────────────────────────────────────────────
Write-Host '[4/4] 安装插件文件…' -ForegroundColor Yellow

# 4a. 服务端插件 → profiles/web/vision-server.mjs
Copy-Item -Force (Join-Path $ScriptDir '..\server\vision-server.mjs') (Join-Path $webDir 'vision-server.mjs')

# 4b. 浏览器插件包 → profiles/node_modules/@deepseek-ai/dsh-client-ui-vision-bridge/
$modulesDir = Join-Path $profileDir 'node_modules\@deepseek-ai'
$pkgDir = Join-Path $modulesDir $PluginName
New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null
$srcPkg = Join-Path $ScriptDir '..\browser\dsh-client-ui-vision-bridge'
Copy-Item -Recurse -Force (Join-Path $srcPkg 'lib') (Join-Path $pkgDir 'lib')
Copy-Item -Force (Join-Path $srcPkg 'package.json') (Join-Path $pkgDir 'package.json')

# 4c. cordis.patch.yml 注册两行（幂等：已存在则跳过）
$patchPath = Join-Path $webDir 'cordis.patch.yml'
$patchContent = if (Test-Path $patchPath) { Get-Content $patchPath -Raw -Encoding UTF8 } else { "[]`n" }
if ($patchContent -notmatch 'vision-server') {
    $insert = @"

# dsh-vision-plugin: local vision recognition (installed by install.ps1)
- insert:
    - id: vision-server
      name: ./vision-server.mjs
      config:
        model: $Model
        ocrEnabled: false
        baseURL: http://127.0.0.1:11434/v1
"@
    $patchContent = $patchContent.TrimEnd() + "`n" + $insert + "`n"
    Set-Content -Path $patchPath -Value $patchContent -Encoding UTF8
    Write-Host '  cordis.patch.yml: 已注册 vision-server' -ForegroundColor Green
} else {
    Write-Host '  cordis.patch.yml: vision-server 已存在，跳过' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '✔ 安装完成！' -ForegroundColor Green
Write-Host ''
Write-Host '最后一步：重启 DSH Web（关闭后重新运行 dsh web，或重启 DSH App），'
Write-Host '然后用 Chrome/Edge 打开 http://127.0.0.1:3080 并刷新页面。'
Write-Host ''
Write-Host '使用：粘贴图片 → 发送 → 20-30 秒后得到识别结果。'
Write-Host '切换模型（如 qwen3-vl:4b）：浏览器控制台执行'
Write-Host "  localStorage.setItem('dsh-vision:config', JSON.stringify({ model: 'qwen3-vl:4b' }))"
Write-Host ''
