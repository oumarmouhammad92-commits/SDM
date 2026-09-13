// ============================================================================
// SDM - Sekou Download Manager — extension (background service worker)
// Compatible Chrome, Edge, Brave (Manifest V3) et Firefox (WebExtensions API)
//
// Rôle :
//  - Détecte les téléchargements du navigateur -> « Télécharger avec SDM ? »
//  - Envoie les liens (fichiers, médias, vidéos HLS) à l'application SDM
//    via le serveur local http://127.0.0.1:26545
//  - Menu contextuel : "Télécharger avec SDM"
// ============================================================================

'use strict';

const api = (typeof browser !== 'undefined') ? browser : chrome;

const DEFAULTS = {
  host: 'http://127.0.0.1:26545',
  interceptDownloads: true,   // notification "Télécharger avec SDM ?" sur chaque téléchargement
  detectLinks: true,          // bouton SDM à côté des liens de fichiers sur les pages
  detectVideo: false,         // détection vidéo (HLS / direct) — à activer si légalement autorisé
  connections: 0,             // 0 = automatique (8 à 32 segments), sinon 8 | 16 | 32
};

let settings = Object.assign({}, DEFAULTS);
const pendingButtons = new Map(); // notifId -> { downloadId, url }

// ---------------- Stockage (config + historique) ----------------

async function loadSettings() {
  try {
    const data = await api.storage.local.get('sdm_settings');
    settings = Object.assign({}, DEFAULTS, (data && data.sdm_settings) || {});
  } catch (_) { /* valeurs par défaut */ }
}

async function saveSettings(partial) {
  settings = Object.assign({}, settings, partial);
  await api.storage.local.set({ sdm_settings: settings });
}

async function loadHistory() {
  try {
    const data = await api.storage.local.get('sdm_history');
    return (data && data.sdm_history) || [];
  } catch (_) { return []; }
}

async function addHistory(entry) {
  try {
    const history = await loadHistory();
    history.unshift(entry);
    await api.storage.local.set({ sdm_history: history.slice(0, 20) });
  } catch (_) { /* ignoré */ }
}

async function markSent(url) {
  try {
    const history = await loadHistory();
    history.forEach((h) => { if (h.url === url) h.sent = true; });
    await api.storage.local.set({ sdm_history: history });
  } catch (_) { /* ignoré */ }
}

// ---------------- Détection automatique des téléchargements ----------------

function fileNameFromUrl(url) {
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean).pop();
    return p ? decodeURIComponent(p) : url;
  } catch (_) { return url; }
}

// 1) Quand le navigateur démarre un téléchargement -> « Télécharger avec SDM ? »
api.downloads.onCreated.addListener(async (item) => {
  if (!settings.interceptDownloads) return;
  if (item.byExtensionId) return;          // pas les téléchargements d'extensions
  const url = item.url || '';
  if (!/^https?:/i.test(url)) return;      // ignore blob:, data:, file:

  const downloadId = item.id;
  const filename = item.filename || fileNameFromUrl(url);

  await addHistory({ id: downloadId, url, filename, time: Date.now(), sent: false });

  const notifId = 'sdm-dl-' + downloadId;
  pendingButtons.set(notifId, { downloadId, url });
  try {
    api.notifications.create(notifId, {
      type: 'basic',
      iconUrl: api.runtime.getURL('icons/icon128.png'),
      title: 'Télécharger avec SDM ?',
      message: filename,
      buttons: [
        { title: 'Oui, avec SDM' },
        { title: 'Non, continuer' },
      ],
    });
  } catch (_) { /* notifications indisponibles */ }
});

// Bouton de notification : [Oui]=annule le téléchargement navigateur puis -> SDM
api.notifications.onButtonClicked.addListener((notifId, index) => {
  const pending = pendingButtons.get(notifId);
  if (!pending) return;
  pendingButtons.delete(notifId);
  api.notifications.clear(notifId);

  if (index === 0) {
    try { api.downloads.cancel(pending.downloadId); } catch (_) { /* ignoré */ }
    try { api.downloads.erase({ id: pending.downloadId }); } catch (_) { /* ignoré */ }
    try { api.downloads.removeFile(pending.downloadId); } catch (_) { /* ignoré */ }
    sendToSDM(pending.url, settings.connections).catch(() => {});
  }
  // index 1 : on laisse le téléchargement natif se poursuivre
});

