// ============================================================================
// SDM - Sekou Download Manager
// Logique d'interface : liste des téléchargements, progression, pause, reprise
// ============================================================================

'use strict';

// ---------------- Sélecteurs DOM ----------------

const els = {
  urlInput: document.getElementById('url-input'),
  btnDownload: document.getElementById('btn-download'),
  btnChooseDir: document.getElementById('btn-choose-dir'),
  saveDirLabel: document.getElementById('save-dir-label'),
  list: document.getElementById('downloads-list'),
  emptyState: document.getElementById('empty-state'),
  statTotal: document.getElementById('stat-total'),
  statActive: document.getElementById('stat-active'),
  statCompleted: document.getElementById('stat-completed'),
  statSpeed: document.getElementById('stat-speed'),
  toastContainer: document.getElementById('toast-container'),
  serverBanner: document.getElementById('server-banner'),
  serverTitle: document.getElementById('server-title'),
  serverSub: document.getElementById('server-sub'),
  btnExtFolder: document.getElementById('btn-ext-folder'),
  btnServerRefresh: document.getElementById('btn-server-refresh'),
};

// ---------------- État local de l'interface ----------------

const state = {
  downloads: new Map(), // id -> dernier instantané (snapshot) reçu
  filter: 'all',        // all | active | completed | paused | error
};

// ---------------- Icônes SVG (boutons d'action) ----------------

const ICONS = {
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4h4v16H7zM13 4h4v16h-4z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
};

// ---------------- Libellés des statuts ----------------

const STATUS_LABELS = {
  starting: 'Démarrage…',
  downloading: 'Téléchargement',
  pausing: 'Pause…',
  paused: 'En pause',
  assembling: 'Assemblage…',
  completed: 'Terminé',
  error: 'Erreur',
};

// ---------------- Formatage ----------------

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  const digits = i === 0 ? 0 : (value >= 100 ? 0 : 1);
  return value.toFixed(digits).replace('.', ',') + ' ' + units[i];
}

function formatSpeed(speed) {
  return speed > 0 ? formatBytes(speed) + '/s' : '—';
}

function formatEta(totalBytes, receivedBytes, speed) {
  if (speed <= 0 || totalBytes <= 0) return '—';
  const remaining = totalBytes - receivedBytes;
  if (remaining <= 0) return 'Terminé';
  const seconds = Math.round(remaining / speed);
  if (seconds < 60) return '~' + seconds + ' s';
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return '~' + mm + ' min ' + ss + ' s';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function displayName(dl) {
  if (dl.filename) return dl.filename;
  try {
    return new URL(dl.url).pathname.split('/').filter(Boolean).pop() || dl.url;
  } catch (_) {
    return dl.url;
  }
}

// ---------------- Couleur du badge selon le type de fichier ----------------

function fileBadgeClass(filename) {
  const lower = String(filename || '');
  const ext = lower.includes('.') ? lower.split('.').pop().toLowerCase() : '';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf',
       'odt', 'ods', 'odp', 'csv', 'xml', 'json'].includes(ext)) return 'doc';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg', '3gp'].includes(ext)) return 'video';
  if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus'].includes(ext)) return 'audio';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return 'zip';
  if (['exe', 'msi', 'apk', 'msix', 'appx', 'deb', 'rpm', 'dmg', 'iso', 'jar'].includes(ext)) return 'app';
  return 'other';
}

function badgeLabel(filename) {
  const lower = String(filename || '');
  const ext = lower.includes('.') ? lower.split('.').pop() : '';
  return (ext ? ext.slice(0, 4) : 'BIN').toUpperCase();
}

// ---------------- Correspondance filtre ----------------

// ---------------- Création et mise à jour des cartes ----------------

function createCardElement(dl) {
  const card = document.createElement('article');
  card.className = 'dl-card';
  card.dataset.id = dl.id;
  card.innerHTML =
    '<div class="file-badge ' + fileBadgeClass(dl.filename) + '">' + escapeHtml(badgeLabel(dl.filename)) + '</div>' +
    '<div class="dl-main">' +
      '<div class="dl-top">' +
        '<span class="cat-badge cat-' + escapeHtml(dl.category || 'other') + '">' +
          escapeHtml(dl.categoryLabel || 'Autres') + '</span>' +
        '<h3 class="dl-name" title="' + escapeHtml(displayName(dl)) + '">' + escapeHtml(displayName(dl)) + '</h3>' +
        '<span class="dl-size"></span>' +
      '</div>' +
      '<div class="progress-track"><div class="progress-fill"></div></div>' +
      '<div class="dl-meta">' +
        '<span class="dl-status status-starting"><i></i><span class="status-text"></span></span>' +
        '<span class="dl-conns"></span>' +
        '<span class="dl-speed"></span>' +
        '<span class="dl-eta"></span>' +
        '<span class="dl-url" title="' + escapeHtml(dl.url) + '">' + escapeHtml(dl.url) + '</span>' +
      '</div>' +
      '<div class="dl-error-msg"></div>' +
    '</div>' +
    '<div class="dl-actions">' +
      '<button class="action-btn accent btn-pause" title="Mettre en pause">' + ICONS.pause + '</button>' +
      '<button class="action-btn btn-folder" title="Ouvrir le dossier">' + ICONS.folder + '</button>' +
      '<button class="action-btn danger btn-remove" title="Supprimer">' + ICONS.trash + '</button>' +
    '</div>';

  card.querySelector('.btn-pause').addEventListener('click', () => toggleDownload(dl.id));
  card.querySelector('.btn-folder').addEventListener('click', () => sdm.openFolder(dl.id));
  card.querySelector('.btn-remove').addEventListener('click', () => removeDownload(dl.id));
  return card;
}

