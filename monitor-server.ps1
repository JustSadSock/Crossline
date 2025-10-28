# Server Monitor for Crossline
# Displays real-time server status and logs

$host.UI.RawUI.WindowTitle = "Server Logs Monitor"
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   Crossline Server Monitor" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Get port from environment or default
$port = if ($env:PORT) { $env:PORT } else { "3000" }
$serverUrl = "http://localhost:$port"

function Get-ServerStatus {
    try {
        $response = Invoke-WebRequest -Uri "$serverUrl/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        return @{ Online = $true; Status = $response.StatusCode }
    } catch {
        return @{ Online = $false; Error = $_.Exception.Message }
    }
}

function Get-RoomsList {
    try {
        $response = Invoke-RestMethod -Uri "$serverUrl/rooms" -TimeoutSec 2 -ErrorAction Stop
        return $response
    } catch {
        return $null
    }
}

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting monitor..." -ForegroundColor Yellow
Write-Host "Server URL: $serverUrl" -ForegroundColor Gray
Write-Host ""

$checkInterval = 3
$lastStatus = $null

while ($true) {
    $timestamp = Get-Date -Format 'HH:mm:ss'
    
    # Check server status
    $status = Get-ServerStatus
    
    if ($status.Online) {
        if ($lastStatus -ne "online") {
            Write-Host "[$timestamp] " -NoNewline -ForegroundColor Gray
            Write-Host "SERVER ONLINE" -ForegroundColor Green
            $lastStatus = "online"
        }
        
        # Get rooms info
        $rooms = Get-RoomsList
        if ($rooms) {
            Write-Host "[$timestamp] Active rooms: $($rooms.Count)" -ForegroundColor Cyan
            foreach ($room in $rooms) {
                Write-Host "  - $($room.name): $($room.players)/$($room.maxPlayers) players [$($room.status)]" -ForegroundColor Gray
            }
        } else {
            Write-Host "[$timestamp] No rooms available" -ForegroundColor Gray
        }
    } else {
        if ($lastStatus -ne "offline") {
            Write-Host "[$timestamp] " -NoNewline -ForegroundColor Gray
            Write-Host "SERVER OFFLINE" -ForegroundColor Red
            Write-Host "  Waiting for server to start..." -ForegroundColor Yellow
            $lastStatus = "offline"
        }
    }
    
    Write-Host ""
    Start-Sleep -Seconds $checkInterval
}
