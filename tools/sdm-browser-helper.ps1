# SDM Browser Helper - Detects installed browsers and installs extensions
# Supports: Chrome, Edge, Brave, Opera, Vivaldi, Arc, Chromium, Firefox

param(
    [string]$ExtensionPath = "",
    [switch]$Silent = $false
)

$ErrorActionPreference = 'Stop'

# Browser registry paths and extension IDs
$Browsers = @(
    @{ Name = "Chrome";  RegPath = "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"; ExtReg = "HKLM:\Software\Google\Chrome\Extensions"; PolicyPath = "HKLM:\Software\Policies\Google\Chrome\ExtensionInstallForcelist" },
    @{ Name = "Edge";    RegPath = "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"; ExtReg = "HKLM:\Software\Microsoft\Edge\Extensions"; PolicyPath = "HKLM:\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist" },
    @{ Name = "Brave";   RegPath = "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\brave.exe"; ExtReg = "HKLM:\Software\BraveSoftware\Brave-Browser\Extensions"; PolicyPath = "HKLM:\Software\Policies\BraveSoftware\Brave-Browser\ExtensionInstallForcelist" },
    @{ Name = "Opera";   RegPath = "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\opera.exe"; ExtReg = "HKLM:\Software\Opera Software\Extensions"; PolicyPath = "HKLM:\Software\Policies\Opera Software\ExtensionInstallForForcelist" },
    @{ Name = "Vivaldi"; RegPath = "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\vivaldi.exe"; ExtReg = "HKLM:\Software\Vivaldi\Extensions"; PolicyPath = "HKLM:\Software\Policies\Vivaldi\ExtensionInstallForcelist" },
    @{ Name = "Arc";     RegPath = "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\arc.exe"; ExtReg = "HKLM:\Software\The Browser Company\Arc\Extensions"; PolicyPath = "HKLM:\Software\Policies\The Browser Company\Arc\ExtensionInstallForcelist" },
    @{ Name = "Chromium"; RegPath = "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\chromium.exe"; ExtReg = "HKLM:\Software\Chromium\Extensions"; PolicyPath = "HKLM:\Software\Policies\Chromium\ExtensionInstallForcelist" }
)

$FirefoxPath = "HKLM:\Software\Mozilla\Mozilla Firefox"
$SDM_ExtensionID = "sdm-extension@sekou-download-manager"
$SDM_ExtensionPath = if ($ExtensionPath) { $ExtensionPath } else { Join-Path $PSScriptRoot "..\extension" }

function Test-BrowserInstalled {
    param($Browser)
    try {
        $reg = Get-ItemProperty -Path $Browser.RegPath -ErrorAction SilentlyContinue
        if ($reg) { return $true }
        $paths = @(
            "$env:ProgramFiles\$($Browser.Name)\Application\$($Browser.Name.ToLower()).exe",
            "$env:LOCALAPPDATA\$($Browser.Name)\Application\$($Browser.Name.ToLower()).exe",
            "$env:ProgramFiles (x86)\$($Browser.Name)\Application\$($Browser.Name.ToLower()).exe"
        )
        foreach ($p in $paths) {
            if (Test-Path $p) { return $true }
        }
    } catch { return $false }
    return $false
}

function Install-ChromeExtension {
    param($Browser)
    try {
        $extID = $SDM_ExtensionID
        $extPath = $SDM_ExtensionPath -replace '\\', '\\'
        $regPath = "$($Browser.PolicyPath)"
        if (!(Test-Path $regPath)) {
            New-Item -Path $regPath -Force | Out-Null
        }
        $value = "$extID;$extPath"
        Set-ItemProperty -Path $regPath -Name "sdm" -Value $value -Type String -Force
        return $true
    } catch { return $false }
}

function Install-FirefoxExtension {
    try {
        $firefoxDirs = @(
            "$env:ProgramFiles\Mozilla Firefox",
            "$env:ProgramFiles (x86)\Mozilla Firefox",
            "$env:LOCALAPPDATA\Mozilla Firefox"
        )
        foreach ($dir in $firefoxDirs) {
            if (Test-Path $dir) {
                $extensionsDir = Join-Path $dir "distribution\extensions"
                if (!(Test-Path $extensionsDir)) {
                    New-Item -ItemType Directory -Path $extensionsDir -Force | Out-Null
                }
                $dest = Join-Path $extensionsDir "$SDM_ExtensionID.xpi"
                # Copy extension as XPI (zip)
                if (Test-Path $SDM_ExtensionPath) {
                    Compress-Archive -Path "$SDM_ExtensionPath\*" -DestinationPath $dest -Force
                    return $true
                }
            }
        }
    } catch { return $false }
    return $false
}

Write-Host "SDM Browser Extension Installer v1.2.0"
Write-Host "====================================="

$installed = 0
$opened = @()

foreach ($browser in $Browsers) {
    if (Test-BrowserInstalled $browser) {
        Write-Host "Found: $($browser.Name)"
        $result = Install-ChromeExtension $browser
        if ($result) {
            Write-Host "  -> Extension policy installed for $($browser.Name)"
            $installed++
            # Open confirmation page for browsers that require it
            if ($browser.Name -in @("Chrome", "Edge", "Brave")) {
                $opened += $browser.Name
            }
        } else {
            Write-Host "  -> Could not install extension policy for $($browser.Name)"
        }
    }
}

# Firefox
try {
    $ff = Get-ItemProperty -Path $FirefoxPath -ErrorAction SilentlyContinue
    if ($ff) {
        Write-Host "Found: Firefox"
        $result = Install-FirefoxExtension
        if ($result) {
            Write-Host "  -> Extension installed for Firefox"
            $installed++
        }
    }
} catch { Write-Host "Firefox not found" }

Write-Host ""
Write-Host "Summary: Extension installed for $installed browser(s)"

if ($opened.Count -gt 0) {
    Write-Host "Opening confirmation pages for: $($opened -join ', ')"
    foreach ($browser in $opened) {
        try {
            $url = "chrome://extensions"
            if ($browser -eq "Edge") { $url = "edge://extensions" }
            if ($browser -eq "Brave") { $url = "brave://extensions" }
            Start-Process $url
            Start-Sleep -Milliseconds 500
        } catch { }
    }
}

Write-Host "Done."
