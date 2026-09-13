// ============================================================================
// SDM - Sekou Download Manager
// Moteur de téléchargement multi-connexions
//  - 8 à 32 segments parallèles (via l'en-tête HTTP Range)
//  - Pause / reprise / reprise après coupure (fichiers .part + méta-données)
//  - Organisation automatique par catégories (Vidéo, Audio, Documents, ...)
// ============================================================================

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

// ---------------- Constantes ----------------

let APP_VERSION = '1.0.0';
try {
  APP_VERSION = require('./package.json').version || APP_VERSION;
} catch (_) { /* ignoré */ }

const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) SDM/${APP_VERSION} Electron`;
const MIN_SEGMENTS = 8;
const MAX_SEGMENTS = 32;
const SEGMENT_TARGET = 8 * 1024 * 1024; // ~8 Mo par segment
const PROGRESS_EMIT_MS = 120;

const CATEGORY_DIRS = {
  video: 'Vidéo',
  audio: 'Audio',
  doc: 'Documents',
  archive: 'Archives',
  image: 'Images',
  app: 'Applications',
  other: 'Autres',
};

const EXT_CATEGORIES = {
  video: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'flv', 'wmv', 'mpg', 'mpeg', '3gp', 'ts', 'ogv'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'mid', 'midi'],
  doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf',
        'odt', 'ods', 'odp', 'csv', 'xml', 'json', 'epub', 'mobi'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'heic', 'avif'],
  app: ['exe', 'msi', 'apk', 'msix', 'appx', 'deb', 'rpm', 'dmg', 'iso', 'jar', 'pkg', 'run'],
};

// ---------------- État du moteur ----------------

const downloads = new Map(); // id -> téléchargement
let downloadDir = null;
let downloadsBase = null;
let eventSink = null;        // (type, payload) => void   (fourni par main.js)

function setEventSink(fn) { eventSink = fn; }
function emit(type, payload) { if (eventSink) eventSink(type, payload); }

// ---------------- Utilitaires ----------------

function makeId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function fileSize(filePath) {
  try { const st = fs.statSync(filePath); return st.isFile() ? st.size : 0; }
  catch (_) { return 0; }
}

function getExtension(filename) {
  const lower = String(filename || '').toLowerCase();
  const idx = lower.lastIndexOf('.');
  return idx >= 0 ? lower.slice(idx + 1) : '';
}

function getCategory(filename) {
  const ext = getExtension(filename);
  for (const cat of Object.keys(EXT_CATEGORIES)) {
    if (EXT_CATEGORIES[cat].includes(ext)) return cat;
  }
  return 'other';
}

function getCategoryLabel(category) {
  return CATEGORY_DIRS[category] || 'Autres';
}

// Dossier "Téléchargements" de l'utilisateur.
// main.js fournit le vrai chemin (app.getPath('downloads')) via setDownloadsBase.
function appDownloads() {
  return downloadsBase || path.join(require('os').homedir(), 'Downloads');
}
function setDownloadsBase(dir) { downloadsBase = dir; }

// Dossier de sauvegarde principal : Téléchargements\SDM
function getDownloadDir() {
  if (downloadDir) return downloadDir;
  downloadDir = path.join(appDownloads(), 'SDM');
  try { fs.mkdirSync(downloadDir, { recursive: true }); } catch (_) { /* ignoré */ }
  return downloadDir;
}

function setDownloadDir(dir) {
  downloadDir = dir;
  try { fs.mkdirSync(downloadDir, { recursive: true }); } catch (_) { /* ignoré */ }
}

function getCategoryDir(category) {
  const dir = path.join(getDownloadDir(), getCategoryLabel(category));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignoré */ }
  return dir;
}

// Supprime les caractères interdits sur Windows pour les noms de fichiers
function sanitizeFilename(name) {
  const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return clean || 'fichier';
}

// Évite d'écraser un fichier existant : "nom (1).ext", "nom (2).ext", ...
function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const dir = path.dirname(filePath);
  for (let i = 1; i < 10000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

// Nom du fichier : Content-Disposition, sinon dernier segment de l'URL
function resolveFilename(url, contentDisposition) {
  const cd = contentDisposition || '';

  const star = /filename\*=([^']*)''([^;]+)/i.exec(cd);
  if (star && star[2]) {
    try { return sanitizeFilename(decodeURIComponent(star[2])); }
    catch (_) { return sanitizeFilename(star[2]); }
  }

  const plain = /filename="?([^";]+)"?/i.exec(cd);
  if (plain && plain[1]) return sanitizeFilename(plain[1]);

  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (segment) {
      try { return sanitizeFilename(decodeURIComponent(segment)); }
      catch (_) { return sanitizeFilename(segment); }
    }
  } catch (_) { /* ignoré */ }

  return 'fichier-' + new Date().toISOString().slice(0, 10);
}

// ---------------- Création d'une entrée de téléchargement ----------------

function createEntry(url, options) {
  return {
    id: makeId(),
    url,
    filename: '',
    category: 'other',
    savePath: '',          // fichier final
    base: '',              // chemin de base (sans les .part)
    metaPath: '',
    totalBytes: 0,
    receivedBytes: 0,
    speed: 0,
    speedTickBytes: 0,
    speedTickTime: 0,
    status: 'starting',    // starting | downloading | paused | assembling | completed | error | removed
    error: '',
    failed: false,
    segments: [],          // [{ index, start, end, filePath, received, request, stream }]
    requestedConnections: (options && options.connections) || 0,
    pauseRequested: false,
    lastEmit: 0,
    startedAt: 0,
  };
}

// ---------------- Sonde : interroge le serveur avant de télécharger ----------------

function probeUrl(url) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return reject(new Error('URL invalide')); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return reject(new Error('Seuls les protocoles HTTP/HTTPS sont pris en charge'));
    }

    const mod = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : undefined,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        Range: 'bytes=0-0',
      },
    };

    const req = mod.request(opts, (res) => {
      const status = res.statusCode || 0;

      // Redirection
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve(probeUrl(new URL(res.headers.location, url).toString()));
      }

      if (status === 206) {
        const cr = String(res.headers['content-range'] || '');
        const m = /bytes\s+0-0\/(\d+|\*)/i.exec(cr);
        const total = m && m[1] !== '*' ? parseInt(m[1], 10) : 0;
        res.resume();
        return resolve({ total, rangeSupported: true, complete: false, headers: res.headers, url });
      }
      if (status === 200) {
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        res.resume();
        return resolve({ total, rangeSupported: false, complete: false, headers: res.headers, url });
      }
      if (status === 416) {
        const cr = String(res.headers['content-range'] || '');
        const m = /\/\s*(\d+)/i.exec(cr);
        const total = m ? parseInt(m[1], 10) : 0;
        res.resume();
        return resolve({ total, rangeSupported: true, complete: true, headers: res.headers, url });
      }
      res.resume();
      reject(new Error('Erreur HTTP ' + status));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

// ---------------- Segments ----------------

function chooseSegmentCount(totalBytes, requested, rangeSupported) {
  if (!rangeSupported || totalBytes <= 0) return 1;
  let n;
  if (requested >= MIN_SEGMENTS && requested <= MAX_SEGMENTS) {
    n = requested;
  } else {
    n = Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, Math.ceil(totalBytes / SEGMENT_TARGET)));
  }
  return Math.max(1, Math.min(n, totalBytes));
}

function segPath(base, index) {
  return base + '.part.' + String(index).padStart(3, '0');
}

function buildSegments(dl, count, rangeSupported) {
  const segs = [];
  if (!rangeSupported || dl.totalBytes <= 0) {
    segs.push({
      index: 0, start: 0, end: Infinity, filePath: segPath(dl.base, 0),
      received: 0, request: null, stream: null,
    });
    return segs;
  }
  const chunk = Math.floor(dl.totalBytes / count);
  let start = 0;
  for (let i = 0; i < count; i++) {
    const end = (i === count - 1) ? dl.totalBytes - 1 : start + chunk - 1;
    segs.push({
      index: i, start, end, filePath: segPath(dl.base, i),
      received: 0, request: null, stream: null,
    });
    start = end + 1;
  }
  return segs;
}

function sumSegments(dl) {
  return dl.segments.reduce((sum, s) => sum + (s.received || 0), 0);
}

// ---------------- Méta-données (reprise après coupure) ----------------

function saveMeta(dl) {
  try {
    const meta = {
      v: 1,
      url: dl.url,
      filename: dl.filename,
      category: dl.category,
      savePath: dl.savePath,
      base: dl.base,
      totalBytes: dl.totalBytes,
      receivedBytes: dl.receivedBytes,
      connections: dl.segments.length,
      segments: dl.segments.map((s) => ({ index: s.index, start: s.start, end: s.end })),
      status: dl.status,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(dl.metaPath, JSON.stringify(meta, null, 2));
  } catch (_) { /* ignoré */ }
}

// ---------------- Instantané (pour l'interface) ----------------

function snapshot(dl) {
  const progress = dl.totalBytes > 0
    ? Math.min(100, Math.round((dl.receivedBytes / dl.totalBytes) * 100))
    : (dl.status === 'completed' ? 100 : 0);

  return {
    id: dl.id,
    url: dl.url,
    filename: dl.filename || '',
    category: dl.category || 'other',
    categoryLabel: getCategoryLabel(dl.category),
    savePath: dl.savePath || '',
    totalBytes: dl.totalBytes || 0,
    receivedBytes: dl.receivedBytes || 0,
    speed: dl.speed || 0,
    status: dl.status,
    progress,
    error: dl.error || '',
    segmentCount: dl.segments ? dl.segments.length : 0,
  };
}

// ---------------- Démarrage d'un téléchargement ----------------

async function startDownload(url, options) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return { ok: false, error: 'Veuillez saisir une URL' };

  const dl = createEntry(trimmed, options || {});
  downloads.set(dl.id, dl);
  emit('status', snapshot(dl));

  try {
    const info = await probeUrl(dl.url);
    if (info.url && info.url !== dl.url) dl.url = info.url;

    dl.filename = resolveFilename(dl.url, info.headers['content-disposition']);
    dl.category = getCategory(dl.filename);
    dl.base = path.join(getCategoryDir(dl.category), dl.filename);
    dl.savePath = uniquePath(dl.base);
    dl.filename = path.basename(dl.savePath);
    dl.base = dl.savePath;
    dl.metaPath = dl.base + '.part.meta.json';
    dl.totalBytes = info.total || 0;

    if (info.complete) {
      dl.status = 'completed';
      dl.receivedBytes = dl.totalBytes;
      try { fs.writeFileSync(dl.savePath, ''); } catch (_) { /* ignoré */ }
      emit('status', snapshot(dl));
      return { ok: true, download: snapshot(dl) };
    }

    const count = chooseSegmentCount(dl.totalBytes, dl.requestedConnections, info.rangeSupported);
    dl.segments = buildSegments(dl, count, info.rangeSupported);
    dl.receivedBytes = 0;
    dl.status = 'downloading';
    dl.startedAt = Date.now();
    dl.lastEmit = 0;
    saveMeta(dl);
    emit('status', snapshot(dl));

    launchAll(dl);
  } catch (err) {
    dl.status = 'error';
    dl.error = (err && err.message) || 'Erreur inconnue';
    emit('status', snapshot(dl));
  }

  return { ok: true, download: snapshot(dl) };
}

function launchAll(dl) {
  for (const seg of dl.segments) {
    if (seg.done) continue;
    launchSegment(dl, seg);
  }
}

// ---------------- Lancement d'un segment ----------------

function launchSegment(dl, seg) {
  const start = seg.start + seg.received;
  if (seg.end !== Infinity && start > seg.end) {
    seg.done = true;
    maybeComplete(dl);
    return;
  }

  let parsed;
  try { parsed = new URL(dl.url); } catch (_) {
    return fail(dl, 'URL invalide');
  }

  const opts = {
    hostname: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
    },
  };
  if (dl.totalBytes > 0 && seg.end !== Infinity) {
    opts.headers.Range = `bytes=${start}-${seg.end}`;
  } else if (dl.totalBytes > 0) {
    opts.headers.Range = `bytes=${start}-`;
  }

  const mod = parsed.protocol === 'https:' ? https : http;
  const req = mod.request(opts, (res) => {
    const status = res.statusCode || 0;

    // Redirection : on relance le segment sur la nouvelle URL
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      try { dl.url = new URL(res.headers.location, dl.url).toString(); } catch (_) { /* ignoré */ }
      launchSegment(dl, seg);
      return;
    }

    // Segment déjà complet (416)
    if (status === 416) {
      res.resume();
      seg.received = seg.end !== Infinity
        ? seg.end - seg.start + 1
        : Math.max(seg.received, dl.totalBytes - seg.start);
      dl.receivedBytes = sumSegments(dl);
      seg.done = true;
      maybeComplete(dl);
      return;
    }

    // Serveur qui ignore Range pendant une reprise
    if (status === 200 && seg.start + seg.received > 0) {
      res.resume();
      return fail(dl, 'Le serveur ne prend pas en charge la reprise (Range)');
    }

    if (status !== 200 && status !== 206) {
      res.resume();
      return fail(dl, 'Erreur HTTP ' + status);
    }

    const stream = fs.createWriteStream(seg.filePath, { flags: seg.received > 0 ? 'a' : 'w' });
    seg.stream = stream;
    seg.request = req;

    res.pipe(stream);
    res.on('data', (chunk) => {
      seg.received += chunk.length;
      dl.receivedBytes += chunk.length;
      const now = Date.now();
      if (now - dl.lastEmit >= PROGRESS_EMIT_MS) {
        dl.lastEmit = now;
        emit('progress', snapshot(dl));
      }
    });

    let settled = false;
    const stop = (err) => {
      if (settled) return;
      settled = true;
      seg.request = null;
      seg.stream = null;
      onSegmentStop(dl, seg, err);
    };
    res.on('error', stop);
    res.on('aborted', () => stop());
    res.on('close', () => stop());
    stream.on('error', stop);
    stream.on('finish', () => stop());
  });

  req.on('error', (err) => {
    if (dl.pauseRequested) {
      seg.request = null;
      dl.receivedBytes = sumSegments(dl);
      checkPauseComplete(dl);
      return;
    }
    fail(dl, err.code || err.message);
  });

  seg.request = req;
  req.end();
}

// ---------------- Fin de segment / pause / assemblage ----------------

function onSegmentStop(dl, seg, err) {
  if (dl.pauseRequested) {
    dl.receivedBytes = sumSegments(dl);
    checkPauseComplete(dl);
    return;
  }
  if (err) {
    if (dl.status === 'downloading' || dl.status === 'starting') {
      fail(dl, err.code || err.message);
    }
    return;
  }
  if (dl.status !== 'downloading') return;
  if (seg.done) return;
  seg.done = true;
  maybeComplete(dl);
}

function checkPauseComplete(dl) {
  const allStopped = dl.segments.every((s) => !s.request);
  if (!allStopped || dl.status === 'removed') return;
  dl.pauseRequested = false;
  dl.status = 'paused';
  dl.speed = 0;
  dl.receivedBytes = sumSegments(dl);
  saveMeta(dl);
  emit('status', snapshot(dl));
}

function maybeComplete(dl) {
  if (dl.pauseRequested || dl.status !== 'downloading') return;
  if (!dl.segments.every((s) => s.done)) return;
  dl.receivedBytes = sumSegments(dl);
  assemble(dl);
}

function pipePromise(reader, writer) {
  return new Promise((resolve, reject) => {
    reader.on('error', reject);
    reader.pipe(writer, { end: false });
    reader.on('end', resolve);
  });
}

// Assemble les segments dans le fichier final, puis nettoie
async function assemble(dl) {
  dl.status = 'assembling';
  dl.speed = 0;
  emit('status', snapshot(dl));

  try {
    const writer = fs.createWriteStream(dl.savePath);
    for (const seg of dl.segments) {
      const reader = fs.createReadStream(seg.filePath);
      await pipePromise(reader, writer);
    }
    await new Promise((resolve, reject) => {
      writer.on('error', reject);
      writer.end((e) => (e ? reject(e) : resolve()));
    });

    for (const seg of dl.segments) {
      try { if (fs.existsSync(seg.filePath)) fs.unlinkSync(seg.filePath); } catch (_) { /* ignoré */ }
    }
    try { if (fs.existsSync(dl.metaPath)) fs.unlinkSync(dl.metaPath); } catch (_) { /* ignoré */ }

    dl.status = 'completed';
    dl.receivedBytes = dl.totalBytes;
    emit('status', snapshot(dl));
  } catch (err) {
    dl.status = 'error';
    dl.error = 'Assemblage impossible : ' + (err.message || err);
    emit('status', snapshot(dl));
  }
}

function fail(dl, message) {
  if (dl.status === 'completed' || dl.status === 'removed' || dl.status === 'paused' || dl.failed) return;
  dl.failed = true;
  dl.status = 'error';
  dl.error = (message || 'Erreur inconnue').toString();
  dl.speed = 0;
  for (const seg of dl.segments) {
    if (seg.request) { try { seg.request.destroy(); } catch (_) { /* ignoré */ } }
  }
  dl.receivedBytes = sumSegments(dl);
  saveMeta(dl);
  emit('status', snapshot(dl));
}

// ---------------- Actions utilisateur ----------------

function pauseDownload(id) {
  const dl = downloads.get(id);
  if (!dl) return { ok: false, error: 'Téléchargement introuvable' };
  if (dl.status !== 'downloading') return { ok: false, error: 'Impossible de mettre en pause' };

  dl.pauseRequested = true;
  dl.status = 'pausing';
  emit('status', snapshot(dl));
  for (const seg of dl.segments) {
    if (seg.request) { try { seg.request.destroy(); } catch (_) { /* ignoré */ } }
  }
  return { ok: true };
}

function resumeDownload(id) {
  const dl = downloads.get(id);
  if (!dl) return { ok: false, error: 'Téléchargement introuvable' };
  if (dl.status !== 'paused' && dl.status !== 'error') {
    return { ok: false, error: 'Ce téléchargement ne peut pas être repris' };
  }

  // Redécouvre la taille réelle de chaque segment sur le disque
  for (const seg of dl.segments) {
    seg.received = fileSize(seg.filePath);
    seg.request = null;
    seg.stream = null;
    seg.done = false;
  }
  dl.receivedBytes = sumSegments(dl);
  dl.failed = false;
  dl.status = 'downloading';
  dl.error = '';
  dl.lastEmit = 0;
  saveMeta(dl);
  emit('status', snapshot(dl));

  if (dl.totalBytes > 0 && dl.receivedBytes >= dl.totalBytes) {
    for (const seg of dl.segments) seg.done = true;
    maybeComplete(dl);
    return { ok: true };
  }
  launchAll(dl);
  return { ok: true };
}

function removeDownload(id) {
  const dl = downloads.get(id);
  if (!dl) return { ok: false, error: 'Téléchargement introuvable' };
  dl.status = 'removed';

  for (const seg of dl.segments) {
    if (seg.request) { try { seg.request.destroy(); } catch (_) { /* ignoré */ } }
  }
  for (const p of [dl.metaPath, dl.savePath].concat(dl.segments.map((s) => s.filePath))) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* ignoré */ }
  }
  downloads.delete(id);
  emit('removed', { id });
  return { ok: true };
}

function listDownloads() {
  return Array.from(downloads.values()).map(snapshot);
}

// ---------------- Calcul de la vitesse (toutes les secondes) ----------------

setInterval(() => {
  const now = Date.now();
  for (const dl of downloads.values()) {
    if (dl.status === 'downloading') {
      if (!dl.speedTickTime) {
        dl.speedTickTime = now;
        dl.speedTickBytes = dl.receivedBytes;
      }
      const elapsed = (now - dl.speedTickTime) / 1000;
      if (elapsed >= 1) {
        dl.speed = Math.max(0, Math.round((dl.receivedBytes - dl.speedTickBytes) / elapsed));
        dl.speedTickTime = now;
        dl.speedTickBytes = dl.receivedBytes;
        emit('progress', snapshot(dl));
      }
    } else {
      dl.speed = 0;
      dl.speedTickTime = 0;
      dl.speedTickBytes = 0;
    }
  }
}, 1000);

// ---------------- Répertoires : parcours récursif ----------------

function walkDir(dir, onFile) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(p, onFile);
    } else if (entry.isFile() && onFile) {
      onFile(p);
    }
  }
}

// ---------------- Restauration des téléchargements (reprise après coupure) ----------------

function scanPendingDownloads() {
  const restored = [];
  walkDir(getDownloadDir(), (filePath) => {
    if (!filePath.endsWith('.part.meta.json')) return;
    try {
      const meta = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!meta.base) return;

      // Fichier final déjà présent et plus aucun segment : téléchargement terminé
      const hasFinal = meta.savePath && fileSize(meta.savePath) > 0;
      const someSegment = (meta.segments || [{ index: 0 }]).some(
        (s) => fileSize(segPath(meta.base, s.index)) > 0);
      if (hasFinal && !someSegment) {
        try { fs.unlinkSync(filePath); } catch (_) { /* ignoré */ }
        return;
      }

      const dl = createEntry(meta.url, { connections: meta.connections || 0 });
      dl.id = makeId();
      dl.filename = meta.filename || path.basename(meta.base);
      dl.category = meta.category || getCategory(dl.filename);
      dl.savePath = meta.savePath || meta.base;
      dl.base = meta.base;
      dl.metaPath = meta.base + '.part.meta.json';
      dl.totalBytes = meta.totalBytes || 0;
      dl.status = 'paused';

      const metaSegs = meta.segments || [];
      const count = Math.max(1, metaSegs.length);
      dl.segments = [];
      for (let i = 0; i < count; i++) {
        const sm = metaSegs[i] || { index: i, start: 0, end: Infinity };
        dl.segments.push({
          index: i,
          start: sm.start || 0,
          end: sm.end !== undefined ? sm.end : Infinity,
          filePath: segPath(dl.base, i),
          received: fileSize(segPath(dl.base, i)),
          request: null,
          stream: null,
        });
      }
      dl.receivedBytes = sumSegments(dl);
      downloads.set(dl.id, dl);
      emit('status', snapshot(dl));
      restored.push(dl);
    } catch (_) {
      try { fs.unlinkSync(filePath); } catch (__) { /* ignoré */ }
    }
  });
  return restored;
}

// Supprime les segments .part orphelins (sans méta-données) plus vieux qu'un jour
function cleanupTempFiles() {
  walkDir(getDownloadDir(), (filePath) => {
    if (!/\.part\.\d{3}$/.test(filePath)) return;
    const metaPath = filePath.replace(/\.part\.\d{3}$/, '.part.meta.json');
    if (!fs.existsSync(metaPath)) {
      try {
        const st = fs.statSync(filePath);
        if (Date.now() - st.mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(filePath);
      } catch (_) { /* ignoré */ }
    }
  });
}

// ---------------- Capture vidéo HLS (.m3u8) ----------------
// Télécharge les segments d'un flux HLS et les assemble en un fichier vidéo.
// À n'utiliser que lorsque cela est légalement autorisé (voir options de l'extension).

const HLS_CONCURRENCY = 4;

function isHlsUrl(url) {
  const clean = String(url || '').split('#')[0].split('?')[0].toLowerCase();
  return clean.endsWith('.m3u8');
}

function fetchBuffer(url, referer) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return reject(new Error('URL invalide')); }
    const mod = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : undefined,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
      },
    };
    if (referer) opts.headers.Referer = referer;

    const req = mod.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchBuffer(new URL(res.headers.location, url).toString(), referer));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error('Erreur HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// Résout les URLs des segments depuis un manifeste m3u8
function parseHlsManifest(manifestText) {
  const lines = String(manifestText).split(/\r?\n/);
  const segments = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    segments.push(trimmed);
  }
  return segments;
}

function resolveUrl(base, ref) {
  try { return new URL(ref, base).toString(); } catch (_) { return ref; }
}

// Lance un téléchargement HLS ; retourne directement l'entrée de téléchargement
function startHlsDownload(url, options) {
  const dl = createEntry(url, options || {});
  downloads.set(dl.id, dl);
  emit('status', snapshot(dl));

  (async () => {
    try {
      const manifest = await fetchBuffer(dl.url);
      const text = manifest.toString('utf8');
      const segmentRefs = parseHlsManifest(text);
      if (segmentRefs.length === 0) throw new Error('Aucun segment trouvé dans le manifeste');

      const baseName = path.basename(dl.url.split('#')[0].split('?')[0]).replace(/\.m3u8$/i, '') || 'flux';
      dl.filename = sanitizeFilename(baseName + '.ts');
      dl.category = 'video';
      dl.base = path.join(getCategoryDir(dl.category), dl.filename);
      dl.savePath = uniquePath(dl.base);
      dl.filename = path.basename(dl.savePath);
      dl.base = dl.savePath;
      dl.metaPath = dl.base + '.part.meta.json';

      dl.segments = segmentRefs.map((ref, i) => ({
        index: i,
        url: resolveUrl(dl.url, ref),
        start: 0,
        end: 0,
        filePath: segPath(dl.base, i),
        received: 0,
        request: null,
        stream: null,
        done: false,
      }));
      dl.totalBytes = 0;
      dl.status = 'downloading';
      dl.lastEmit = 0;
      saveMeta(dl);
      emit('status', snapshot(dl));

      let cursor = 0;
      let errors = 0;
      const worker = async () => {
        while (cursor < dl.segments.length) {
          if (dl.pauseRequested || dl.status !== 'downloading') return;
          const seg = dl.segments[cursor++];
          try {
            const buf = seg.received > 0 ? undefined : await fetchBuffer(seg.url, dl.url);
            if (dl.pauseRequested || dl.status !== 'downloading') return;
            if (buf) {
              fs.writeFileSync(seg.filePath, buf);
              seg.received = buf.length;
            }
            seg.done = true;
            dl.receivedBytes = sumSegments(dl);
            const now = Date.now();
            if (now - dl.lastEmit >= PROGRESS_EMIT_MS) {
              dl.lastEmit = now;
              emit('progress', snapshot(dl));
            }
          } catch (err) {
            if (dl.pauseRequested || dl.status !== 'downloading') return;
            errors++;
            if (errors >= 3) return fail(dl, 'Échec du téléchargement HLS');
          }
        }
      };

      const workers = [];
      for (let i = 0; i < HLS_CONCURRENCY && i < dl.segments.length; i++) {
        workers.push(worker());
      }
      await Promise.all(workers);
      // (Hors des workers) : l'assembleur ne doit tourner qu'une fois, après
      // que tous les segments ont fini d'être écrits sur le disque.
      if (dl.status === 'downloading') {
        dl.totalBytes = dl.receivedBytes > 0 ? dl.receivedBytes : dl.totalBytes;
        dl.segments.forEach((s) => { s.done = true; });
        saveMeta(dl);
        maybeComplete(dl);
      }
    } catch (err) {
      if (dl.status === 'downloading' || dl.status === 'starting') {
        fail(dl, (err && err.message) || 'Erreur de flux HLS');
      }
    }
  })();

  return { ok: true, download: snapshot(dl) };
}

// ---------------- Exports ----------------

module.exports = {
  startDownload,
  startHlsDownload,
  isHlsUrl,
  pauseDownload,
  resumeDownload,
  removeDownload,
  listDownloads,
  getDownloadDir,
  setDownloadDir,
  setDownloadsBase,
  getCategory,
  getCategoryLabel,
  scanPendingDownloads,
  cleanupTempFiles,
  setEventSink,
};