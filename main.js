// ============================================================================
// SDM - Sekou Download Manager
// Processus principal : fenêtre Electron + serveur local (extension navigateur)
// + pont IPC vers le moteur de téléchargement multi-connexions
// ============================================================================

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const engine = require('./download-engine');
const { startServer, DEFAULT_PORT } = require('./local-server');

// Chemin du dossier d'extension : en mode packagé, l'extension est copiée
// hors de l'archive asar via extraResources (Chrome ne peut pas charger
// une extension depuis l'intérieur d'un fichier .asar).
function getExtensionDir() {
  try {
    if (app.isPackaged && process.resourcesPath) {
      return path.join(process.resourcesPath, 'extension');
    }
  } catch (_) { /* ignoré */ }
  return path.join(__dirname, 'extension');
}

function getAppIcon() {
  // .ico sous Windows packagé, .png sinon (dev / autres OS).
  // En mode packagé, __dirname pointe dans app.asar : l'icône reste lisible
  // par Electron depuis l'archive, mais on préfère la ressource dépaquetée
  // si electron-builder l'a extraite (asarUnpack).
  const candidates = [];
  try {
    if (app.isPackaged && process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'app-icon.ico'));
    }
  } catch (_) { /* ignoré */ }
  candidates.push(path.join(__dirname, 'assets', 'app-icon.ico'));
  candidates.push(path.join(__dirname, 'assets', 'app-icon.png'));
  try {
    if (process.platform === 'win32') {
      for (const p of candidates) {
        if (p.endsWith('.ico') && fs.existsSync(p)) return p;
      }
    }
  } catch (_) { /* ignoré */ }
  return candidates[candidates.length - 1];
}

let mainWindow = null;
let serverStatus = { running: false, port: DEFAULT_PORT, bindError: '' };

// ---------------- Fenêtre principale ----------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 600,
    title: 'SDM - Sekou Download Manager',
    backgroundColor: '#0b1220',
    icon: getAppIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------- Pont d'événements du moteur vers l'interface ----------------

engine.setEventSink((type, payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (type === 'progress') {
    mainWindow.webContents.send('download:progress', payload);
  } else if (type === 'removed') {
    mainWindow.webContents.send('download:removed', payload);
  } else {
    mainWindow.webContents.send('download:status', payload);
  }
});

// ---------------- Serveur HTTP local (récupère les liens de l'extension) ----------------

function startLocalServer() {
  startServer(engine, {
    port: DEFAULT_PORT,
    onStatus: (running, info) => {
      serverStatus = {
        running,
        port: running ? info : DEFAULT_PORT,
        bindError: running ? '' : String(info || ''),
      };
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('server:status', serverStatus);
      }
    },
  });
}

// (Le moteur de téléchargement multi-connexions réside dans download-engine.js :
//  sondage HTTP, segments 8-32, pause/reprise, méta-données, catégories.)

// ---------------- Canaux IPC (pont sécurisé via preload.js) ----------------

function setupIpc() {
  ipcMain.handle('downloads:start', (_e, url) => {
    if (engine.isHlsUrl(url)) return engine.startHlsDownload(url, {});
    return engine.startDownload(url, {});
  });
  ipcMain.handle('downloads:pause', (_e, id) => engine.pauseDownload(id));
  ipcMain.handle('downloads:resume', (_e, id) => engine.resumeDownload(id));
  ipcMain.handle('downloads:remove', (_e, id) => engine.removeDownload(id));
  ipcMain.handle('downloads:list', () => engine.listDownloads());

  ipcMain.handle('downloads:get-dir', () => engine.getDownloadDir());
  ipcMain.handle('downloads:choose-dir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choisir le dossier de téléchargement',
      defaultPath: engine.getDownloadDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths.length) {
      return { ok: false, canceled: true, dir: engine.getDownloadDir() };
    }
    engine.setDownloadDir(result.filePaths[0]);
    return { ok: true, dir: engine.getDownloadDir() };
  });

  ipcMain.handle('downloads:open-folder', (_e, id) => {
    const dl = engine.listDownloads().find((d) => d.id === id);
    if (!dl) return { ok: false };
    try {
      if (dl.status === 'completed' && dl.savePath) {
        shell.showItemInFolder(dl.savePath);
      } else if (dl.savePath) {
        shell.openPath(path.dirname(dl.savePath));
      } else {
        shell.openPath(engine.getDownloadDir());
      }
    } catch (_) { /* ignoré */ }
    return { ok: true };
  });

  // État du serveur local + chemin du dossier d'extension (pour l'aide de l'UI)
  ipcMain.handle('server:get-status', () => serverStatus);
  ipcMain.handle('server:get-extension-dir', () => getExtensionDir());
  ipcMain.handle('server:open-extension', async () => {
    const err = await shell.openPath(getExtensionDir());
    return { ok: !err };
  });
}

// ---------------- Cycle de vie de l'application ----------------

app.whenReady().then(() => {
  engine.setDownloadsBase(app.getPath('downloads'));
  setupIpc();
  engine.scanPendingDownloads(); // restaure les téléchargements interrompus
  engine.cleanupTempFiles();
  createWindow();
  startLocalServer();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try {
    for (const dl of engine.listDownloads()) {
      if (dl.status === 'downloading') engine.pauseDownload(dl.id);
    }
  } catch (_) { /* ignoré */ }
});