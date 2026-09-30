# CollectorsHub scanner host: one long-lived session per scanning page.
#
# Connects to the WIA scanner once and keeps the device/item objects alive, so
# Scan Front / Scan Back / next card reuse the same session: no re-enumeration,
# no reconnect, no crop-helper recompile, and no vendor transfer window
# (Item.Transfer is called directly instead of WIA.CommonDialog.ShowTransfer).
#
# Protocol: one JSON request per stdin line, JSON responses per stdout line.
#   {"id":"1","op":"open"}                                   -> {"id":"1","ok":true,"scannerName":...}
#   {"id":"2","op":"scan","mode":"card"|"full","dpi":600,"intent":1,
#    "region":{"x":0,"y":0,"w":2.7,"h":3.7}|null   (inches; card mode only),
#    "transferPath":"...","rawPath":"...","outputPath":"...","quality":92}
#                                                           -> {"id":"2","event":"processing"} then result
#   {"id":"3","op":"feed","dpi":600,"widthIn":4,"heightIn":4,"outDir":"...","cancelPath":"..."}
#                                                           -> {"id":"3","event":"page",...} per page, then result
#   {"op":"close"}
param([string]$CropSourcePath, [string]$FeedSourcePath)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing
$sources = @($CropSourcePath)
if ($FeedSourcePath) { $sources += $FeedSourcePath }
Add-Type -ReferencedAssemblies System.Drawing -Path $sources

$script:manager = $null
$script:device = $null
$script:item = $null
$script:scannerName = ''
$script:appliedSettings = ''
$script:transferFormat = $null
$script:requestedPx = @{ x = 0; y = 0; w = 0; h = 0 }
$script:regionClamped = $false
$script:bedWidthIn = 0
$script:bedHeightIn = 0

# WIA HRESULTs worth handling explicitly.
$WIA_WARMING_UP = 0x80210007
$WIA_BUSY = 0x80210006
$WIA_OFFLINE = 0x80210005
$WIA_COVER_OPEN = 0x8021000C
$WIA_NO_DEVICE = 0x80210015
$WIA_DEVICE_COMMUNICATION = 0x8021000A

function Send-Reply($reply) {
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}

function Get-HResult($errorRecord) {
  $exception = $errorRecord.Exception
  while ($exception) {
    if ($exception.HResult -and ($exception.HResult -band 0xFFFF0000) -eq 0x80210000) { return $exception.HResult }
    $exception = $exception.InnerException
  }
  return $errorRecord.Exception.HResult
}

function Reset-Device {
  $script:device = $null
  $script:item = $null
  $script:appliedSettings = ''
}

function Open-Scanner([string]$preferredPattern) {
  if (-not $script:manager) { $script:manager = New-Object -ComObject WIA.DeviceManager }
  # Only WIA scanners (Type 1). The Canon TS3700 also exposes an eSCL entry that
  # is not the working WIA acquisition path.
  # Sheet-fed scanners (Epson FastFoto) have no flatbed; they are driven by
  # the feed operation instead.
  $infos = @($script:manager.DeviceInfos | Where-Object { $_.Type -eq 1 -and ([string]$_.Properties.Item('Name').Value) -notmatch $FeederPattern })
  $rows = @($infos | ForEach-Object { @{ name = [string]$_.Properties.Item('Name').Value; deviceId = [string]$_.DeviceID } })
  if ($infos.Count -eq 0) {
    return @{ ok = $false; code = 'NO_DEVICE'; message = 'No scanner was found. Make sure the scanner is on and connected.'; scanners = $rows }
  }
  $info = $infos | Where-Object { ([string]$_.Properties.Item('Name').Value) -match $preferredPattern } | Select-Object -First 1
  if (-not $info -and $infos.Count -eq 1) { $info = $infos[0] }
  if (-not $info) {
    return @{ ok = $false; code = 'NEEDS_SELECTION'; needsSelection = $true; message = 'Multiple scanners are available. Select a default scanner in CollectorsHub scanner settings.'; scanners = $rows }
  }
  $script:device = $info.Connect()
  $script:item = $script:device.Items.Item(1)
  $script:scannerName = [string]$info.Properties.Item('Name').Value
  $script:appliedSettings = ''
  $script:bedWidthIn = 0
  $script:bedHeightIn = 0
  # Bed size is reported in thousandths of an inch.
  try { $script:bedWidthIn = [double]$script:device.Properties.Item('Horizontal Bed Size').Value / 1000 } catch {}
  try { $script:bedHeightIn = [double]$script:device.Properties.Item('Vertical Bed Size').Value / 1000 } catch {}
  # Every item property the driver exposes, for the scanner debug log (this is
  # where any vendor enhancement/gamma controls would appear).
  $properties = @()
  foreach ($property in $script:item.Properties) {
    try {
      $value = $property.Value
      if ($value -is [System.Array] -or $value -is [System.__ComObject]) { continue }
      $properties += @{ id = $property.PropertyID; name = [string]$property.Name; value = [string]$value }
    } catch {}
  }
  return @{ ok = $true; scannerName = $script:scannerName; bedWidthIn = $script:bedWidthIn; bedHeightIn = $script:bedHeightIn; properties = $properties }
}

