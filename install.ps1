param(
  [switch]$Uninstall,
  [switch]$DeleteData
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $RootDir ".runtime"
$DataDir = Join-Path $RootDir ".data"
$RuntimeConfig = Join-Path $RuntimeDir "install.json"
$ProgramsDir = [Environment]::GetFolderPath("Programs")
$StartupDir = [Environment]::GetFolderPath("Startup")
$ProgramsShortcut = Join-Path $ProgramsDir "PronoteConnect.lnk"
$StartupShortcut = Join-Path $StartupDir "PronoteConnect.lnk"
$DesktopMain = Join-Path $RootDir "desktop\main.cjs"
$TaskName = "PronoteConnect"
$LogDir = Join-Path $DataDir "logs"
$InstallErrorFile = Join-Path $LogDir "last-install-error.txt"

trap {
  $Message = $_.Exception.Message -replace "[\r\n]+", " "
  try {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    [System.IO.File]::WriteAllText($InstallErrorFile, "$(Get-Date -Format o) $Message`r`n", (New-Object System.Text.UTF8Encoding($false)))
  } catch {
  }
  Write-Host "PronoteConnect n'a pas pu terminer l'installation." -ForegroundColor Red
  Write-Host $Message -ForegroundColor Red
  Write-Host "Diagnostic : $InstallErrorFile"
  exit 1
}

if ($PSVersionTable.PSEdition -eq "Core" -and -not $IsWindows) {
  throw "Utilisez install.sh sur Linux."
}

function Test-Administrator {
  $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
  return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
  $Arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
  if ($Uninstall) { $Arguments += "-Uninstall" }
  if ($DeleteData) { $Arguments += "-DeleteData" }
  $Elevated = Start-Process powershell.exe -Verb RunAs -ArgumentList $Arguments -Wait -PassThru
  exit $Elevated.ExitCode
}

function Get-ConfiguredNode {
  if (Test-Path $RuntimeConfig) {
    try {
      $Config = Get-Content $RuntimeConfig -Raw | ConvertFrom-Json
      if ($Config.nodePath -and (Test-Path $Config.nodePath)) {
        return [string]$Config.nodePath
      }
    } catch {
    }
  }
  $PortableNode = Join-Path $RuntimeDir "node\node.exe"
  if (Test-Path $PortableNode) {
    return $PortableNode
  }
  $Command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($Command) {
    return $Command.Source
  }
  return $null
}

function Stop-PronoteConnect {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $Node = Get-ConfiguredNode
  $Manager = Join-Path $RootDir "scripts\windows-service.cjs"
  if ($Node -and (Test-Path $Manager)) {
    & $Node $Manager stop | Out-Null
  }
  $ServerEntry = Join-Path $RootDir "dist\src\index.js"
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($DesktopMain) -or $_.CommandLine.Contains($ServerEntry)) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Invoke-Checked {
  param(
    [string]$Command,
    [string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "La commande a échoué : $Command"
  }
}

if ($Uninstall) {
  Stop-PronoteConnect
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item $ProgramsShortcut -Force -ErrorAction SilentlyContinue
  Remove-Item $StartupShortcut -Force -ErrorAction SilentlyContinue
  if ($DeleteData -and (Test-Path $DataDir)) {
    Remove-Item $DataDir -Recurse -Force
  }
  Write-Host "PronoteConnect est désinstallé. Le dossier du dépôt est conservé."
  exit 0
}

New-Item -ItemType Directory -Path $RuntimeDir, $DataDir -Force | Out-Null
Stop-PronoteConnect

$NodeCommand = Join-Path $RuntimeDir "node\node.exe"
$NodeMajor = 0
if (Test-Path $NodeCommand) {
  try {
    $NodeMajor = [int](& $NodeCommand -p "Number(process.versions.node.split('.')[0])")
  } catch {
    $NodeMajor = 0
  }
}

if ($NodeMajor -lt 22 -or -not (Test-Path (Join-Path $RuntimeDir "node\npm.cmd"))) {
  $NodeVersion = "v22.23.2"
  $Machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ($Machine -eq "ARM64") {
    $NodeArch = "arm64"
  } elseif ($Machine -eq "AMD64" -or $Machine -eq "x86") {
    $NodeArch = "x64"
  } else {
    throw "Architecture Windows non prise en charge : $Machine"
  }
  $ArchiveName = "node-$NodeVersion-win-$NodeArch.zip"
  $DownloadDir = Join-Path $RuntimeDir "node-download"
  $ArchivePath = Join-Path $DownloadDir $ArchiveName
  $SumsPath = Join-Path $DownloadDir "SHASUMS256.txt"
  New-Item -ItemType Directory -Path $DownloadDir -Force | Out-Null
  Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/$ArchiveName" -OutFile $ArchivePath -UseBasicParsing
  Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" -OutFile $SumsPath -UseBasicParsing
  $SumLine = Get-Content $SumsPath | Where-Object { $_ -match "\s+$([regex]::Escape($ArchiveName))$" } | Select-Object -First 1
  if (-not $SumLine) {
    throw "La somme de contrôle de Node.js est absente."
  }
  $Expected = ($SumLine -split "\s+")[0].ToLowerInvariant()
  $Actual = (Get-FileHash $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Expected -ne $Actual) {
    throw "La vérification de Node.js a échoué."
  }
  $ExtractDir = Join-Path $DownloadDir "extracted"
  $NodeDir = Join-Path $RuntimeDir "node"
  Remove-Item $ExtractDir, $NodeDir -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $ArchivePath -DestinationPath $ExtractDir -Force
  $ExtractedRoot = Get-ChildItem $ExtractDir -Directory | Select-Object -First 1
  if (-not $ExtractedRoot) {
    throw "L'archive Node.js est invalide."
  }
  New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null
  Get-ChildItem $ExtractedRoot.FullName -Force | Move-Item -Destination $NodeDir -Force
  Remove-Item $DownloadDir -Recurse -Force
  $NodeCommand = Join-Path $NodeDir "node.exe"
}

$NodeDirectory = Split-Path -Parent $NodeCommand
$env:Path = "$NodeDirectory;$env:Path"
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $RuntimeDir "browsers"
$NpmCommand = Join-Path $NodeDirectory "npm.cmd"
if (-not (Test-Path $NpmCommand)) {
  $Npm = Get-Command npm.cmd -ErrorAction Stop
  $NpmCommand = $Npm.Source
}

Set-Location $RootDir
Invoke-Checked $NpmCommand @("ci")
Invoke-Checked $NodeCommand @("node_modules\electron\install.js")
Invoke-Checked $NpmCommand @("exec", "--", "playwright", "install", "chromium")
Invoke-Checked $NodeCommand @("scripts\check-browser.mjs")
Invoke-Checked $NodeCommand @("scripts\install-tunnel-client.mjs")
Invoke-Checked $NpmCommand @("run", "verify")

$RuntimeJson = @{ nodePath = $NodeCommand } | ConvertTo-Json
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($RuntimeConfig, $RuntimeJson, $Utf8NoBom)

$ElectronPath = Join-Path $RootDir "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $ElectronPath)) {
  throw "Electron n'a pas été installé."
}

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ProgramsShortcut)
$Shortcut.TargetPath = $ElectronPath
$Shortcut.Arguments = "`"$DesktopMain`" --open"
$Shortcut.WorkingDirectory = $RootDir
$Shortcut.Description = "Ouvrir PronoteConnect"
$Shortcut.Save()

$Startup = $Shell.CreateShortcut($StartupShortcut)
$Startup.TargetPath = $ElectronPath
$Startup.Arguments = "`"$DesktopMain`" --startup"
$Startup.WorkingDirectory = $RootDir
$Startup.Description = "Démarrer PronoteConnect silencieusement"
$Startup.Save()
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Invoke-Checked $NodeCommand @("scripts\windows-service.cjs", "restart")
Start-Process -FilePath $ElectronPath -ArgumentList "`"$DesktopMain`" --startup" -WorkingDirectory $RootDir

$Healthy = $false
for ($Attempt = 0; $Attempt -lt 120; $Attempt++) {
  try {
    $Response = Invoke-WebRequest "http://127.0.0.1:37421/health" -UseBasicParsing -TimeoutSec 1
    if ($Response.StatusCode -eq 200) {
      $Healthy = $true
      break
    }
  } catch {
  }
  Start-Sleep -Milliseconds 250
}
if (-not $Healthy) {
  throw "Le service a démarré mais l'interface locale ne répond pas."
}

Remove-Item $InstallErrorFile -Force -ErrorAction SilentlyContinue
Start-Process "http://127.0.0.1:37421"
Write-Host "PronoteConnect est installé et démarré."
Write-Host "L'interface est disponible sur http://127.0.0.1:37421"
