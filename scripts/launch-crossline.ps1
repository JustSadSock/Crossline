param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectDir,
    [int]$Port = 3000,
    [int]$TunnelTimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedProjectDir = (Resolve-Path -Path $ProjectDir).ProviderPath
Write-Host "[INFO] Project directory: $resolvedProjectDir"

function Require-Command {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [string]$FriendlyName = $Name
    )

    if (-not (Get-Command -Name $Name -ErrorAction SilentlyContinue)) {
        throw "${FriendlyName} ($Name) не найден в PATH."
    }
}

function Resolve-Ngrok {
    if ($env:NGROK_EXE) {
        $candidate = $env:NGROK_EXE
        if (Test-Path -Path $candidate) {
            return (Resolve-Path -Path $candidate).ProviderPath
        }
        Write-Warning "NGROK_EXE указывает на несуществующий файл: $candidate"
    }

    $command = Get-Command -Name "ngrok" -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Path
    }

    throw "ngrok не найден. Установите его и добавьте в PATH либо задайте NGROK_EXE."
}

Require-Command -Name "node" -FriendlyName "Node.js"
Require-Command -Name "npm"
$ngrokExe = Resolve-Ngrok
Write-Host "[INFO] Используется ngrok: $ngrokExe"

if ($env:NGROK_AUTHTOKEN) {
    try {
        & $ngrokExe config add-authtoken $env:NGROK_AUTHTOKEN | Out-Null
        Write-Host "[INFO] Токен ngrok применён."
    } catch {
        Write-Warning "Не удалось применить NGROK_AUTHTOKEN: $($_.Exception.Message)"
    }
} else {
    Write-Warning "NGROK_AUTHTOKEN не задан. При необходимости авторизуйте ngrok вручную."
}

$nodeModules = Join-Path -Path $resolvedProjectDir -ChildPath "node_modules"
if (-not (Test-Path -Path $nodeModules)) {
    Write-Host "[STEP] Установка зависимостей (npm ci)..."
    Push-Location -Path $resolvedProjectDir
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci завершился с ошибкой (код $LASTEXITCODE)."
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Host "[INFO] node_modules найден. Пропускаем npm ci."
}

$env:PORT = $Port

$serverCommand = "title Crossline API && cd /d `"$resolvedProjectDir`" && set PORT=$Port && node server/index.js"
Write-Host "[STEP] Запуск локального сервера на http://localhost:$Port ..."
$serverProcess = Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $serverCommand -WorkingDirectory $resolvedProjectDir -PassThru -WindowStyle Normal

$ngrokCommand = "title Crossline Ngrok && cd /d `"$resolvedProjectDir`" && `"$ngrokExe`" http $Port --host-header=localhost:$Port"
Write-Host "[STEP] Запуск ngrok туннеля..."
$ngrokProcess = Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $ngrokCommand -WorkingDirectory $resolvedProjectDir -PassThru -WindowStyle Normal

Write-Host "[INFO] Ожидание публичного адреса от ngrok (до $TunnelTimeoutSeconds c)..."
$updateScript = Join-Path -Path $resolvedProjectDir -ChildPath "scripts/update-runtime-config.ps1"
if (-not (Test-Path -Path $updateScript)) {
    throw "Не найден файл $updateScript"
}

$tunnelInfoLines = & $updateScript -ProjectDir $resolvedProjectDir -TimeoutSeconds $TunnelTimeoutSeconds

$tunnelInfo = @{}
foreach ($line in $tunnelInfoLines) {
    if ($line -match '^(?<Key>[^=]+)=(?<Value>.*)$') {
        $tunnelInfo[$matches.Key.ToUpperInvariant()] = $matches.Value.Trim()
    }
}

if (-not $tunnelInfo.ContainsKey('TUNNEL_URL')) {
    throw "Скрипт обновления не вернул публичный адрес ngrok."
}

$publicUrl = $tunnelInfo['TUNNEL_URL']
$configPath = $tunnelInfo['CONFIG_PATH']
$wsUrl = $null
if ($tunnelInfo.ContainsKey('WS_URL')) {
    $wsUrl = $tunnelInfo['WS_URL']
}

Write-Host "[READY] HTTP  -> $publicUrl" -ForegroundColor Green
if ($wsUrl) {
    Write-Host "[READY] WS    -> $wsUrl" -ForegroundColor Green
}
if ($configPath) {
    Write-Host "[INFO] Runtime config: $configPath" -ForegroundColor Cyan
}

Write-Host "[HINT] Используйте этот адрес в настройках Netlify или переменных окружения CROSSLINE_API_URL / CROSSLINE_WS_URL." -ForegroundColor Yellow

$monitorScript = Join-Path -Path $resolvedProjectDir -ChildPath "monitor-server.ps1"
if (Test-Path -Path $monitorScript) {
    Write-Host "[STEP] Запуск окна мониторинга сервера..."
    $monitorArgs = @("-NoExit", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", "`"$monitorScript`"")
    Start-Process -FilePath "powershell.exe" -ArgumentList $monitorArgs -WorkingDirectory $resolvedProjectDir -WindowStyle Normal | Out-Null
} else {
    Write-Warning "monitor-server.ps1 не найден, мониторинг не запущен."
}

Write-Host "[DONE] Все процессы запущены. Не закрывайте созданные окна, пока игра работает." -ForegroundColor Magenta

# Return success
exit 0
