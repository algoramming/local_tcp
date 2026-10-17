<#
    Algoramming Local TCP - Professional Windows Uninstaller
    Removes the hardware bridge and Chrome registration.
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
$REG_PATH = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HOST_NAME"

function Run-Uninstaller {
    try {
        Write-Host "----------------------------------------------------" -ForegroundColor Yellow
        Write-Host "Local TCP Bridge - Uninstaller (Windows)" -ForegroundColor Yellow
        Write-Host "----------------------------------------------------" -ForegroundColor Yellow

        # 1. Remove Registry Key
        if (Test-Path $REG_PATH) {
            Write-Host "[INFO] Removing Chrome registration..." -ForegroundColor Gray
            Remove-Item -Path $REG_PATH -Force
            Write-Host "[OK] Chrome registration removed." -ForegroundColor Green
        } else {
            Write-Host "[INFO] Chrome registration not found. Skipping." -ForegroundColor Gray
        }

        # 2. Stop a running USB helper: it can hold its compiled DLL open, which
        #    would stop the folder from being deleted. Only processes running
        #    our own helper script are touched.
        $helperScript = (Join-Path $INSTALL_DIR "usb_windows.ps1").ToLower()
        Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($helperScript) } |
            ForEach-Object {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
                Write-Host "[OK] Stopped the running USB helper (PID $($_.ProcessId))." -ForegroundColor Green
            }
        Start-Sleep -Milliseconds 500

        # 3. Remove Files
        if (Test-Path $INSTALL_DIR) {
            Write-Host "[INFO] Removing bridge files..." -ForegroundColor Gray
            Remove-Item -Path $INSTALL_DIR -Recurse -Force
            Write-Host "[OK] Bridge files removed." -ForegroundColor Green
        } else {
            Write-Host "[INFO] Installation directory not found. Skipping." -ForegroundColor Gray
        }

        Write-Host ""
        Write-Host "Done. The bridge has been completely removed." -ForegroundColor Cyan
        Write-Host "----------------------------------------------------"
        Pause
    }
    catch {
        Write-Host ""
        Write-Host "[ERROR] during uninstallation: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "----------------------------------------------------"
        Write-Host "If you hit permission issues, try running PowerShell as Administrator."
        Write-Host "----------------------------------------------------"
        Pause
        exit 1
    }
}

Run-Uninstaller
