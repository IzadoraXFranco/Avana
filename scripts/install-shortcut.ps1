$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcherPath = Join-Path $projectRoot 'scripts\launch.ps1'
$iconPath = Join-Path $projectRoot 'public\avana.ico'
$desktopPath = [System.Environment]::GetFolderPath('Desktop')

if ([string]::IsNullOrWhiteSpace($desktopPath)) { throw 'Não foi possível localizar a área de trabalho deste usuário.' }
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) { throw "Launcher ausente: $launcherPath" }
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) { throw "Ícone ausente: $iconPath" }

$shortcutPath = Join-Path $desktopPath 'Avana.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $null
try {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '"'
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.IconLocation = "$iconPath,0"
    $shortcut.Description = 'Avana — seu trabalho, com clareza.'
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    Write-Output "Atalho criado em $shortcutPath"
} finally {
    if ($null -ne $shortcut) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) }
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}
