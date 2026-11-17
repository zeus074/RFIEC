# Flashes the RFIEC firmware on an Arduino Pro Micro (ATmega32U4, 5 V / 16 MHz) through its Caterina bootloader.
#
#   powershell -ExecutionPolicy Bypass -File tools\flash-promicro.ps1                  (hex\rfiec-v2.6.hex)
#   powershell -ExecutionPolicy Bypass -File tools\flash-promicro.ps1 -Hex other.hex   (any other .hex)
#   ... -Port COM7                                                                    (if the bootloader port is not found)
#
# Uses the avrdude installed with the Arduino IDE. The bootloader is kept: you can reflash whenever you like.
param([string]$Hex = '', [string]$Port = '')

if (-not $Hex) { $Hex = Join-Path (Split-Path $PSScriptRoot) 'hex\rfiec-v2.6.hex' }
$avr = Get-ChildItem "$env:LOCALAPPDATA\Arduino15\packages\arduino\tools\avrdude" -Recurse -Filter avrdude.exe -ErrorAction SilentlyContinue |
       Sort-Object FullName -Descending | Select-Object -First 1
if (-not $avr) { Write-Host 'avrdude not found: install the Arduino IDE (or avrdude) and try again.'; exit 1 }
$conf = Join-Path (Split-Path (Split-Path $avr.FullName)) 'etc\avrdude.conf'
if (-not (Test-Path $conf)) { $conf = Join-Path (Split-Path $avr.FullName) 'avrdude.conf' }
Write-Host "Firmware: $Hex"
Write-Host "avrdude:  $($avr.FullName)"

if (-not $Port) {
  $before = [System.IO.Ports.SerialPort]::GetPortNames()
  Write-Host ''
  Write-Host 'Now DOUBLE-RESET the board: touch the RST pin to GND twice, quickly.'
  Write-Host 'The Pro Micro LED pulses slowly: the bootloader stays active for about 8 seconds.'
  Write-Host 'Waiting 30 seconds for the bootloader port...'
  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 150
    $new = @([System.IO.Ports.SerialPort]::GetPortNames() | Where-Object { $before -notcontains $_ })
  } until ($new.Count -gt 0 -or (Get-Date) -gt $deadline)
  if ($new.Count -eq 0) {
    Write-Host 'No new port. Ports present now:' ([System.IO.Ports.SerialPort]::GetPortNames() -join ', ')
    Write-Host 'Try again, or give the bootloader port with -Port COMx.'
    exit 1
  }
  $Port = $new[0]
  Start-Sleep -Milliseconds 500
}
Write-Host "Bootloader on ${Port}: flashing..."
& $avr.FullName -C $conf -p m32u4 -c avr109 -P $Port -b 57600 -D -U "flash:w:${Hex}:i"
if ($LASTEXITCODE -eq 0) {
  Write-Host ''
  Write-Host 'Done. Unplug and replug the Pro Micro: it shows up as a serial port named "RFIEC".'
} else {
  Write-Host 'Flashing failed: double-reset again and run the script right after.'
}