// Clic sur la notification (si les boutons ne sont pas affichés) -> envoyer à SDM
api.notifications.onClicked.addListener((notifId) => {
  const pending = pendingButtons.get(notifId);
  if (!pending) return;
  pendingButtons.delete(notifId);
  api.notifications.clear(notifId);
  sendToSDM(pending.url, settings.connections).catch(() => {});
});

// ---------------- Menu contextuel (clic droit) ----------------

function createContextMenus() {
  const created = [
    api.contextMenus.create({
      id: 'sdm-link',
      title: 'Télécharger ce lien avec SDM',
      contexts: ['link'],
    }),
    api.contextMenus.create({
      id: 'sdm-media',
      title: 'Télécharger ce média avec SDM',
      contexts: ['video', 'audio', 'image'],
    }),
    api.contextMenus.create({
      id: 'sdm-page',
      title: 'Télécharger cette page avec SDM',
      contexts: ['page'],
    }),
  ];
  created.forEach((item) => {
    if (item && typeof item.catch === 'function') item.catch(() => {});
  });
}

api.contextMenus.onClicked.addListener((info) => {
  const url = info.linkUrl || info.srcUrl || info.pageUrl;
  if (url && /^https?:/i.test(url)) {
    sendToSDM(url, settings.connections).catch(() => {});
  }
});

// ---------------- Messages venant des scripts de contenu et de la popup ----------------

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'download') {
    sendToSDM(msg.url, msg.connections || settings.connections)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // réponse asynchrone
  }

  if (msg.type === 'health') {
    checkHealth()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'getSettings') {
    sendResponse({ settings });
    return false;
  }

  if (msg.type === 'getHistory') {
    loadHistory().then((history) => sendResponse({ history }));
    return true;
  }

  if (msg.type === 'saveSettings') {
    saveSettings(msg.settings || {})
      .then(() => sendResponse({ ok: true, settings }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});

// ---------------- Initialisation ----------------

(async function init() {
  await loadSettings();

  const rm = api.contextMenus.removeAll();
  if (rm && typeof rm.then === 'function') {
    rm.then(createContextMenus).catch(() => createContextMenus());
  } else {
    createContextMenus();
  }
})();

// ---------------- Communication avec l'application SDM ----------------

async function checkHealth() {
  const res = await fetch(settings.host + '/api/health', { method: 'GET' });
  const data = await res.json().catch(() => ({}));
  return { ok: !!(res.ok && data.ok), name: data.name || 'SDM', version: data.version || '' };
}

async function sendToSDM(url, connections) {
  if (!/^https?:\/\//i.test(String(url))) {
    throw new Error('Seules les adresses http/https peuvent être envoyées à SDM');
  }
  const params = new URLSearchParams({ url });
  if (connections) params.set('connections', connections);

  let res;
  try {
    res = await fetch(settings.host + '/api/add?' + params.toString(), { method: 'GET' });
  } catch (_) {
    notifyOffline();
    throw new Error("SDM est introuvable. Ouvrez l'application SDM puis réessayez.");
  }

  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok) {
    await markSent(url);
    notifySuccess(data.download);
    return { ok: true, download: data.download };
  }
  throw new Error((data && data.error) || "SDM n'a pas accepté la demande");
}

// ---------------- Notifications ----------------

function notifyOffline() {
  try {
    api.notifications.create('sdm-offline', {
      type: 'basic',
      iconUrl: api.runtime.getURL('icons/icon128.png'),
      title: 'SDM est introuvable',
      message: "Ouvrez l'application SDM (Sekou Download Manager), puis réessayez.",
    });
  } catch (_) { /* ignoré */ }
}

function notifySuccess(download) {
  try {
    api.notifications.create('sdm-ok-' + Date.now(), {
      type: 'basic',
      iconUrl: api.runtime.getURL('icons/icon128.png'),
      title: 'SDM — téléchargement démarré',
      message: (download && (download.filename || download.url)) || 'Téléchargement démarré',
    });
  } catch (_) { /* ignoré */ }
}