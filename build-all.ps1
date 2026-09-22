# ============================================================
# 私传助手（LocalTransferSuite）一键构建 + 自检脚本
# 适用：Windows PowerShell 5.1+
# 用法：在项目根目录右键 → "在终端中打开" → 执行：
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\build-all.ps1
#
# 流程：环境检查 → 图标 → 字体 → 前端构建 → 信令服务自检 → Tauri 打包
# 每步完成后自动自检，失败即停并提示原因。
# ============================================================

$ErrorActionPreference = "Stop"
# 通过 .bat 以 UTF-8 调用时，$MyInvocation.MyCommand.Path 可能为空，改用当前工作目录
$ProjectRoot = (Get-Location).Path
if (-not (Test-Path (Join-Path $ProjectRoot "package.json"))) {
    Write-Host "[ERROR] Please run this script from the project root (current: $ProjectRoot)" -ForegroundColor Red
    exit 1
}
Set-Location $ProjectRoot

$LogoUrl = "https://aka.doubaocdn.com/s/DLjEFqgRlC"   # AI 生成的 1024x1024 图标（如失效请手动放 logo.png）
$Script:Step = 0

function Write-Step($msg) {
    $Script:Step++
    Write-Host ""
    Write-Host "====== [步骤 $Script:Step] $msg ======" -ForegroundColor Cyan
}

function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "  [FAIL] $msg" -ForegroundColor Red }

function Assert-File($path, $desc) {
    if (Test-Path $path) {
        $len = (Get-Item $path).Length
        Write-Ok "$desc 存在：$path（$([math]::Round($len/1KB,1)) KB）"
        return $true
    } else {
        Write-Fail "$desc 缺失：$path"
        return $false
    }
}

# ============================================================
# 步骤 0：环境检查
# ============================================================
Write-Step "环境检查（node / npm / rust / cargo）"

$tools = @(
    @{ Name = "node";  Min = [version]"20.0.0" },
    @{ Name = "npm";   Min = [version]"10.0.0" },
    @{ Name = "rustc"; Min = [version]"1.77.0" },
    @{ Name = "cargo"; Min = [version]"1.77.0" }
)

$envOk = $true
foreach ($t in $tools) {
    try {
        $verStr = & $t.Name --version 2>&1 | Select-Object -First 1
        if ($verStr -match '(\d+\.\d+\.\d+)') {
            $ver = [version]$Matches[1]
            if ($ver -ge $t.Min) {
                Write-Ok "$($t.Name) $ver（要求 >= $($t.Min)）"
            } else {
                Write-Fail "$($t.Name) $ver 过低，要求 >= $($t.Min)"
                $envOk = $false
            }
        } else {
            Write-Warn2 "$($t.Name) 版本无法解析：$verStr"
        }
    } catch {
        Write-Fail "$($t.Name) 未安装或不在 PATH 中"
        $envOk = $false
    }
}

# 检查 MSVC 构建工具（Windows 编译 Tauri 必需）
$msvcPaths = @(
    "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
)
$msvcFound = $false
foreach ($p in $msvcPaths) {
    if (Test-Path $p) { $msvcFound = $true; break }
}
if ($msvcFound) { Write-Ok "MSVC 构建工具已安装" }
else { Write-Warn2 "未在标准路径找到 MSVC 构建工具；如编译报 link.exe 错误，请安装 VS2022 Build Tools（勾选'使用 C++ 的桌面开发'）" }

if (-not $envOk) {
    Write-Fail "环境检查未通过，请安装缺失的工具后重试"
    exit 1
}

# ============================================================
# 步骤 1：应用图标
# ============================================================
Write-Step "生成应用图标（1024x1024 源图 → tauri icon 全套）"

$logoPath = Join-Path $ProjectRoot "logo.png"
if (-not (Test-Path $logoPath)) {
    Write-Host "  未找到 logo.png，尝试从 AI 生成的 URL 下载..."
    try {
        Invoke-WebRequest -Uri $LogoUrl -OutFile $logoPath -UseBasicParsing -TimeoutSec 60
        Write-Ok "图标已下载：$logoPath"
    } catch {
        Write-Fail "图标下载失败：$($_.Exception.Message)"
        Write-Host "  请手动将一张 1024x1024 PNG 保存为：$logoPath"
        Write-Host "  然后重新运行本脚本。"
        exit 1
    }
} else {
    Write-Ok "使用已存在的 logo.png"
}

# 强制转换为标准 PNG（AI 生成的图可能是 WebP/JPEG，tauri icon 只接受标准 PNG signature）
Add-Type -AssemblyName System.Drawing
try {
    $srcImg = [System.Drawing.Image]::FromFile($logoPath)
    $tmpPng = $logoPath + ".tmp.png"
    $srcImg.Save($tmpPng, [System.Drawing.Imaging.ImageFormat]::Png)
    $srcImg.Dispose()
    Move-Item $tmpPng $logoPath -Force
    Write-Ok "图标已转换为标准 PNG 格式"
} catch {
    Write-Fail "图标格式转换失败：$($_.Exception.Message)"
    exit 1
}