function updateCard(card, dl) {
  const q = (sel) => card.querySelector(sel);
  const name = displayName(dl);
  const total = dl.totalBytes || 0;
  const received = dl.receivedBytes || 0;
  const pct = dl.progress || 0;

  q('.dl-name').textContent = name;
  q('.dl-name').title = name;

  const catBadge = q('.cat-badge');
  if (catBadge) {
    catBadge.className = 'cat-badge cat-' + escapeHtml(dl.category || 'other');
    catBadge.textContent = dl.categoryLabel || 'Autres';
  }

  const connsEl = q('.dl-conns');
  if (connsEl) {
    if (dl.segmentCount && dl.segmentCount > 0) {
      connsEl.textContent = dl.segmentCount + '×';
      connsEl.title = 'Téléchargement découpé en ' + dl.segmentCount + ' connexions parallèles (8 à 32)';
    } else {
      connsEl.textContent = '';
    }
  }

  q('.dl-size').textContent = total > 0
    ? formatBytes(received) + ' / ' + formatBytes(total) + ' (' + pct + ' %)'
    : formatBytes(received);

  q('.progress-fill').style.width = pct + '%';
  card.classList.toggle('is-downloading', dl.status === 'downloading');

  const statusEl = q('.dl-status');
  statusEl.className = 'dl-status status-' + (dl.status || 'starting');
  statusEl.querySelector('.status-text').textContent = STATUS_LABELS[dl.status] || dl.status;

  const speed = dl.status === 'downloading' ? (dl.speed || 0) : 0;
  q('.dl-speed').textContent = speed > 0 ? formatSpeed(speed) : '—';
  q('.dl-eta').textContent = dl.status === 'downloading' ? formatEta(total, received, speed) : '—';
  q('.dl-url').textContent = dl.url;
  q('.dl-url').title = dl.url;

  const errEl = q('.dl-error-msg');
  errEl.textContent = dl.status === 'error'
    ? '⚠ ' + (dl.error || 'Erreur inconnue')
    : '';

  const toggle = q('.btn-pause');
  toggle.disabled = dl.status === 'completed' || dl.status === 'assembling';
  toggle.classList.remove('accent', 'green');
  if (dl.status === 'downloading' || dl.status === 'pausing') {
    toggle.classList.add('accent');
    toggle.innerHTML = ICONS.pause;
    toggle.title = 'Mettre en pause';
  } else if (dl.status === 'completed') {
    toggle.classList.add('green');
    toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    toggle.title = 'Terminé';
  } else {
    toggle.classList.add('green');
    toggle.innerHTML = ICONS.play;
    toggle.title = 'Reprendre';
  }
}

function renderDownload(dl) {
  let card = els.list.querySelector('[data-id="' + dl.id + '"]');
  if (!card) {
    card = createCardElement(dl);
    els.list.prepend(card);
  }
  updateCard(card, dl);
  card.style.display = matchesFilter(dl) ? '' : 'none';
}

function applyFilter() {
  for (const [id, dl] of state.downloads) {
    const card = els.list.querySelector('[data-id="' + id + '"]');
    if (card) card.style.display = matchesFilter(dl) ? '' : 'none';
  }
}

// ---------------- Correspondance filtre ----------------

function matchesFilter(dl) {
  switch (state.filter) {
    case 'active': return ['starting', 'downloading', 'pausing', 'assembling'].includes(dl.status);
    case 'completed': return dl.status === 'completed';
    case 'paused': return dl.status === 'paused';
    case 'error': return dl.status === 'error';
    default: return true;
  }
}

// ---------------- Statistiques ----------------

function updateStats() {
  const all = Array.from(state.downloads.values());
  els.statTotal.textContent = all.length;
  els.statActive.textContent = all.filter((d) => ['starting', 'downloading', 'pausing', 'assembling'].includes(d.status)).length;
  els.statCompleted.textContent = all.filter((d) => d.status === 'completed').length;

  const totalSpeed = all.reduce(
    (sum, d) => sum + (d.status === 'downloading' ? (d.speed || 0) : 0), 0);
  els.statSpeed.textContent = totalSpeed > 0 ? formatBytes(totalSpeed) + '/s' : '0 B/s';
}

function updateEmptyState() {
  let visible = 0;
  for (const dl of state.downloads.values()) {
    if (matchesFilter(dl)) visible++;
  }
  els.emptyState.classList.toggle('visible', visible === 0);
}

// ---------------- Notifications (toasts) ----------------

