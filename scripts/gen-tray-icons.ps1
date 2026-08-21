#requires -Version 7
<#
  gen-tray-icons.ps1 — 生成托盘状态角标图标（ollama-tray）
  基于 assets/ollama-icon.png（官网羊驼图标），生成：
  - 4 个 32x32 状态角标：tray-ok / tray-warn / tray-error / tray-idle
  - 1 个 256x256 应用打包图标：tray-icon.png
  用法：pwsh scripts/gen-tray-icons.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
Add-Type -AssemblyName System.Drawing

$base = [System.Drawing.Image]::FromFile((Join-Path $assets 'ollama-icon.png'))

# 状态 → 圆点颜色（与 popup.css 语义色一致）
$variants = [ordered]@{
  'ok'    = [System.Drawing.Color]::FromArgb(0x1f, 0xaa, 0x59)  # 绿：正常
  'warn'  = [System.Drawing.Color]::FromArgb(0xf6, 0xa8, 0x00)  # 橙：紧张（weekly >=70）
  'error' = [System.Drawing.Color]::FromArgb(0xe5, 0x39, 0x35)  # 红：即将用尽（weekly >=90）
  'idle'  = [System.Drawing.Color]::FromArgb(0x9c, 0x98, 0x9a)  # 灰：无数据/取数失败
}

$size = 32
$dotDiameter = 13
$ringWidth = 2.5

foreach ($name in $variants.Keys) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($base, 0, 0, $size - 4, $size - 4)

  $dotX = $size - $dotDiameter
  $dotY = $size - $dotDiameter
  $g.FillEllipse([System.Drawing.Brushes]::White, $dotX, $dotY, $dotDiameter, $dotDiameter)
  $brush = New-Object System.Drawing.SolidBrush($variants[$name])
  $g.FillEllipse($brush, $dotX + $ringWidth, $dotY + $ringWidth, $dotDiameter - 2 * $ringWidth, $dotDiameter - 2 * $ringWidth)
  $brush.Dispose()

  $out = Join-Path $assets "tray-$name.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "generated: $out"
}

# ─── 应用打包图标（256x256，无角标）───
$appSize = 256
$appBmp = New-Object System.Drawing.Bitmap($appSize, $appSize)
$appG = [System.Drawing.Graphics]::FromImage($appBmp)
$appG.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$appG.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$appG.Clear([System.Drawing.Color]::Transparent)
$appG.FillEllipse([System.Drawing.Brushes]::White, 0, 0, $appSize, $appSize)
$appG.DrawImage($base, 6, 6, $appSize - 12, $appSize - 12)
$appOut = Join-Path $assets 'tray-icon.png'
$appBmp.Save($appOut, [System.Drawing.Imaging.ImageFormat]::Png)
$appG.Dispose(); $appBmp.Dispose()
Write-Host "generated: $appOut"

$base.Dispose()
Write-Host "done."
