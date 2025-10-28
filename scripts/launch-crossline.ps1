param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectDir,
    [int]$Port = 3000,
    [int]$TunnelTimeoutSeconds = 120
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$resolvedProjectDir = (Resolve-Path -Path $ProjectDir).ProviderPath
Write-Host ("[INFO] Каталог проекта: {0}" -f $resolvedProjectDir)

function Require-Command {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [string]$FriendlyName
    )

    if (-not $FriendlyName) {
        $FriendlyName = $Name
    }

    if (-not (Get-Command -Name $Name -ErrorAction SilentlyContinue)) {
        throw ("{0} ({1}) не найден в PATH." -f $FriendlyName, $Name)
    }
}

function Resolve-Ngrok {
    if ($env:NGROK_EXE) {
        $candidate = $env:NGROK_EXE
        if (Test-Path -Path $candidate) {
            return (Resolve-Path -Path $candidate).ProviderPath
        }

        Write-Warning ("NGROK_EXE указывает на несуществующий файл: {0}" -f $candidate)
    }

    $command = Get-Command -Name 'ngrok' -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Path
    }

    throw 'ngrok не найден. Установите его и добавьте в PATH либо задайте NGROK_EXE.'
}

Require-Command -Name 'node' -FriendlyName 'Node.js'
Require-Command -Name 'npm'
$ngrokExe = Resolve-Ngrok
Write-Host ("[INFO] Используется ngrok: {0}" -f $ngrokExe)

if ($env:NGROK_AUTHTOKEN) {
    try {
        & $ngrokExe config add-authtoken $env:NGROK_AUTHTOKEN | Out-Null
        Write-Host '[INFO] Токен ngrok применён.'
    } catch {
        Write-Warning ("Не удалось применить NGROK_AUTHTOKEN: {0}" -f $_.Exception.Message)
    }
} else {
    Write-Warning 'NGROK_AUTHTOKEN не задан. При необходимости авторизуйте ngrok вручную.'
}

$nodeModules = Join-Path -Path $resolvedProjectDir -ChildPath 'node_modules'
if (-not (Test-Path -Path $nodeModules)) {
    Write-Host '[STEP] Установка зависимостей (npm ci)...'
    Push-Location -Path $resolvedProjectDir
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) {
            throw ("npm ci завершился с ошибкой (код {0})." -f $LASTEXITCODE)
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Host '[INFO] node_modules найден. Пропускаем npm ci.'
}

$env:PORT = $Port

$serverArgs = @(
    '/k',
    ('title Crossline API & set PORT={0} & node server/index.js' -f $Port)
)
Write-Host ("[STEP] Запуск локального сервера на http://localhost:{0} ..." -f $Port)
$serverProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList $serverArgs -WorkingDirectory $resolvedProjectDir -PassThru -WindowStyle Normal

$ngrokArgs = @(
    '/k',
    ('title Crossline Ngrok & "{0}" http {1} --host-header=localhost:{1}' -f $ngrokExe, $Port)
)
Write-Host '[STEP] Запуск ngrok туннеля...'
$ngrokProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList $ngrokArgs -WorkingDirectory $resolvedProjectDir -PassThru -WindowStyle Normal

Write-Host ("[INFO] Ожидание публичного адреса от ngrok (до {0} с)..." -f $TunnelTimeoutSeconds)
$updateScript = Join-Path -Path $resolvedProjectDir -ChildPath 'scripts/update-runtime-config.ps1'
if (-not (Test-Path -Path $updateScript)) {
    throw ("Не найден файл {0}" -f $updateScript)
}

$tunnelInfoLines = & $updateScript -ProjectDir $resolvedProjectDir -TimeoutSeconds $TunnelTimeoutSeconds

$tunnelInfo = @{}
foreach ($line in $tunnelInfoLines) {
    if ($line -match '^(?<Key>[^=]+)=(?<Value>.*)$') {
        $key = $matches['Key'].ToUpperInvariant()
        $value = $matches['Value'].Trim()
        $tunnelInfo[$key] = $value
    }
}

if (-not $tunnelInfo.ContainsKey('TUNNEL_URL')) {
    throw 'Скрипт обновления не вернул публичный адрес ngrok.'
}

$publicUrl = $tunnelInfo['TUNNEL_URL']
$configPath = $tunnelInfo['CONFIG_PATH']
$wsUrl = $null
if ($tunnelInfo.ContainsKey('WS_URL')) {
    $wsUrl = $tunnelInfo['WS_URL']
}

Write-Host ("[READY] HTTP  -> {0}" -f $publicUrl) -ForegroundColor Green
if ($wsUrl) {
    Write-Host ("[READY] WS    -> {0}" -f $wsUrl) -ForegroundColor Green
}
if ($configPath) {
    Write-Host ("[INFO] Runtime config: {0}" -f $configPath) -ForegroundColor Cyan
}

Write-Host '[HINT] Используйте этот адрес в настройках Netlify или переменных окружения CROSSLINE_API_URL / CROSSLINE_WS_URL.' -ForegroundColor Yellow

$monitorScript = Join-Path -Path $resolvedProjectDir -ChildPath 'monitor-server.ps1'
if (Test-Path -Path $monitorScript) {
    Write-Host '[STEP] Запуск окна мониторинга сервера...'
    $monitorArgs = @(
        '-NoExit',
        '-NoLogo',
        '-ExecutionPolicy', 'Bypass',
        '-File', $monitorScript
    )
    Start-Process -FilePath 'powershell.exe' -ArgumentList $monitorArgs -WorkingDirectory $resolvedProjectDir -WindowStyle Normal | Out-Null
} else {
    Write-Warning 'monitor-server.ps1 не найден, мониторинг не запущен.'
}

Write-Host '[DONE] Все процессы запущены. Не закрывайте созданные окна, пока игра работает.' -ForegroundColor Magenta

exit 0
