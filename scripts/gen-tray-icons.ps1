#requires -Version 7
<#
  gen-tray-icons.ps1 — 生成 ollama-tray 图标
  官网羊驼图 ollama-icon.png 为 181x256（竖长），直接拉伸会变形。
  本脚本先生成「正方形羊驼底座」ollama-square.png，再基于它生成：
    - 4 个 32x32 托盘状态角标（tray-ok / warn / error / idle）
    - 1 个 256x256 应用打包图标（tray-icon.png）
  用法：pwsh scripts/gen-tray-icons.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
Add-Type -AssemblyName System.Drawing

$base = [System.Drawing.Image]::FromFile((Join-Path $assets 'ollama-icon.png'))
$bw = $base.Width; $bh = $base.Height

# ─── 正方形底座（256x256，透明底，原图按 contain 缩放居中）───
$sqSize = 256
$sq = New-Object System.Drawing.Bitmap($sqSize, $sqSize)
$sqg = [System.Drawing.Graphics]::FromImage($sq)
$sqg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$sqg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$sqg.Clear([System.Drawing.Color]::Transparent)
# contain：目标短边留边，羊驼占 ~92% 高度，其余透明
$pad = $sqSize * 0.04
$maxW = $sqSize - 2 * $pad
$maxH = $sqSize - 2 * $pad
$scale = [Math]::Min($maxW / $bw, $maxH / $bh)
$dw = [int]($bw * $scale); $dh = [int]($bh * $scale)
$dx = [int](($sqSize - $dw) / 2); $dy = [int](($sqSize - $dh) / 2)
$sqg.DrawImage($base, $dx, $dy, $dw, $dh)
$sqPath = Join-Path $assets 'ollama-square.png'
$sq.Save($sqPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "generated: $sqPath"
$sqg.Dispose(); $sq.Dispose()

$square = [System.Drawing.Image]::FromFile($sqPath) # 256x256 正方形

# ─── 状态角标（32x32）───
$variants = [ordered]@{
  'ok'    = [System.Drawing.Color]::FromArgb(0x1f, 0xaa, 0x59)
  'warn'  = [System.Drawing.Color]::FromArgb(0xf6, 0xa8, 0x00)
  'error' = [System.Drawing.Color]::FromArgb(0xe5, 0x39, 0x35)
  'idle'  = [System.Drawing.Color]::FromArgb(0x9c, 0x98, 0x9a)
}
$size = 32
$dotDiameter = 11
$ringWidth = 2
$dotX = $size - $dotDiameter
$dotY = $size - $dotDiameter

foreach ($name in $variants.Keys) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)
  # 正方形底座原样缩放（不拉伸变形），缩到 28x28 给角标留边
  $g.DrawImage($square, 0, 0, 28, 28)
  $g.FillEllipse([System.Drawing.Brushes]::White, $dotX, $dotY, $dotDiameter, $dotDiameter)
  $brush = New-Object System.Drawing.SolidBrush($variants[$name])
  $g.FillEllipse($brush, $dotX + $ringWidth, $dotY + $ringWidth, $dotDiameter - 2 * $ringWidth, $dotDiameter - 2 * $ringWidth)
  $brush.Dispose()
  $bmp.Save((Join-Path $assets "tray-$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "generated: tray-$name.png"
}

# ─── 应用打包图标（256x256，无角标）───
$appSize = 256
$appBmp = New-Object System.Drawing.Bitmap($appSize, $appSize)
$appG = [System.Drawing.Graphics]::FromImage($appBmp)
$appG.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$appG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$appG.Clear([System.Drawing.Color]::Transparent)
$appG.FillEllipse([System.Drawing.Brushes]::White, 0, 0, $appSize, $appSize)
$appG.DrawImage($square, 8, 8, $appSize - 16, $appSize - 16)
$appBmp.Save((Join-Path $assets 'tray-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$appG.Dispose(); $appBmp.Dispose()
Write-Host "generated: tray-icon.png"

$base.Dispose(); $square.Dispose()
Write-Host "done."
