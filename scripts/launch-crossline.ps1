param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectDir,
    [int]$Port = 3000,
    [int]$TunnelTimeoutSeconds = 120
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$resolvedProjectDir = (Resolve-Path -Path $ProjectDir).ProviderPath
Write-Host "[INFO] Project directory: $resolvedProjectDir"

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
        throw "$FriendlyName ($Name) was not found in PATH."
    }
}

function Resolve-Ngrok {
    if ($env:NGROK_EXE) {
        $candidate = $env:NGROK_EXE
        if (Test-Path -Path $candidate) {
            return (Resolve-Path -Path $candidate).ProviderPath
        }

        Write-Warning "NGROK_EXE points to a missing file: $candidate"
    }

    $command = Get-Command -Name 'ngrok' -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Path
    }

    throw 'ngrok was not found. Install it, add it to PATH, or set NGROK_EXE.'
}

Require-Command -Name 'node' -FriendlyName 'Node.js'
Require-Command -Name 'npm'
$ngrokExe = Resolve-Ngrok
Write-Host "[INFO] Using ngrok: $ngrokExe"

if ($env:NGROK_AUTHTOKEN) {
    try {
        & $ngrokExe config add-authtoken $env:NGROK_AUTHTOKEN | Out-Null
        Write-Host '[INFO] Applied NGROK_AUTHTOKEN.'
    } catch {
        Write-Warning "Failed to apply NGROK_AUTHTOKEN: $($_.Exception.Message)"
    }
} else {
    Write-Warning 'NGROK_AUTHTOKEN is not set. Authorise ngrok manually if required.'
}

$nodeModules = Join-Path -Path $resolvedProjectDir -ChildPath 'node_modules'
if (-not (Test-Path -Path $nodeModules)) {
    Write-Host '[STEP] Installing dependencies (npm ci)...'
    Push-Location -Path $resolvedProjectDir
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Host '[INFO] node_modules found. Skipping npm ci.'
}

$env:PORT = "$Port"

$serverArgs = @(
    '/k',
    "title Crossline API `& set PORT=$Port `& node server/index.js"
)
Write-Host "[STEP] Starting local server on http://localhost:$Port ..."
$serverProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList $serverArgs -WorkingDirectory $resolvedProjectDir -PassThru -WindowStyle Normal

$ngrokArgs = @(
    '/k',
    "title Crossline Ngrok `& `"$ngrokExe`" http $Port --host-header=localhost:$Port"
)
Write-Host '[STEP] Starting ngrok tunnel...'
$ngrokProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList $ngrokArgs -WorkingDirectory $resolvedProjectDir -PassThru -WindowStyle Normal

Write-Host "[INFO] Waiting for ngrok public URL (timeout: $TunnelTimeoutSeconds s)..."
$updateScript = Join-Path -Path $resolvedProjectDir -ChildPath 'scripts/update-runtime-config.ps1'
if (-not (Test-Path -Path $updateScript)) {
    throw "Missing script: $updateScript"
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
    throw 'Runtime config updater did not return a public ngrok URL.'
}

$publicUrl = $tunnelInfo['TUNNEL_URL']
$configPath = $tunnelInfo['CONFIG_PATH']
$wsUrl = $null
if ($tunnelInfo.ContainsKey('WS_URL')) {
    $wsUrl = $tunnelInfo['WS_URL']
}

$env:CROSSLINE_API_URL = $publicUrl
if ($wsUrl) {
    $env:CROSSLINE_WS_URL = $wsUrl
} else {
    Remove-Item Env:CROSSLINE_WS_URL -ErrorAction SilentlyContinue | Out-Null
}

Write-Host "[READY] HTTP  -> $publicUrl" -ForegroundColor Green
if ($wsUrl) {
    Write-Host "[READY] WS    -> $wsUrl" -ForegroundColor Green
}
if ($configPath) {
    Write-Host "[INFO] Runtime config: $configPath" -ForegroundColor Cyan
}

Write-Host '[HINT] Use this origin for CROSSLINE_API_URL and append ?server=<origin> when opening index.html.' -ForegroundColor Yellow
Write-Host '[HINT] Always prefer https:// endpoints so the client can negotiate wss:// sockets.' -ForegroundColor Yellow

$monitorScript = Join-Path -Path $resolvedProjectDir -ChildPath 'monitor-server.ps1'
if (Test-Path -Path $monitorScript) {
    Write-Host '[STEP] Launching server monitor window...'
    $monitorArgs = @(
        '-NoExit',
        '-NoLogo',
        '-ExecutionPolicy', 'Bypass',
        '-File', $monitorScript
    )
    Start-Process -FilePath 'powershell.exe' -ArgumentList $monitorArgs -WorkingDirectory $resolvedProjectDir -WindowStyle Normal | Out-Null
} else {
    Write-Warning 'monitor-server.ps1 was not found. Skipping monitor launch.'
}

Write-Host '[DONE] All processes are running. Keep the windows open while the game is active.' -ForegroundColor Magenta

exit 0