# 验证源图尺寸
$img = [System.Drawing.Image]::FromFile($logoPath)
if ($img.Width -ne 1024 -or $img.Height -ne 1024) {
    Write-Warn2 "图标尺寸为 $($img.Width)x$($img.Height)，建议使用 1024x1024"
} else {
    Write-Ok "图标尺寸 1024x1024"
}
$img.Dispose()

# 调用 tauri icon 生成全套
Write-Host "  执行：npm run tauri icon ./logo.png"
npm run tauri icon ./logo.png
if ($LASTEXITCODE -ne 0) {
    Write-Fail "tauri icon 生成失败"
    exit 1
}

# 自检：检查 tauri.conf.json 引用的所有图标文件
$iconDir = Join-Path $ProjectRoot "src-tauri\icons"
$requiredIcons = @("32x32.png", "128x128.png", "128x128@2x.png", "icon.icns", "icon.ico")
$iconOk = $true
foreach ($ic in $requiredIcons) {
    if (-not (Assert-File (Join-Path $iconDir $ic) "图标 $ic")) { $iconOk = $false }
}
if (-not $iconOk) { exit 1 }
Write-Ok "图标全套生成完毕"

# ============================================================
# 步骤 2：中文字体（PDF 导出用）
# ============================================================
Write-Step "放置中文字体 SourceHanSans.ttf（导出可检索 PDF 必需）"

$fontDir = Join-Path $ProjectRoot "public\fonts"
$fontPath = Join-Path $fontDir "SourceHanSans.ttf"
if (Test-Path $fontPath) {
    Write-Ok "字体已存在：$fontPath"
} else {
    # 优先使用 Windows 系统自带的黑体（simhei.ttf），个人使用合规
    $sysFonts = @(
        "C:\Windows\Fonts\simhei.ttf",
        "C:\Windows\Fonts\msyh.ttc",
        "C:\Windows\Fonts\simsun.ttc"
    )
    $copied = $false
    foreach ($sf in $sysFonts) {
        if (Test-Path $sf) {
            Copy-Item $sf $fontPath -Force
            Write-Ok "已从系统字体复制：$sf → $fontPath"
            $copied = $true
            break
        }
    }

    if (-not $copied) {
        Write-Warn2 "系统未找到中文字体，尝试下载思源黑体 TTF（约 8MB）..."
        $fontUrls = @(
            "https://github.com/be5invis/source-han-sans-ttf/releases/download/1.002/SourceHanSansSC-Regular.ttf",
            "https://raw.githubusercontent.com/be5invis/source-han-sans-ttf/master/Regular/SourceHanSansSC-Regular.ttf"
        )
        $downloaded = $false
        foreach ($url in $fontUrls) {
            try {
                Write-Host "  尝试：$url"
                Invoke-WebRequest -Uri $url -OutFile $fontPath -UseBasicParsing -TimeoutSec 120
                if ((Get-Item $fontPath).Length -gt 100KB) {
                    Write-Ok "思源黑体已下载：$fontPath"
                    $downloaded = $true
                    break
                }
            } catch {
                Write-Host "  下载失败：$($_.Exception.Message)"
            }
        }
        if (-not $downloaded) {
            Write-Warn2 "自动下载字体失败。请手动下载思源黑体 TTF（Regular）："
            Write-Host "    https://github.com/be5invis/source-han-sans-ttf/releases"
            Write-Host "  重命名为 SourceHanSans.ttf 放入：$fontDir"
            Write-Host "  （不导出 PDF 可跳过此步，其他功能不受影响）"
        }
    }
}

# 自检字体
if (Test-Path $fontPath) {
    $fsize = (Get-Item $fontPath).Length
    if ($fsize -gt 100KB) {
        Write-Ok "字体文件有效（$([math]::Round($fsize/1MB,2)) MB）"
    } else {
        Write-Warn2 "字体文件过小（$fsize bytes），可能下载不完整"
    }
} else {
    Write-Warn2 "字体未放置，导出 PDF 功能将不可用（其他功能正常）"
}

# ============================================================
# 步骤 3：前端构建自检（vue-tsc 类型检查 + vite build）
# ============================================================
Write-Step "前端构建自检（vue-tsc 类型检查 + vite build）"

# 确认 node_modules 存在
if (-not (Test-Path (Join-Path $ProjectRoot "node_modules"))) {
    Write-Host "  node_modules 不存在，执行 npm install..."
    npm install
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm install 失败"; exit 1 }
}

# OCR 模型由 @paddleocr/paddleocr-js 官方包运行时自动下载，无需手动检查

# 确认 WASM 运行时
$wasmDir = Join-Path $ProjectRoot "public\wasm"
if (-not (Test-Path (Join-Path $wasmDir "ort.wasm.mjs"))) {
    Write-Host "  WASM 运行时缺失，执行 npm run postinstall..."
    npm run postinstall
}

# 执行构建（含类型检查）
Write-Host "  执行：npm run build（vue-tsc --noEmit && vite build）"
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Fail "前端构建失败（类型错误或打包错误），请查看上方输出"
    exit 1
}

