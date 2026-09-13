// ============================================================================
// SDM - Sekou Download Manager
// Pont sécurisé entre le processus principal (main.js) et l'interface (renderer)
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sdm', {
  // Actions de téléchargement
  startDownload: (url) => ipcRenderer.invoke('downloads:start', url),
  pauseDownload: (id) => ipcRenderer.invoke('downloads:pause', id),
  resumeDownload: (id) => ipcRenderer.invoke('downloads:resume', id),
  removeDownload: (id) => ipcRenderer.invoke('downloads:remove', id),
  listDownloads: () => ipcRenderer.invoke('downloads:list'),
  openFolder: (id) => ipcRenderer.invoke('downloads:open-folder', id),

  // Dossier de sauvegarde
  chooseDirectory: () => ipcRenderer.invoke('downloads:choose-dir'),
  getDownloadDirectory: () => ipcRenderer.invoke('downloads:get-dir'),

  // Serveur local & extension navigateur
  getServerStatus: () => ipcRenderer.invoke('server:get-status'),
  getExtensionDir: () => ipcRenderer.invoke('server:get-extension-dir'),
  openExtensionFolder: () => ipcRenderer.invoke('server:open-extension'),

  // Événements entrants (progression / changement d'état / suppression)
  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('download:progress', handler);
    return () => ipcRenderer.removeListener('download:progress', handler);
  },
  onStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('download:status', handler);
    return () => ipcRenderer.removeListener('download:status', handler);
  },
  onRemoved: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('download:removed', handler);
    return () => ipcRenderer.removeListener('download:removed', handler);
  },
  onServerStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('server:status', handler);
    return () => ipcRenderer.removeListener('server:status', handler);
  },
});