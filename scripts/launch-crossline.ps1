param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectDir,
    [int]$Port = 3000
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
Require-Command -Name 'cloudflared' -FriendlyName 'Cloudflare Tunnel'

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

$updateScript = Join-Path -Path $resolvedProjectDir -ChildPath 'scripts/update-runtime-config.ps1'
if (-not (Test-Path -Path $updateScript)) {
    throw "Missing script: $updateScript"
}

$cloudflaredArgs = @(
    '/k',
    'title Crossline Tunnel `& cloudflared tunnel run irgri-tunnel'
)
Write-Host '[STEP] Starting Cloudflare tunnel (irgri-tunnel)...'
$tunnelProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList $cloudflaredArgs -WorkingDirectory $resolvedProjectDir -PassThru -WindowStyle Normal

$tunnelInfoLines = & $updateScript -ProjectDir $resolvedProjectDir

$tunnelInfo = @{}
foreach ($line in $tunnelInfoLines) {
    if ($line -match '^(?<Key>[^=]+)=(?<Value>.*)$') {
        $key = $matches['Key'].ToUpperInvariant()
        $value = $matches['Value'].Trim()
        $tunnelInfo[$key] = $value
    }
}

if (-not $tunnelInfo.ContainsKey('TUNNEL_URL')) {
    throw 'Runtime config updater did not return the public tunnel URL.'
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