# 自检：dist 目录
$distDir = Join-Path $ProjectRoot "dist"
if (Test-Path $distDir) {
    $indexHtml = Join-Path $distDir "index.html"
    if (Test-Path $indexHtml) {
        $assets = Get-ChildItem (Join-Path $distDir "assets") -ErrorAction SilentlyContinue
        Write-Ok "前端构建成功：dist/index.html + $($assets.Count) 个资源文件"
    } else {
        Write-Fail "dist/index.html 缺失"
        exit 1
    }
} else {
    Write-Fail "dist 目录不存在"
    exit 1
}

# ============================================================
# 步骤 4：信令服务启动自检
# ============================================================
Write-Step "信令服务启动自检（npm install → 启动 → /health → 停止）"

$serverDir = Join-Path $ProjectRoot "server"
Push-Location $serverDir
try {
    # 安装依赖
    if (-not (Test-Path (Join-Path $serverDir "node_modules"))) {
        Write-Host "  执行：npm install（server）"
        npm install
        if ($LASTEXITCODE -ne 0) { Write-Fail "server npm install 失败"; exit 1 }
    }

    # 确认 .env 存在
    if (-not (Test-Path (Join-Path $serverDir ".env"))) {
        Write-Warn2 "server/.env 不存在，复制 .env.example"
        Copy-Item (Join-Path $serverDir ".env.example") (Join-Path $serverDir ".env")
    }

    # 后台启动信令服务
    Write-Host "  后台启动信令服务（端口 8787）..."
    $proc = Start-Process -FilePath "node" -ArgumentList "signaling.mjs" `
        -WorkingDirectory $serverDir -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $env:TEMP "lts-signal-out.log") `
        -RedirectStandardError  (Join-Path $env:TEMP "lts-signal-err.log")

    # 等待 /health 响应（最多 10 秒）
    $healthOk = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8787/health" -UseBasicParsing -TimeoutSec 2
            if ($resp.StatusCode -eq 200) {
                $healthOk = $true
                Write-Ok "信令服务 /health 响应：$($resp.Content)"
                break
            }
        } catch {
            # 等待启动
        }
    }

    if (-not $healthOk) {
        Write-Fail "信令服务启动失败或端口 8787 未响应"
        Write-Host "  stdout 日志：$(Get-Content (Join-Path $env:TEMP 'lts-signal-out.log') -ErrorAction SilentlyContinue)"
        Write-Host "  stderr 日志：$(Get-Content (Join-Path $env:TEMP 'lts-signal-err.log') -ErrorAction SilentlyContinue)"
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        exit 1
    }

    # 停止服务
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Write-Ok "信令服务自检通过，已停止"
} finally {
    Pop-Location
}

# ============================================================
# 步骤 5：Tauri 桌面构建
# ============================================================
Write-Step "Tauri 桌面构建（npm run tauri:build）"

Write-Host "  执行：npm run tauri:build"
Write-Host "  （首次编译 Rust 依赖较多，可能需要 5-15 分钟，请耐心等待）"
npm run tauri:build
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Tauri 构建失败，请查看上方错误"
    exit 1
}

# 自检：产物
$targetDir = Join-Path $ProjectRoot "src-tauri\target\release"
$nsisDir = Join-Path $targetDir "bundle\nsis"
$msiDir  = Join-Path $targetDir "bundle\msi"
$exePath = Join-Path $targetDir "local-transfer-suite.exe"

$buildOk = $true
if (Test-Path $exePath) {
    Write-Ok "绿色单文件：$exePath（$([math]::Round((Get-Item $exePath).Length/1MB,1)) MB）"
} else {
    Write-Warn2 "未找到绿色单文件 exe（可能 bundle 模式未输出 standalone）"
}

$nsisFiles = Get-ChildItem $nsisDir -Filter "*.exe" -ErrorAction SilentlyContinue
if ($nsisFiles) {
    foreach ($f in $nsisFiles) {
        Write-Ok "NSIS 安装包：$($f.FullName)（$([math]::Round($f.Length/1MB,1)) MB）"
    }
} else {
    Write-Warn2 "未找到 NSIS 安装包"
}

$msiFiles = Get-ChildItem $msiDir -Filter "*.msi" -ErrorAction SilentlyContinue
if ($msiFiles) {
    foreach ($f in $msiFiles) {
        Write-Ok "MSI 安装包：$($f.FullName)（$([math]::Round($f.Length/1MB,1)) MB）"
    }
}

# ============================================================
# 完成汇总
# ============================================================
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  全部构建 + 自检完成！" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "产物路径："
Write-Host "  NSIS 安装包：$nsisDir\*.exe"
Write-Host "  MSI 安装包： $msiDir\*.msi"
Write-Host "  绿色单文件： $exePath"
Write-Host ""
Write-Host "运行安装包后，首次启动会进入：风险确认 → 选择保存目录 → 主界面"
Write-Host ""
Write-Host "互传功能需要信令服务："
Write-Host "  cd server; npm install; npm start    （监听 ws://0.0.0.0:8787/ws）"
Write-Host "  前端 .env 中 VITE_SIGNAL_URL 指向该地址（本地调试用 ws://localhost:8787/ws）"
Write-Host ""
