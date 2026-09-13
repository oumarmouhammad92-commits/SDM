// SDM - Test de fumée v3 (non distribué). Valide le moteur multi-connexions,
// pause/reprise, catégories, HLS et le serveur local de l'extension.
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const engine = require(path.join(__dirname, '..', 'download-engine'));
const { startServer, DEFAULT_PORT } = require(path.join(__dirname, '..', 'local-server'));

const LOGPATH = path.join(__dirname, 'smoke-result.txt');
const TEST_PORT = 28322;
const LOCAL_PORT = 28323;
const results = [];
function logfile(line) {
  const prev = fs.existsSync(LOGPATH) ? fs.readFileSync(LOGPATH, 'utf8') : '';
  fs.writeFileSync(LOGPATH, prev + line + '\n', 'utf8');
}
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  logfile((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  -> ' + detail : ''));
}
function log(msg) { logfile(msg); }

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sdm-smoke-'));
const FILE_SIZE = 5 * 1024 * 1024;
const FILE_DATA = crypto.randomBytes(FILE_SIZE);
const FILE_SHA = crypto.createHash('sha256').update(FILE_DATA).digest('hex');
function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

// ---------------- Serveur HTTP de test (Range) ----------------
function startTestServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const sendBytes = (status, headers, body) => {
      res.writeHead(status, headers);
      try { if (body) res.write(Buffer.from(body)); res.end(); } catch (_) { /* ignoré */ }
    };
    if (url.pathname === '/file.bin') {
      const range = req.headers && req.headers.range;
      const m = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = (m[2] === '' ? FILE_SIZE - 1 : Math.min(parseInt(m[2], 10), FILE_SIZE - 1));
        if (start >= FILE_SIZE) return sendBytes(416, { 'Content-Range': 'bytes */' + FILE_SIZE }, null);
        const chunk = FILE_DATA.subarray(start, end + 1);
        return sendBytes(206, {
          'Content-Range': 'bytes ' + start + '-' + end + '/' + FILE_SIZE,
          'Content-Length': chunk.length, 'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="big-file.bin"',
        }, chunk);
      }
      return sendBytes(200, {
        'Content-Length': FILE_SIZE, 'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="big-file.bin"',
      }, FILE_DATA);
    }
    if (url.pathname === '/slow.bin') {
      const range = req.headers && req.headers.range;
      const m = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = m ? parseInt(m[1], 10) : 0;
      const end = m ? (m[2] === '' ? FILE_SIZE - 1 : Math.min(parseInt(m[2], 10), FILE_SIZE - 1)) : FILE_SIZE - 1;
      const total = end - start + 1;
      res.writeHead(m ? 206 : 200, {
        'Content-Length': total, 'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="slow-file.bin"',
        ...(m ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + FILE_SIZE } : {}),
      });
      let offset = start;
      const tick = () => {
        if (!res.socket || res.destroyed) return;
        const chunk = FILE_DATA.subarray(offset, Math.min(end + 1, offset + 8 * 1024));
        try { res.write(Buffer.from(chunk)); } catch (_) { return; }
        offset += chunk.length;
        if (offset <= end) setTimeout(tick, 20);
        else { try { res.end(); } catch (_) { /* ignore */ } }
      };
      tick();
      return;
    }
    if (url.pathname === '/stream/master.m3u8') {
      return sendBytes(200, { 'Content-Type': 'application/vnd.apple.mpegurl' },
        '#EXTM3U\n#EXTINF:2,\nseg1.ts\n#EXTINF:2,\nseg2.ts\n#EXTINF:2,\nseg3.ts\n');
    }
    if (/^\/stream\/seg\d\.ts$/.test(url.pathname)) {
      const data = Buffer.from('SEGMENT-' + url.pathname.slice(-4) + '-DATA-' + url.pathname.length);
      return sendBytes(200, { 'Content-Type': 'video/mp2t', 'Content-Length': data.length }, data);
    }
    return sendBytes(404, { 'Content-Type': 'text/plain' }, 'not found');
  });
  server.listen(TEST_PORT, '127.0.0.1');
  return server;
}

async function waitDone(id, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const d = engine.listDownloads().find((x) => x.id === id);
    if (d && (d.status === 'completed' || d.status === 'error')) return d;
    await new Promise((r) => setTimeout(r, 100));
  }
  const d = engine.listDownloads().find((x) => x.id === id);
  return d && (d.status === 'completed' || d.status === 'error') ? d : null;
}
async function waitPaused(id, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const d = engine.listDownloads().find((x) => x.id === id);
    if (d && (d.status === 'paused' || d.status === 'completed' || d.status === 'error')) return d;
    await new Promise((r) => setTimeout(r, 100));
  }
  const d = engine.listDownloads().find((x) => x.id === id);
  return d && (d.status === 'paused' || d.status === 'completed' || d.status === 'error') ? d : null;
}