function toast(message, type) {
  const typeName = ['success', 'error', 'warning'].includes(type) ? type : 'default';
  const t = document.createElement('div');
  t.className = 'toast ' + typeName;
  t.innerHTML = (ICONS[typeName] || ICONS.info) + '<span>' + escapeHtml(message) + '</span>';
  els.toastContainer.appendChild(t);
  setTimeout(() => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 240);
  }, 3600);
}

// ---------------- Actions de téléchargement ----------------

async function downloadFromInput() {
  const url = els.urlInput.value.trim();
  if (!url) { els.urlInput.focus(); return; }

  const result = await sdm.startDownload(url);
  if (result && result.ok) {
    state.downloads.set(result.download.id, result.download);
    renderDownload(result.download);
    els.urlInput.value = '';
    els.urlInput.focus();
    toast('Téléchargement démarré : ' + displayName(result.download), 'default');
    updateStats();
    updateEmptyState();
  } else {
    toast((result && result.error) || 'Impossible de démarrer le téléchargement', 'error');
  }
}

async function toggleDownload(id) {
  const dl = state.downloads.get(id);
  if (!dl) return;

  if (dl.status === 'downloading' || dl.status === 'pausing') {
    const r = await sdm.pauseDownload(id);
    if (r && !r.ok) toast(r.error || 'Impossible de mettre en pause', 'warning');
  } else if (dl.status === 'paused' || dl.status === 'error') {
    const r = await sdm.resumeDownload(id);
    if (r && !r.ok) toast(r.error || 'Impossible de reprendre', 'warning');
  }
}

async function removeDownload(id) {
  const r = await sdm.removeDownload(id);
  if (r && !r.ok) toast(r.error || 'Impossible de supprimer', 'error');
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  applyFilter();
  updateEmptyState();
}

// ---------------- Bannière serveur local & extension ----------------

function updateServerBanner(status) {
  if (!status) return;
  els.serverBanner.classList.toggle('on', !!status.running);
  els.serverBanner.classList.toggle('off', !status.running && !!status.bindError);

  if (status.running) {
    els.serverTitle.textContent = 'Serveur actif — port ' + status.port;
    els.serverSub.textContent = "L'extension navigateur peut envoyer des liens vers SDM (port " + status.port + ').';
  } else if (status.bindError) {
    els.serverTitle.textContent = 'Serveur hors ligne';
    els.serverSub.textContent = status.bindError;
  } else {
    els.serverTitle.textContent = 'Démarrage du serveur…';
    els.serverSub.textContent = 'Extension navigateur : chaque téléchargement peut être envoyé à SDM.';
  }
}

// ---------------- Écouteurs IPC (événements du processus principal) ----------------

sdm.onProgress((dl) => {
  state.downloads.set(dl.id, dl);
  renderDownload(dl);
  updateStats();
});

sdm.onStatus((dl) => {
  const prev = state.downloads.get(dl.id);
  state.downloads.set(dl.id, dl);
  renderDownload(dl);
  updateStats();
  updateEmptyState();

  if (prev && prev.status !== dl.status) {
    if (dl.status === 'completed') toast(displayName(dl) + ' téléchargé', 'success');
    else if (dl.status === 'error') toast(displayName(dl) + ' : ' + (dl.error || 'erreur'), 'error');
    else if (dl.status === 'paused') toast(displayName(dl) + ' mis en pause', 'warning');
  }
});

sdm.onRemoved(({ id }) => {
  state.downloads.delete(id);
  const card = els.list.querySelector('[data-id="' + id + '"]');
  if (card) card.remove();
  updateStats();
  updateEmptyState();
});

// ---------------- Initialisation ----------------

function init() {
  // Bouton Télécharger + touche Entrée
  els.btnDownload.addEventListener('click', downloadFromInput);
  els.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') downloadFromInput();
    if (e.key === 'Escape') els.urlInput.value = '';
  });

  // Bouton de changement de dossier
  els.btnChooseDir.addEventListener('click', async () => {
    const r = await sdm.chooseDirectory();
    if (r && r.ok) {
      els.saveDirLabel.textContent = r.dir;
      els.saveDirLabel.title = r.dir;
      toast('Dossier de téléchargement modifié', 'default');
    }
  });

  // Serveur local & extension
  sdm.onServerStatus(updateServerBanner);
  sdm.getServerStatus().then(updateServerBanner);
  els.btnExtFolder.addEventListener('click', () => { sdm.openExtensionFolder(); });
  els.btnServerRefresh.addEventListener('click', () => {
    sdm.getServerStatus().then(updateServerBanner);
  });

  // Filtres
  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => setFilter(btn.dataset.filter));
  });

  // Restaure le dossier et les téléchargements existants
  sdm.getDownloadDirectory().then((dir) => {
    if (dir) { els.saveDirLabel.textContent = dir; els.saveDirLabel.title = dir; }
  });

  sdm.listDownloads().then((list) => {
    if (Array.isArray(list)) {
      list.forEach((dl) => {
        state.downloads.set(dl.id, dl);
        renderDownload(dl);
      });
      updateStats();
      updateEmptyState();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);