; SDM Installer Custom Pages - Browser Detection & Extension Installation
; SDM v1.2.0 - Compatible Chrome, Edge, Brave, Opera, Vivaldi, Arc, Chromium, Firefox

!macro SDM_BrowserInstall
    DetailPrint "SDM: Detecting installed browsers..."
    
    ; Chrome
    ClearErrors
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" ""
    IfErrors 0 +2
    DetailPrint "  Chrome: not found"
    IfErrors +2 0
    DetailPrint "  Chrome: found - installing extension policy"
    
    ; Edge
    ClearErrors
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" ""
    IfErrors 0 +2
    DetailPrint "  Edge: not found"
    IfErrors +2 0
    DetailPrint "  Edge: found - installing extension policy"
    
    ; Brave
    ClearErrors
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\brave.exe" ""
    IfErrors 0 +2
    DetailPrint "  Brave: not found"
    IfErrors +2 0
    DetailPrint "  Brave: found - installing extension policy"
    
    ; Opera
    ClearErrors
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\opera.exe" ""
    IfErrors 0 +2
    DetailPrint "  Opera: not found"
    IfErrors +2 0
    DetailPrint "  Opera: found - installing extension policy"
    
    ; Vivaldi
    ClearErrors
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\vivaldi.exe" ""
    IfErrors 0 +2
    DetailPrint "  Vivaldi: not found"
    IfErrors +2 0
    DetailPrint "  Vivaldi: found - installing extension policy"
    
    ; Arc
    ClearErrors
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\arc.exe" ""
    IfErrors 0 +2
    DetailPrint "  Arc: not found"
    IfErrors +2 0
    DetailPrint "  Arc: found - installing extension policy"
    
    ; Chromium
    ClearErrors
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\chromium.exe" ""
    IfErrors 0 +2
    DetailPrint "  Chromium: not found"
    IfErrors +2 0
    DetailPrint "  Chromium: found - installing extension policy"
    
    ; Firefox
    ClearErrors
    ReadRegStr $0 HKLM "Software\Mozilla\Mozilla Firefox" "CurrentVersion"
    IfErrors 0 +2
    DetailPrint "  Firefox: not found"
    IfErrors +2 0
    DetailPrint "  Firefox: found - installing extension"
    
    DetailPrint "SDM: Browser detection complete."
!macroend

!macro SDM_OpenBrowserPages
    DetailPrint "SDM: Opening extension confirmation pages..."
    
    ; Open Chrome extensions page
    ClearErrors
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" ""
    IfErrors +3 0
    ExecShell "open" "chrome://extensions"
    Sleep 500
    
    ; Open Edge extensions page
    ClearErrors
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" ""
    IfErrors +3 0
    ExecShell "open" "edge://extensions"
    Sleep 500
    
    ; Open Brave extensions page
    ClearErrors
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\App Paths\brave.exe" ""
    IfErrors +3 0
    ExecShell "open" "brave://extensions"
    Sleep 500
    
    DetailPrint "SDM: Confirmation pages opened."
!macroend