function sha256FileSafe(p) { try { return sha256File(p); } catch (_) { return null; } }
// ---------------- Test principal ----------------
(async () => {
  log('== Démarrage du test pid=' + process.pid + ' ts=' + Date.now());
  engine.setEventSink(() => {});
  engine.setDownloadsBase(WORK);
  startTestServer();
  await new Promise((r) => setTimeout(r, 250));
  const base = 'http://127.0.0.1:' + TEST_PORT;

  check('catégorie vidéo', engine.getCategory('film.mp4') === 'video');
  check('catégorie archive', engine.getCategory('data.zip') === 'archive');
  check('catégorie autre', engine.getCategory('inconnu.xyz') === 'other');

  const dl1 = await engine.startDownload(base + '/file.bin', { connections: 8 });
  const id1 = dl1.download.id;
  check('démarrage dl multi-connexions', dl1.ok && dl1.download.segmentCount >= 8, 'segments=' + dl1.download.segmentCount);
  const fin1 = await waitDone(id1, 60000);
  check('dl multi-connexions terminé', !!fin1, fin1 ? 'status=' + fin1.status + ' segmentCount=' + fin1.segmentCount : 'timeout');
  const savedPath = fin1 && fin1.savePath;
  check('fichier sauvegardé', !!savedPath && fs.existsSync(savedPath), savedPath || '');
  check('fichier identique (sha256)', !!savedPath && sha256FileSafe(savedPath) === FILE_SHA);
  check('nom depuis content-disposition', savedPath && /big-file/.test(savedPath), savedPath || '');
  check('fichier dans sous-dossier Autres', savedPath && /Autres/.test(path.dirname(savedPath)), (savedPath && path.dirname(savedPath)) || '');

  const dl2 = await engine.startDownload(base + '/slow.bin', { connections: 4 });
  const id2 = dl2.download.id;
  await new Promise((r) => setTimeout(r, 1500));
  await engine.pauseDownload(id2);
  const paused = await waitPaused(id2, 8000);
  check('pause effective', !!paused, paused ? 'status=' + paused.status + ' bytes=' + paused.receivedBytes : 'timeout');
  const bytesAtPause = paused ? paused.receivedBytes : 0;

  await engine.resumeDownload(id2);
  const fin2 = await waitDone(id2, 60000);
  check('reprise -> terminé', !!fin2, fin2 ? 'status=' + fin2.status : 'timeout');
  check('reprise depuis le point de pause', bytesAtPause > 0 && fin2 && fin2.receivedBytes > bytesAtPause, 'bytesPause=' + bytesAtPause + ' bytesFin=' + (fin2 && fin2.receivedBytes));
  check('fichier reprise identique', !!fin2 && fs.existsSync(fin2.savePath) && sha256FileSafe(fin2.savePath) === FILE_SHA);

  startServer(engine, { port: LOCAL_PORT, onStatus: () => {} });
  await new Promise((r) => setTimeout(r, 250));
  const health = await fetch('http://127.0.0.1:' + LOCAL_PORT + '/api/health').then((r) => r.json());
  check('serveur /api/health', health.ok && health.name === 'SDM', JSON.stringify(health));
  const added = await fetch('http://127.0.0.1:' + LOCAL_PORT + '/api/add?url=' + encodeURIComponent(base + '/file.bin') + '&connections=8').then((r) => r.json());
  check('serveur /api/add', added.ok && added.download && /^[a-z0-9]+-[a-z0-9]+$/.test(added.download.id || ''), added.ok ? 'id=' + added.download.id : JSON.stringify(added));
  check('serveur /api/add (fichier unique)', added.ok && added.download && /\(1\)/.test(added.download.savePath || ''), (added.download && added.download.savePath) || '');
  const listRes = await fetch('http://127.0.0.1:' + LOCAL_PORT + '/api/list').then((r) => r.json());
  check('serveur /api/list', listRes.ok && Array.isArray(listRes.downloads), 'nb=' + (listRes.downloads || []).length);
  const addMissing = await fetch('http://127.0.0.1:' + LOCAL_PORT + '/api/add').then((r) => r.json());
  check('serveur /api/add sans URL -> rejeté', !addMissing.ok);
  const badRoute = await fetch('http://127.0.0.1:' + LOCAL_PORT + '/api/nope');
  check('serveur route inconnue -> 404', badRoute.status === 404);

  const dlH = await engine.startHlsDownload(base + '/stream/master.m3u8', {});
  check('HLS démarré', dlH.ok, dlH.error || '');
  const finH = await waitDone(dlH.download.id, 30000);
  check('HLS terminé (3 segments assemblés)', !!finH, finH ? 'status=' + finH.status + ' bytes=' + finH.receivedBytes : 'timeout');
  check('HLS sorti en .ts', finH && /\.ts$/.test(finH.savePath || ''), (finH && finH.savePath) || '');

  for (const dl of engine.listDownloads()) engine.removeDownload(dl.id);
  engine.cleanupTempFiles();
  try { fs.rmSync(WORK, { recursive: true }); } catch (_) { /* ignoré */ }

  const failed = results.filter((r) => !r.ok);
  log('\n===== RÉSULTAT : ' + (results.length - failed.length) + '/' + results.length + ' tests OK =====');
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((err) => {
  log('ERREUR FATALE : ' + (err && err.stack ? err.stack : String(err)));
  try { fs.rmSync(WORK, { recursive: true }); } catch (_) { /* ignoré */ }
  process.exit(2);
});