$FeederPattern = 'FF-680|FastFoto'

# The sheet feeder, if one is connected: @{ name; deviceId } or $null.
function Find-Feeder {
  if (-not $script:manager) { $script:manager = New-Object -ComObject WIA.DeviceManager }
  $info = @($script:manager.DeviceInfos | Where-Object { ([string]$_.Properties.Item('Name').Value) -match $FeederPattern }) | Select-Object -First 1
  if (-not $info) { return $null }
  return @{ name = [string]$info.Properties.Item('Name').Value; deviceId = [string]$info.DeviceID }
}

function Invoke-Feed($request) {
  $feeder = Find-Feeder
  if (-not $feeder) { return @{ ok = $false; code = 'NO_FEEDER'; message = 'The Epson FastFoto was not found. Make sure it is on, connected, and Epson Scan 2 is installed.' } }
  Remove-Item -LiteralPath $request.cancelPath -Force -ErrorAction SilentlyContinue
  $json = [CollectorsHubWiaFeed]::Feed([string]$request.id, $feeder.deviceId, [string]$request.outDir, [string]$request.cancelPath, [int]$request.dpi, [double]$request.widthIn, [double]$request.heightIn, $true)
  $result = @{}
  foreach ($property in ($json | ConvertFrom-Json).PSObject.Properties) { $result[$property.Name] = $property.Value }
  $result.feederName = $feeder.name
  $hr = [string]$result.hresult
  if (-not $result.ok) {
    $result.code = switch ($hr) {
      '0x80210003' { 'NO_PAPER' }
      '0x80210002' { 'PAPER_JAM' }
      '0x80210020' { 'DOUBLE_FEED' }
      '0x80210004' { 'PAPER_PROBLEM' }
      '0x80210006' { 'BUSY' }
      default { 'FEED_FAILED' }
    }
    $result.message = switch ($result.code) {
      'NO_PAPER' { 'No cards in the feeder. Load the stack and scan again.' }
      'PAPER_JAM' { 'A card jammed in the FastFoto. Clear it, reload the remaining cards and scan again.' }
      'DOUBLE_FEED' { 'Two cards fed at once. Reload the remaining cards and scan again.' }
      'PAPER_PROBLEM' { 'The FastFoto reported a feeding problem. Check the cards and scan again.' }
      'BUSY' { 'The FastFoto is busy (another program may be using it).' }
      default { "The FastFoto scan failed ($hr)." }
    }
  } elseif ([int]$result.pages -eq 0 -and -not $result.cancelled) {
    $result.ok = $false
    $result.code = 'NO_PAPER'
    $result.message = 'No cards in the feeder. Load the stack and scan again.'
  }
  return $result
}

function Set-WiaValue([string]$id, $value) {
  try { $script:item.Properties.Item($id).Value = $value; return $true } catch { return $false }
}

function Get-WiaValue([string]$id) {
  try { return $script:item.Properties.Item($id).Value } catch { return $null }
}

