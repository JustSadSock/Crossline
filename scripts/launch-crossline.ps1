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

function Get-PackageManifest {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectDir
    )

    $packagePath = Join-Path -Path $ProjectDir -ChildPath 'package.json'
    if (-not (Test-Path -Path $packagePath)) {
        Write-Warning "package.json was not found in $ProjectDir"
        return $null
    }

    try {
        $raw = Get-Content -Path $packagePath -Raw -ErrorAction Stop
        return $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        Write-Warning "Failed to parse package.json: $($_.Exception.Message)"
        return $null
    }
}

function Get-RequiredPackageNames {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Manifest
    )

    $names = New-Object System.Collections.Generic.List[string]
    $sections = @('dependencies', 'devDependencies')

    foreach ($section in $sections) {
        $dependencies = $null

        if ($Manifest -is [System.Collections.IDictionary]) {
            if ($Manifest.Contains($section)) {
                $dependencies = $Manifest[$section]
            }
        } elseif ($Manifest.PSObject -and $Manifest.PSObject.Properties.Name -contains $section) {
            $dependencies = $Manifest.$section
        }

        if (-not $dependencies) {
            continue
        }

        if ($dependencies -is [System.Collections.IDictionary]) {
            foreach ($key in $dependencies.Keys) {
                if ($key -and -not $names.Contains([string]$key)) {
                    [void]$names.Add([string]$key)
                }
            }
        } elseif ($dependencies.PSObject) {
            foreach ($property in $dependencies.PSObject.Properties) {
                if ($property.Name -and -not $names.Contains([string]$property.Name)) {
                    [void]$names.Add([string]$property.Name)
                }
            }
        }
    }

    return $names.ToArray()
}

function Test-PackageInstalled {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ModulesRoot,
        [Parameter(Mandatory = $true)]
        [string]$PackageName
    )

    $segments = $PackageName -split '/'
    $candidate = $ModulesRoot
    foreach ($segment in $segments) {
        $candidate = Join-Path -Path $candidate -ChildPath $segment
    }

    return Test-Path -Path $candidate
}

function Get-MissingPackages {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ModulesRoot,
        [Parameter(Mandatory = $true)]
        [object]$Manifest
    )

    $missing = New-Object System.Collections.Generic.List[string]
    $requiredPackages = Get-RequiredPackageNames -Manifest $Manifest

    foreach ($package in $requiredPackages) {
        if ([string]::IsNullOrWhiteSpace($package)) {
            continue
        }

        if (-not (Test-PackageInstalled -ModulesRoot $ModulesRoot -PackageName $package)) {
            $missing.Add($package)
        }
    }

    return $missing.ToArray()
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
$manifest = Get-PackageManifest -ProjectDir $resolvedProjectDir
$shouldInstall = $false
$installReason = ''

if (-not (Test-Path -Path $nodeModules)) {
    $shouldInstall = $true
    $installReason = 'node_modules directory is missing'
} elseif ($manifest) {
    try {
        $missingPackages = @(Get-MissingPackages -ModulesRoot $nodeModules -Manifest $manifest)
        $missingCount = $missingPackages.Count
        if ($missingCount -gt 0) {
            $shouldInstall = $true
            $installReason = "missing packages: $($missingPackages -join ', ')"
        }
    } catch {
        $shouldInstall = $true
        $scanMessage = $_.Exception.Message
        if (-not [string]::IsNullOrWhiteSpace($scanMessage)) {
            $installReason = "dependency scan failed: $scanMessage"
        } else {
            $installReason = 'dependency scan failed'
        }
        Write-Warning "Falling back to npm ci because node_modules could not be scanned: $installReason"
    }
}

if ($shouldInstall) {
    if ($installReason) {
        Write-Host "[STEP] Installing dependencies (npm ci) - $installReason..."
    } else {
        Write-Host '[STEP] Installing dependencies (npm ci)...'
    }
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
    Write-Host '[INFO] All npm dependencies are installed. Skipping npm ci.'
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
