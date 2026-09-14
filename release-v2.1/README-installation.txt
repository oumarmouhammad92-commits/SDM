# SDM v2.1.0 - Installation Guide
# Sekou Download Manager

## Windows Installer (SDM_Setup.exe)

1. Run `SDM_Setup.exe`
2. Follow the installation wizard
3. SDM will automatically detect installed browsers:
   - Google Chrome
   - Microsoft Edge
   - Brave Browser
   - Opera / Opera GX
   - Vivaldi
   - Arc Browser
   - Chromium
   - Firefox

### Automatic Extension Installation

- **Chrome/Edge/Brave/Opera/Vivaldi/Arc/Chromium**: The extension policy is automatically registered. After installation, open `chrome://extensions` (or equivalent) and enable the SDM extension.
- **Firefox**: The extension is automatically installed in the Firefox distribution directory.

### Manual Extension Installation

#### Chrome / Edge / Brave / Opera / Vivaldi / Arc / Chromium
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`)
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension` folder from the SDM installation directory

#### Firefox
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `extension/manifest.json` from the SDM installation directory

## System Requirements

- Windows 10/11 (64-bit)
- 4 GB RAM minimum
- 100 MB disk space
- Internet connection

## Features

- **32 parallel segments** (adjustable 1-64)
- **Adaptive segment count** based on connection speed (fast: 32, medium: 16, slow: 8→4→1)
- **Auto-resume** after network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED, EPIPE)
- **Keep-Alive** and **HTTP/2** support
- **Pause/Resume** with segment integrity validation
- **HLS (.m3u8)** and **DASH (.mpd)** stream support
- **Browser extension** for automatic download interception
- **Categories**: Video, Audio, Documents, Archives, Images, Applications

## Support

GitHub: https://github.com/oumarmouhammad92-commits/SDM