# Applies intent -> resolution -> scan region, only when they change (a batch
# reuses the same fixed card region every scan). Intent first because setting
# it resets the other properties to driver defaults. Returns what the driver
# actually holds afterwards, so ignored settings show up in the log.
function Set-ScanSettings($request) {
  $key = "$($request.intent)|$($request.dpi)|$($request.region | ConvertTo-Json -Compress)"
  if ($key -ne $script:appliedSettings) {
    # Photographic capture: intent = image type | WIA_INTENT_MAXIMIZE_QUALITY,
    # then explicit 24-bit colour (data type 3) where the driver allows it.
    [void](Set-WiaValue '6146' ([int]$request.intent))
    if ([int]$request.intent -band 1) { [void](Set-WiaValue '4103' 3); [void](Set-WiaValue '4104' 24) }
    [void](Set-WiaValue '6147' ([int]$request.dpi))
    [void](Set-WiaValue '6148' ([int]$request.dpi))
    $maxWidth = $script:item.Properties.Item('6151').SubTypeMax
    $maxHeight = $script:item.Properties.Item('6152').SubTypeMax
    $script:regionClamped = $false
    if ($request.region) {
      $x = [int][Math]::Round([double]$request.region.x * $request.dpi)
      $y = [int][Math]::Round([double]$request.region.y * $request.dpi)
      $w = [int][Math]::Round([double]$request.region.w * $request.dpi)
      $h = [int][Math]::Round([double]$request.region.h * $request.dpi)
      # Keep the region on the bed (a custom position can drift outside it).
      $x2 = [Math]::Max(0, [Math]::Min($x, $maxWidth - 3)); $y2 = [Math]::Max(0, [Math]::Min($y, $maxHeight - 3))
      $w2 = [Math]::Min($w, $maxWidth - $x2); $h2 = [Math]::Min($h, $maxHeight - $y2)
      $script:regionClamped = ($x2 -ne $x -or $y2 -ne $y -or $w2 -ne $w -or $h2 -ne $h)
      # Extent before start: some drivers validate start + extent <= bed.
      [void](Set-WiaValue '6151' $w2); [void](Set-WiaValue '6152' $h2)
      [void](Set-WiaValue '6149' $x2); [void](Set-WiaValue '6150' $y2)
      [void](Set-WiaValue '6151' $w2); [void](Set-WiaValue '6152' $h2)
      $script:requestedPx = @{ x = $x2; y = $y2; w = $w2; h = $h2 }
    } else {
      [void](Set-WiaValue '6149' 0); [void](Set-WiaValue '6150' 0)
      [void](Set-WiaValue '6151' $maxWidth); [void](Set-WiaValue '6152' $maxHeight)
      $script:requestedPx = @{ x = 0; y = 0; w = $maxWidth; h = $maxHeight }
    }
    $script:appliedSettings = $key
  }
  return @{
    dpi = Get-WiaValue '6147'
    x = Get-WiaValue '6149'; y = Get-WiaValue '6150'
    w = Get-WiaValue '6151'; h = Get-WiaValue '6152'
    intent = Get-WiaValue '6146'
    dataType = Get-WiaValue '4103'
    bitsPerPixel = Get-WiaValue '4104'
    brightness = Get-WiaValue '6154'
    contrast = Get-WiaValue '6155'
    compression = Get-WiaValue '4107'
  }
}

# Direct transfer with no UI. Prefers JPEG (smaller transfer) when the driver
# supports it, otherwise the driver's native BMP; remembers what worked.
function Invoke-Transfer {
  $jpeg = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}'
  if ($script:transferFormat -eq $null) {
    $formats = @($script:item.Formats)
    if ($formats -contains $jpeg) {
      $script:transferFormat = $jpeg
    } else {
      $script:transferFormat = ''
    }
  }
  if ($script:transferFormat) { return $script:item.Transfer($script:transferFormat) }
  return $script:item.Transfer()
}

