$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$baseUrl = 'http://127.0.0.1:4310'
$serverPath = Join-Path $projectRoot 'server\index.mjs'
$dataPath = Join-Path $projectRoot 'data'
$lockTaken = $false
$launcherMutex = $null
$launchClock = [System.Diagnostics.Stopwatch]::StartNew()

function Get-AvanaHealth {
    try {
        $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 1 -ErrorAction Stop
        if ($health.ok -eq $true -and $health.app -ceq 'avana') { return 'ready' }
        return 'occupied'
    } catch {
        if ($null -ne $_.Exception.Response) { return 'occupied' }
        return 'offline'
    }
}

function Show-LaunchError([string]$message) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        $message, 'Avana',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
}

try {
    # Serializa cliques repetidos sem encerrar processos que usam a mesma porta.
    $launcherMutex = [System.Threading.Mutex]::new($false, 'Local\Avana.Local4310.Launcher')
    try {
        $lockTaken = $launcherMutex.WaitOne(20000)
    } catch [System.Threading.AbandonedMutexException] {
        $lockTaken = $true
    }
    if (-not $lockTaken) { throw 'O Avana ainda está iniciando. Aguarde alguns segundos e tente novamente.' }

    $healthStatus = Get-AvanaHealth
    if ($healthStatus -eq 'occupied') {
        throw 'A porta 4310 está sendo usada por outro serviço. Libere essa porta antes de abrir o Avana.'
    }
    if ($healthStatus -ne 'ready') {
        if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
            throw "Não foi encontrado o servidor em $serverPath. Restaure os arquivos do projeto."
        }
        if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html') -PathType Leaf)) {
            throw "A interface ainda não foi compilada. Abra um terminal em $projectRoot e execute npm install e npm run build."
        }
        $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
        if ($null -eq $nodeCommand) { throw 'Instale Node.js 24.14 ou superior e reabra o Avana.' }
        $nodePath = $nodeCommand.Source
        $versionText = (& $nodePath --version).Trim().TrimStart('v')
        if ([version]$versionText -lt [version]'24.14.0') {
            throw "Node.js $versionText encontrado. O Avana requer Node.js 24.14 ou superior."
        }
        [System.IO.Directory]::CreateDirectory($dataPath) | Out-Null
        $runStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $stdoutPath = Join-Path $dataPath "server-$runStamp.log"
        $stderrPath = Join-Path $dataPath "server-$runStamp.error.log"
        $serverProcess = Start-Process -FilePath $nodePath -ArgumentList @('"' + $serverPath + '"') `
            -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        do {
            $healthStatus = Get-AvanaHealth
            if ($healthStatus -eq 'ready') { break }
            if ($healthStatus -eq 'occupied') {
                throw "Outro serviço respondeu na porta 4310. Consulte os registros em $dataPath."
            }
            if ($serverProcess.HasExited) {
                throw "O servidor não conseguiu iniciar. Consulte $stderrPath."
            }
            Start-Sleep -Milliseconds 300
        } while ($launchClock.Elapsed.TotalSeconds -lt 20)
        if ($healthStatus -ne 'ready') {
            throw "O Avana não respondeu em 20 segundos. Consulte os registros em $dataPath e tente novamente."
        }
    }

    # A única janela aberta é o navegador escolhido pelo usuário.
    Start-Process -FilePath $baseUrl
} catch {
    Show-LaunchError $_.Exception.Message
    exit 1
} finally {
    if ($lockTaken) { $launcherMutex.ReleaseMutex() }
    if ($null -ne $launcherMutex) { $launcherMutex.Dispose() }
}
