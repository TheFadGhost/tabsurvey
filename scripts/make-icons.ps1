$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function New-Icon {
  param([int]$Size, [string]$Path)
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $radius = [Math]::Max(2, [int]($Size * 0.22))
  $edge = $Size - 1
  $d = $radius * 2
  $bgBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 31, 35, 43))
  $pathObj = New-Object System.Drawing.Drawing2D.GraphicsPath
  $pathObj.AddArc(0, 0, $d, $d, 180, 90)
  $pathObj.AddArc(($edge - $d), 0, $d, $d, 270, 90)
  $pathObj.AddArc(($edge - $d), ($edge - $d), $d, $d, 0, 90)
  $pathObj.AddArc(0, ($edge - $d), $d, $d, 90, 90)
  $pathObj.CloseFigure()
  $g.FillPath($bgBrush, $pathObj)

  $barH = [Math]::Max(1, [int]($Size * 0.11))
  $gap = [int]($Size * 0.10)
  $x0 = [int]($Size * 0.22)
  $y0 = [int]($Size * 0.30)
  $white = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 235, 237, 240))
  $amber = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 217, 161, 59))

  $fractions = @(0.56, 0.44, 0.32)
  for ($i = 0; $i -lt 3; $i++) {
    $w = [int]($Size * $fractions[$i])
    $y = $y0 + $i * ($barH + $gap)
    $barRect = New-Object System.Drawing.Rectangle -ArgumentList $x0, $y, $w, $barH
    if ($i -eq 1) { $g.FillRectangle($amber, $barRect) } else { $g.FillRectangle($white, $barRect) }
  }
  $dotSize = [Math]::Max(1, [int]($Size * 0.09))
  $dotX = [int]($Size * 0.70)
  $dotRect = New-Object System.Drawing.Rectangle -ArgumentList $dotX, $y0, $dotSize, $dotSize
  $g.FillEllipse($white, $dotRect)

  $g.Dispose()
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$root = Join-Path $PSScriptRoot "..\icons"
New-Item -ItemType Directory -Force -Path $root | Out-Null
foreach ($s in @(16, 32, 48, 128)) {
  New-Icon -Size $s -Path (Join-Path $root ("icon{0}.png" -f $s))
}
Write-Output "icons written"