function Invoke-Scan($request) {
  $total = [Diagnostics.Stopwatch]::StartNew()
  if (-not $script:item) {
    $opened = Open-Scanner $request.prefer
    if (-not $opened.ok) { return $opened }
  }
  $attempt = 0
  $applied = $null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    try {
      $applied = Set-ScanSettings $request
      $sw.Restart()
      $image = Invoke-Transfer
      break
    } catch {
      $hr = Get-HResult $_
      $attempt++
      # Warming up / busy: the driver asks us to wait; retry on the same session.
      if (($hr -eq $WIA_WARMING_UP -or $hr -eq $WIA_BUSY) -and $attempt -le 20) { Start-Sleep -Milliseconds 1500; continue }
      if ($hr -eq $WIA_COVER_OPEN) { return @{ ok = $false; code = 'COVER_OPEN'; message = 'The scanner lid is open. Close it and scan again.' } }
      # Lost device: reconnect once, then give up.
      if ($attempt -le 1 -and ($hr -in @($WIA_OFFLINE, $WIA_NO_DEVICE, $WIA_DEVICE_COMMUNICATION) -or $_.Exception -is [System.Runtime.InteropServices.COMException])) {
        Reset-Device
        $opened = Open-Scanner $request.prefer
        if (-not $opened.ok) { return $opened }
        continue
      }
      Reset-Device
      return @{ ok = $false; code = 'TRANSFER_FAILED'; message = $_.Exception.Message; hresult = ('0x{0:X8}' -f $hr) }
    }
  }
  $transferMs = $sw.ElapsedMilliseconds
  Send-Reply @{ id = $request.id; event = 'processing' }

  $sw.Restart()
  if (Test-Path -LiteralPath $request.transferPath) { Remove-Item -LiteralPath $request.transferPath -Force }
  $image.SaveFile($request.transferPath)
  $saveTransferMs = $sw.ElapsedMilliseconds

  # Did the driver honour the hardware region? Compare what came back with
  # what was requested; if it returned more, the region is cut in software.
  $req = $script:requestedPx
  $returnedW = [int]$image.Width
  $returnedH = [int]$image.Height
  $hardwareRoi = [bool]($request.region -and $returnedW -le [Math]::Ceiling($req.w * 1.05) -and $returnedH -le [Math]::Ceiling($req.h * 1.05))

  $sw.Restart()
  if ($request.mode -eq 'card') {
    $json = [CollectorsHubScanCrop]::ProcessScan($request.transferPath, $request.rawPath, $request.outputPath, [string]$request.displayPath, [long]$request.quality, 'card', [int]$request.dpi, [int]$req.x, [int]$req.y, [int]$req.w, [int]$req.h, $hardwareRoi)
  } else {
    $json = [CollectorsHubScanCrop]::ProcessScan($request.transferPath, $request.rawPath, $request.outputPath, [string]$request.displayPath, [long]$request.quality, 'full', [int]$request.dpi, 0, 0, 0, 0, $false)
  }
  $processMs = $sw.ElapsedMilliseconds
  Remove-Item -LiteralPath $request.transferPath -Force -ErrorAction SilentlyContinue

  $reply = @{
    ok = $true
    scannerName = $script:scannerName
    mode = $request.mode
    dpi = [int]$request.dpi
    requestedRegionIn = $request.region
    requestedPx = $req
    appliedPx = $applied
    regionClamped = [bool]$script:regionClamped
    hardwareRoi = $hardwareRoi
    transferFormat = $(if ($script:transferFormat) { 'jpeg' } else { 'bmp' })
    transferMs = $transferMs
    saveTransferMs = $saveTransferMs
    processMs = $processMs
    totalMs = $total.ElapsedMilliseconds
  }
  $crop = $json | ConvertFrom-Json
  foreach ($property in $crop.PSObject.Properties) { $reply[$property.Name] = $property.Value }
  return $reply
}

Send-Reply @{ event = 'started' }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  if (-not $line.Trim()) { continue }
  $request = $null
  try {
    $request = $line | ConvertFrom-Json
    if ($request.op -eq 'close') { break }
    if ($request.op -eq 'open') {
      if ($script:item) { $result = @{ ok = $true; scannerName = $script:scannerName } } else { $result = Open-Scanner $request.prefer }
      $feeder = Find-Feeder
      $result.feederName = if ($feeder) { $feeder.name } else { '' }
    } elseif ($request.op -eq 'feeder') {
      $feeder = Find-Feeder
      $result = @{ ok = $true; feederName = $(if ($feeder) { $feeder.name } else { '' }) }
    } elseif ($request.op -eq 'feed') {
      $result = Invoke-Feed $request
    } elseif ($request.op -eq 'scan') {
      $result = Invoke-Scan $request
    } else {
      $result = @{ ok = $false; code = 'BAD_REQUEST'; message = "Unknown operation: $($request.op)" }
    }
  } catch {
    Reset-Device
    $result = @{ ok = $false; code = 'HOST_ERROR'; message = $_.Exception.Message }
  }
  $result.id = if ($request) { $request.id } else { $null }
  Send-Reply $result
}
