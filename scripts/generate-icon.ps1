$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputPath = Join-Path $projectRoot 'public\avana.ico'
[System.IO.Directory]::CreateDirectory((Split-Path -Parent $outputPath)) | Out-Null

function New-RoundedRectangle([single]$x, [single]$y, [single]$width, [single]$height, [single]$radius) {
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = 2 * $radius
    $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
    $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
    $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return ,$path
}

$entries = [System.Collections.Generic.List[object]]::new()
foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $resources = [System.Collections.Generic.List[System.IDisposable]]::new()
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.ScaleTransform($size / 256.0, $size / 256.0)
        $background = New-RoundedRectangle 1 1 254 254 58
        $resources.Add($background)
        $gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
            [System.Drawing.Rectangle]::new(0, 0, 256, 256),
            [System.Drawing.ColorTranslator]::FromHtml('#63398a'),
            [System.Drawing.ColorTranslator]::FromHtml('#301541'),
            [single]45
        )
        $resources.Add($gradient)
        $graphics.FillPath($gradient, $background)
        $rim = New-RoundedRectangle 9 9 238 238 51
        $resources.Add($rim)
        $rimPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(56, 200, 154, 240), 2)
        $resources.Add($rimPen)
        $graphics.DrawPath($rimPen, $rim)
        $letter = [System.Drawing.Drawing2D.GraphicsPath]::new()
        $resources.Add($letter)
        $letter.AddLine(68, 183, 119, 76)
        $letter.AddBezier(119, 76, 125, 63.3, 131, 63.3, 137, 76)
        $letter.AddLine(137, 76, 188, 183)
        $letterPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#f1e4ff'), 19)
        $resources.Add($letterPen)
        $letterPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $letterPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $letterPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $graphics.DrawPath($letterPen, $letter)
        $crossbarPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#bb89ed'), 17)
        $resources.Add($crossbarPen)
        $crossbarPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $crossbarPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $graphics.DrawLine($crossbarPen, 91, 137, 165, 137)
        $starBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#d9bcf5'))
        $resources.Add($starBrush)
        $star = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(191, 48), [System.Drawing.PointF]::new(195, 58),
            [System.Drawing.PointF]::new(205, 62), [System.Drawing.PointF]::new(195, 66),
            [System.Drawing.PointF]::new(191, 76), [System.Drawing.PointF]::new(187, 66),
            [System.Drawing.PointF]::new(177, 62), [System.Drawing.PointF]::new(187, 58)
        )
        $graphics.FillPolygon($starBrush, $star)
        # DIB de 32 bits preserva o alfa e funciona também nos leitores de ícone do Windows/.NET.
        $dib = [System.IO.MemoryStream]::new()
        $dibWriter = [System.IO.BinaryWriter]::new($dib)
        try {
            $maskStride = [int]([System.Math]::Ceiling($size / 32.0) * 4)
            $mask = [byte[]]::new($maskStride * $size)
            $dibWriter.Write([uint32]40)
            $dibWriter.Write([int32]$size)
            $dibWriter.Write([int32]($size * 2))
            $dibWriter.Write([uint16]1)
            $dibWriter.Write([uint16]32)
            $dibWriter.Write([uint32]0)
            $dibWriter.Write([uint32](($size * $size * 4) + $mask.Length))
            $dibWriter.Write([int32]0)
            $dibWriter.Write([int32]0)
            $dibWriter.Write([uint32]0)
            $dibWriter.Write([uint32]0)
            for ($row = 0; $row -lt $size; $row++) {
                for ($x = 0; $x -lt $size; $x++) {
                    $pixel = $bitmap.GetPixel($x, $size - 1 - $row)
                    $dibWriter.Write([byte]$pixel.B)
                    $dibWriter.Write([byte]$pixel.G)
                    $dibWriter.Write([byte]$pixel.R)
                    $dibWriter.Write([byte]$pixel.A)
                    if ($pixel.A -eq 0) {
                        $maskIndex = $row * $maskStride + [int][System.Math]::Floor($x / 8.0)
                        $mask[$maskIndex] = $mask[$maskIndex] -bor (128 -shr ($x % 8))
                    }
                }
            }
            $dibWriter.Write($mask)
            $dibWriter.Flush()
            $entries.Add(@{ Size = $size; Bytes = $dib.ToArray() })
        } finally {
            $dibWriter.Dispose()
            $dib.Dispose()
        }
    } finally {
        foreach ($resource in $resources) { $resource.Dispose() }
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

$file = [System.IO.File]::Open($outputPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = [System.IO.BinaryWriter]::new($file)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$entries.Count)
    $offset = 6 + 16 * $entries.Count
    foreach ($entry in $entries) {
        $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
        $writer.Write([byte]$dimension)
        $writer.Write([byte]$dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$entry.Bytes.Length)
        $writer.Write([uint32]$offset)
        $offset += $entry.Bytes.Length
    }
    foreach ($entry in $entries) { $writer.Write([byte[]]$entry.Bytes) }
} finally {
    $writer.Dispose()
    $file.Dispose()
}
Write-Output "Ícone criado em $outputPath"
