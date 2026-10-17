<#
    Algoramming Local TCP - Professional Windows Installer
    Registers the hardware bridge with Chrome securely.
#>

# 0. Self-Elevation and Execution Policy Bypass
if (-Not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] 'Administrator')) {
    if ($PSParentPath) {
        $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
        Start-Process -FilePath PowerShell.exe -Verb Runas -ArgumentList $arguments
        Exit
    }
}

$ErrorActionPreference = "Stop"
$HOST_NAME = "com.algoramming.localtcp"
$INSTALL_DIR = "$env:APPDATA\Algoramming\LocalTCP"
$MANIFEST_NAME = "$HOST_NAME.json"

function Ensure-NodeInstalled {
    Write-Host "[WAIT] Detecting Node.js environment..." -ForegroundColor Gray
    $NODE_PATH = (Get-Command node -ErrorAction SilentlyContinue).Source

    if (-not $NODE_PATH) {
        Write-Host "[WARN] Node.js not found. Attempting automatic installation..." -ForegroundColor Yellow
        
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            Write-Host "[INFO] Found Winget. Installing Node.js LTS..." -ForegroundColor Cyan
            winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
            
            if ($LASTEXITCODE -ne 0) {
                throw "Winget failed to install Node.js. Please install it manually from https://nodejs.org/"
            }

            Write-Host "[INFO] Refreshing system path..." -ForegroundColor Gray
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            
            $NODE_PATH = (Get-Command node -ErrorAction SilentlyContinue).Source
            if (-not $NODE_PATH) {
                throw "Node.js installation completed but 'node' is still not found in path. Please restart your computer."
            }
        } else {
            throw "Node.js is missing and 'winget' was not found. Please install Node.js manually: https://nodejs.org/"
        }
    }
    return $NODE_PATH
}

function Save-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $Utf8NoBom = New-Object System.Text.UTF8Encoding $False
    [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

function Run-Installer {
    try {
        Write-Host "----------------------------------------------------" -ForegroundColor Cyan
        Write-Host "Local TCP Bridge - Smart Installer (Windows)" -ForegroundColor Cyan
        Write-Host "----------------------------------------------------" -ForegroundColor Cyan

        # 1. Ensure Node is present
        $NODE_PATH = Ensure-NodeInstalled
        Write-Host "[OK] Using Node at: $NODE_PATH" -ForegroundColor Green

        # 2. Create installation directory
        if (-not (Test-Path $INSTALL_DIR)) {
            Write-Host "[INFO] Creating directory: $INSTALL_DIR" -ForegroundColor Gray
            New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null
        }

        # 3. Copy files
        Write-Host "[INFO] Installing files..." -ForegroundColor Gray
        Copy-Item "$PSScriptRoot\index.js" -Destination "$INSTALL_DIR\index.js" -Force
        Copy-Item "$PSScriptRoot\$MANIFEST_NAME" -Destination "$INSTALL_DIR\$MANIFEST_NAME" -Force
        # USB printing helper, started by index.js on the first USB request.
        Copy-Item "$PSScriptRoot\usb_windows.ps1" -Destination "$INSTALL_DIR\usb_windows.ps1" -Force

        # 4. Create robust .bat launcher
        Write-Host "[INFO] Creating execution launcher..." -ForegroundColor Gray
        $BAT_PATH = "$INSTALL_DIR\run_bridge.bat"
        $BAT_CONTENT = "@echo off`r`n`"$NODE_PATH`" `"%~dp0index.js`" %*"
        Save-Utf8NoBom -Path $BAT_PATH -Content $BAT_CONTENT

        # 5. Register with Chrome
        Write-Host "[INFO] Registering with Chrome..." -ForegroundColor Gray
        $REG_PATH = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HOST_NAME"
        if (-not (Test-Path $REG_PATH)) {
            New-Item -Path $REG_PATH -Force | Out-Null
        }

        # Update the manifest (No BOM is CRITICAL here)
        $MANIFEST_CONTENT = Get-Content "$INSTALL_DIR\$MANIFEST_NAME" -Raw
        $ESCAPED_BAT_PATH = $BAT_PATH.Replace("\", "\\")
        $MANIFEST_CONTENT = $MANIFEST_CONTENT -replace "HOST_PATH", $ESCAPED_BAT_PATH
        Save-Utf8NoBom -Path "$INSTALL_DIR\$MANIFEST_NAME" -Content $MANIFEST_CONTENT

        # Set Registry Key
        Set-ItemProperty -Path $REG_PATH -Name "(default)" -Value "$INSTALL_DIR\$MANIFEST_NAME"

        Write-Host ""
        Write-Host "[SUCCESS] Bridge installed successfully!" -ForegroundColor Green
        Write-Host "----------------------------------------------------"
        Write-Host "1. Please RESTART Chrome completely."
        Write-Host "2. Ensure Extension ID matches: ngbakchodnmhndnghhejmocfadjfekkf"
        Write-Host "3. If ID is different, update manifest JSON accordingly."
        Write-Host "----------------------------------------------------"
        Pause
    }
    catch {
        Write-Host ""
        Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "----------------------------------------------------"
        Write-Host "If issues persist, visit: https://nodejs.org/ to install Node manually."
        Write-Host "----------------------------------------------------"
        Pause
        exit 1
    }
}

Run-Installer
