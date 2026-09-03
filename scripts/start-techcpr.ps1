$ErrorActionPreference = "Continue"

$ProjectPath = "C:\Users\Justin\Desktop\TechCPR-WiFi-Portal"
$Node = "C:\Program Files\nodejs\node.exe"
$LogDirectory = Join-Path $ProjectPath "logs"
$StartupLog = Join-Path $LogDirectory "startup-task.log"

Set-Location $ProjectPath

if (-not (Test-Path $LogDirectory)) {
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
}

function Write-StartupLog {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$timestamp $Message" | Out-File -FilePath $StartupLog -Append -Encoding utf8
}

Write-StartupLog "=============================================="
Write-StartupLog "TechCPR supervisor starting."

while ($true) {
    Write-StartupLog "Running RouterOS compatibility patch."
    & $Node ".\scripts\patch-node-routeros.js" *>> $StartupLog

    if ($LASTEXITCODE -ne 0) {
        Write-StartupLog "RouterOS patch failed. Retrying in 30 seconds."
        Start-Sleep -Seconds 30
        continue
    }

    Write-StartupLog "Running TechCPR preflight."
    & $Node ".\scripts\preflight.js" *>> $StartupLog

    if ($LASTEXITCODE -ne 0) {
        Write-StartupLog "Preflight failed. Retrying in 30 seconds."
        Start-Sleep -Seconds 30
        continue
    }

    Write-StartupLog "Starting TechCPR server."
    & $Node ".\server.js" *>> $StartupLog

    Write-StartupLog "TechCPR server exited with code $LASTEXITCODE."
    Write-StartupLog "Restarting in 10 seconds."
    Start-Sleep -Seconds 10
}
