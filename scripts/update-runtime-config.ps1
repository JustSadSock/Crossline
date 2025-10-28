param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectDir,
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$publicUrl = $null

while ((Get-Date) -lt $deadline) {
    try {
        $response = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2
        if ($response -and $response.tunnels) {
            $publicUrl = ($response.tunnels | Where-Object { $_.proto -eq 'https' } | Select-Object -First 1).public_url
            if (-not $publicUrl) {
                $publicUrl = ($response.tunnels | Select-Object -First 1).public_url
            }
        }
    } catch {
        Start-Sleep -Seconds 2
        continue
    }

    if ($publicUrl) {
        break
    }

    Start-Sleep -Seconds 2
}

if (-not $publicUrl) {
    throw "Ngrok tunnel was not found within $TimeoutSeconds seconds."
}

try {
    $uri = [Uri]$publicUrl
    $wsScheme = if ($uri.Scheme -eq 'https') { 'wss:' } else { 'ws:' }
    $wsUrl = "${wsScheme}//$($uri.Authority)"
} catch {
    $wsUrl = $null
}

$configPath = [IO.Path]::Combine($ProjectDir, 'scripts', 'runtime-config.js')
$configLines = @(
    '(function setCrosslineConfig() {',
    "  const tunnelOrigin = '$publicUrl';",
    '  if (!tunnelOrigin) return;',
    '  window.CROSSLINE_API_URL = tunnelOrigin;',
    '  try {',
    '    const parsed = new URL(tunnelOrigin);',
    "    const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';",
    "    window.CROSSLINE_WS_URL = `${wsProtocol}//${parsed.host}`;",
    '  } catch (error) {',
    "    console.warn('WS URL config error', error);",
    '  }',
    '})();'
)

$encoding = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllLines($configPath, $configLines, $encoding)

Write-Output "TUNNEL_URL=$publicUrl"
if ($wsUrl) {
    Write-Output "WS_URL=$wsUrl"
}
Write-Output "CONFIG_PATH=$configPath"
