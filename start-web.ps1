# MPTrace web mode launcher: start signaling + vite, then open browser with LAN IP
# All logic here; start-web.bat only bypasses execution policy to run this file.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Get-LanIp {
  # Prefer an active Wi-Fi adapter, skip virtual / disconnected / link-local
  $adapters = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {
    $_.Status -eq 'Up' -and
    ($_.Name -notmatch 'VMware|VirtualBox|Hyper-V|Loopback|Bluetooth|蓝牙')
  }
  # Wi-Fi first
  $ordered = @($adapters | Where-Object { $_.Name -match 'WLAN|Wi-Fi|Wireless|无线' }) +
             @($adapters | Where-Object { $_.Name -notmatch 'WLAN|Wi-Fi|Wireless|无线' })
  foreach ($a in $ordered) {
    $ip = Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' } |
      Select-Object -First 1
    if ($ip) { return $ip.IPAddress }
  }
  return $null
}

$lanIp = Get-LanIp
$hostName = if ($lanIp) { $lanIp } else { 'localhost' }

Write-Host "Detected LAN IP: $hostName" -ForegroundColor Green
Write-Host "Starting signaling server..."
Start-Process cmd -ArgumentList '/k', "cd /d `"$root`" && node server/signaling.mjs"
Start-Sleep -Seconds 2

Write-Host "Starting web (vite) server..."
Start-Process cmd -ArgumentList '/k', "cd /d `"$root`" && npm run dev"
Write-Host "Waiting for vite..."
Start-Sleep -Seconds 7

$url = "http://${hostName}:1420"
Write-Host "Opening browser at $url"
Start-Process $url

Write-Host ""
Write-Host "============================================================"
Write-Host "  Steps:"
Write-Host "   1. Open Transfer tab, click Receive"
Write-Host "   2. On phone: app -> Transfer -> Scan"
Write-Host "   3. Scan the QR code on the PC screen"
Write-Host "   4. Connected - send files"
Write-Host "============================================================"
Write-Host ""
Write-Host "To stop, close the two spawned windows (signaling / vite)."
