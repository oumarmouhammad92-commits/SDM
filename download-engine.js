'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

let APP_VERSION = '1.2.0';
try { APP_VERSION = require('./package.json').version || APP_VERSION; } catch (_) {}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 SDM/' + APP_VERSION;
const DEFAULT_SEGMENTS = 32;
const MIN_SEGMENTS = 1;
const MAX_SEGMENTS = 64;
const PROGRESS_EMIT_MS = 100;
const CONNECTION_TIMEOUT = 30000;
const SOCKET_TIMEOUT = 60000;
const MAX_RETRIES = 10;
const RETRY_BACKOFF_BASE = 2000;
const RETRY_BACKOFF_MAX = 60000;
const REDIRECT_LIMIT = 10;
const HLS_CONCURRENCY = 32;
const DASH_CONCURRENCY = 32;
const SPEED_SAMPLE_WINDOW = 5000;
const SEGMENT_MIN_SIZE = 256 * 1024;
const SEGMENT_MAX_SIZE = 64 * 1024 * 1024;
const ADAPTIVE_SEGMENT_ADJUST_MS = 3000;
const MAX_TOTAL_ATTEMPTS = 50;
const SEGMENT_ERROR_THRESHOLD = 10;
const RANGE_UNRELIABLE_THRESHOLD = 3;

const CATEGORY_DIRS = { video: 'Vidéo', audio: 'Audio', doc: 'Documents', archive: 'Archives', image: 'Images', app: 'Applications', other: 'Autres' };
const EXT_CATEGORIES = {
  video: ['mp4','mkv','avi','mov','webm','m4v','flv','wmv','mpg','mpeg','3gp','ts','ogv'],
  audio: ['mp3','wav','flac','ogg','m4a','aac','wma','opus','mid','midi'],
  doc: ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','rtf','odt','ods','odp','csv','xml','json','epub','mobi'],
  archive: ['zip','rar','7z','tar','gz','bz2','xz','zst'],
  image: ['jpg','jpeg','png','gif','svg','webp','bmp','ico','tiff','heic','avif'],
  app: ['exe','msi','apk','msix','appx','deb','rpm','dmg','iso','jar','pkg','run'],
};
const RETRYABLE_ERRORS = new Set(['ECONNRESET','ETIMEDOUT','ECONNREFUSED','ENOTFOUND','ENETUNREACH','EHOSTUNREACH','EPIPE','ECONNABORTED','EAI_AGAIN','ERR_SOCKET_TIMED_OUT','ERR_NETWORK','UND_ERR_SOCKET','HTTP429']);
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: MAX_SEGMENTS + 4, maxFreeSockets: 16, timeout: SOCKET_TIMEOUT });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: MAX_SEGMENTS + 4, maxFreeSockets: 16, timeout: SOCKET_TIMEOUT, rejectUnauthorized: true });
const downloads = new Map();
let downloadDir = null;
let downloadsBase = null;
let eventSink = null;
function setEventSink(fn) { eventSink = fn; }
function emit2(type, payload) { if (eventSink) eventSink(type, payload); }
function makeId() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
function backoffDelay(attempt) { return Math.floor(Math.min(RETRY_BACKOFF_BASE * Math.pow(2, attempt) + Math.random() * 1000, RETRY_BACKOFF_MAX)); }
function isRetryableError(err) { if (!err) return false; if (RETRYABLE_ERRORS.has(err.code)) return true; var msg = String(err.message || '').toLowerCase(); return msg.indexOf('reset') >= 0 || msg.indexOf('timeout') >= 0 || msg.indexOf('refused') >= 0 || msg.indexOf('socket') >= 0 || msg.indexOf('network') >= 0 || msg.indexOf('econn') >= 0 || msg.indexOf('premature close') >= 0 || msg.indexOf('aborted') >= 0 || msg.indexOf('429') >= 0 || msg.indexOf('incomplete') >= 0 || msg.indexOf('range') >= 0; }
function fileSize(fp) { try { var st = fs.statSync(fp); return st.isFile() ? st.size : 0; } catch (_) { return 0; } }
function getExtension(fn) { var lower = String(fn || '').toLowerCase(); var idx = lower.lastIndexOf('.'); return idx >= 0 ? lower.slice(idx + 1) : ''; }
function getCategory(fn) { var ext = getExtension(fn); for (var cat in EXT_CATEGORIES) { if (EXT_CATEGORIES[cat].indexOf(ext) >= 0) return cat; } return 'other'; }
function getCategoryLabel(cat) { return CATEGORY_DIRS[cat] || 'Autres'; }
function appDownloads() { return downloadsBase || path.join(require('os').homedir(), 'Downloads'); }
function setDownloadsBase(dir) { downloadsBase = dir; }
function getDownloadDir() { if (downloadDir) return downloadDir; downloadDir = path.join(appDownloads(), 'SDM'); try { fs.mkdirSync(downloadDir, { recursive: true }); } catch (_) {} return downloadDir; }
function setDownloadDir(dir) { downloadDir = dir; try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} }
function getCategoryDir(cat) { var dir = path.join(getDownloadDir(), getCategoryLabel(cat)); try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} return dir; }
function sanitizeFilename(name) { return String(name || 'download').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 200) || 'download'; }
function uniquePath(bp) { if (!fs.existsSync(bp)) return bp; var dir = path.dirname(bp); var ext = path.extname(bp); var stem = path.basename(bp, ext); var i = 1; var candidate; do { candidate = path.join(dir, stem + ' (' + i + ')' + ext); i++; } while (fs.existsSync(candidate) && i < 10000); return candidate; }
function saveMeta(dl) { try { var meta = { id: dl.id, url: dl.url, filename: dl.filename, savePath: dl.savePath, base: dl.base, totalBytes: dl.totalBytes, receivedBytes: dl.receivedBytes, segments: dl.segments ? dl.segments.map(function(s) { return { index: s.index, start: s.start, end: s.end, received: s.received, filePath: s.filePath, done: s.done }; }) : [], status: dl.status, category: dl.category, resumable: dl.resumable, retryCount: dl.retryCount, segmentCount: dl.segmentCount, createdAt: dl.createdAt, updatedAt: Date.now() }; fs.writeFileSync(dl.metaPath, JSON.stringify(meta, null, 2)); } catch (_) {} }
function clearMeta(dl) { try { if (dl.metaPath) fs.unlinkSync(dl.metaPath); } catch (_) {} }
function segPath(bp, idx) { return bp + '.part' + String(idx).padStart(3, '0'); }
function cleanupSegments(dl) { if (!dl.segments) return; dl.segments.forEach(function(s) { try { if (s.filePath) fs.unlinkSync(s.filePath); } catch (_) {} }); }
function sumSegments(dl) { var sum = 0; for (var i = 0; i < dl.segments.length; i++) { var s = dl.segments[i]; if (s.done) sum += (s.end - s.start + 1); else sum += s.received || 0; } return sum; }
function snapshot(dl) { var totalBytes = dl.totalBytes || 0; var receivedBytes = dl.receivedBytes || 0; var elapsed = Date.now() - dl.startedAt; var speed = elapsed > 250 ? (receivedBytes / (elapsed / 1000)) : 0; var segmentsDone = dl.segments ? dl.segments.filter(function(s) { return s.done; }).length : 0; var activeSegments = dl.segments ? dl.segments.filter(function(s) { return !s.done && (s.request || s.stream || s.active); }).length : 0; return { id: dl.id, url: dl.url, filename: dl.filename, savePath: dl.savePath, totalBytes: totalBytes, receivedBytes: receivedBytes, status: dl.status, category: dl.category, error: dl.error || null, speed: speed, segments: dl.segmentCount || 0, segmentsDone: segmentsDone, activeSegments: activeSegments, retryCount: dl.retryCount || 0, resumable: !!dl.resumable, streamType: dl.streamType || null, eta: speed > 0 && totalBytes > 0 ? Math.max(0, Math.round((totalBytes - receivedBytes) / speed)) : null }; }
function filenameFromUrl(url, headers) { var cd = headers && (headers['content-disposition'] || ''); if (cd) { var m = cd.match(/filename\\*=UTF-8''(.+?)(?:;|$)/i); if (m) try { return sanitizeFilename(decodeURIComponent(m[1].trim().replace(/^\"|\"$/g, ''))); } catch (_) {} m = cd.match(/filename\\*=[^']+''(.+?)(?:;|$)/i); if (m) try { return sanitizeFilename(decodeURIComponent(m[1].trim().replace(/^\"|\"$/g, ''))); } catch (_) {} m = cd.match(/filename=\"([^\"]+)\"/i); if (m) return sanitizeFilename(m[1]); m = cd.match(/filename=([^;]+)/i); if (m) return sanitizeFilename(m[1].trim()); } try { var u = new URL(url); var p = u.pathname.split('/').filter(Boolean).pop(); if (p) { var decoded = decodeURIComponent(p); var clean = sanitizeFilename(decoded); if (clean && getExtension(clean)) return clean; if (clean) return clean; } } catch (_) {} return null; }
function resolveUrl(base, ref) { try { return new URL(ref, base).href; } catch (_) { return ref; } }
function computeSegmentCount(total, requested) {
  if (requested) return Math.min(Math.max(requested, MIN_SEGMENTS), MAX_SEGMENTS);
  if (!total || total <= 0) return DEFAULT_SEGMENTS;
  if (total < SEGMENT_MIN_SIZE) return 1;
  var bySize = Math.ceil(total / (4 * 1024 * 1024));
  return Math.min(Math.max(bySize, MIN_SEGMENTS), MAX_SEGMENTS);
}
function computeAdaptiveSegmentCount(total, currentSpeed, activeSegments, currentCount) {
  if (!total || total <= 0 || !currentSpeed || currentSpeed <= 0) return currentCount;
  var remaining = total - (currentSpeed * 30);
  if (remaining <= 0) return currentCount;
  var speedMbps = currentSpeed * 8 / (1024 * 1024);
  var optimalCount = currentCount;
  if (speedMbps > 100) optimalCount = 64;
  else if (speedMbps > 50) optimalCount = 48;
  else if (speedMbps > 25) optimalCount = 32;
  else if (speedMbps > 10) optimalCount = 24;
  else if (speedMbps > 5) optimalCount = 16;
  else if (speedMbps > 2) optimalCount = 8;
  else if (speedMbps > 0.5) optimalCount = 4;
  else optimalCount = 2;
  return Math.min(Math.max(optimalCount, MIN_SEGMENTS), MAX_SEGMENTS);
}
function httpGetWithRetry(url, headers, options) {
  options = options || {};
  var maxRetries = options.maxRetries != null ? options.maxRetries : MAX_RETRIES;
  var timeout = options.timeout || CONNECTION_TIMEOUT;
  return new Promise(function(resolve, reject) {
    var attempt = 0, lastError = null;
    function doRequest() {
      var currentUrl = url, redirectCount = 0;
      function loop() {
        var parsed; try { parsed = new URL(currentUrl); } catch (e) { reject(e); return; }
        var isHttps = parsed.protocol === 'https:';
        var lib = isHttps ? https : http;
        var agent = isHttps ? httpsAgent : httpAgent;
        var reqHeaders = { 'User-Agent': USER_AGENT, 'Accept': '*/*', 'Accept-Encoding': 'gzip, deflate, br', 'Connection': 'keep-alive'};
        if (headers) for (var k in headers) reqHeaders[k] = headers[k];
        if (parsed.hostname.indexOf('github') >= 0) reqHeaders['Accept'] = '*/*';
        var reqOptions = { hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80), path: parsed.pathname + parsed.search, method: 'GET', agent: agent, headers: reqHeaders, timeout: timeout };
        var p = new Promise(function(res, rej) {
          var req = lib.request(reqOptions, function(response) { res(response); });
          req.on('timeout', function() { req.destroy(new Error('Request timeout')); });
          req.on('error', function(err) { rej(err); });
          req.setTimeout(timeout, function() { req.destroy(); });
          req.end();
        });
        p.then(function(response) {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.destroy(); currentUrl = new URL(response.headers.location, currentUrl).href; redirectCount++;
            if (redirectCount <= REDIRECT_LIMIT) loop(); else reject(new Error('Too many redirects'));
            return;
          }
          if (response.statusCode >= 400) { response.destroy(); var err = new Error('HTTP ' + response.statusCode); err.statusCode = response.statusCode; throw err; }
          resolve(response);
        }).catch(function(err) {
          lastError = err;
          if (!isRetryableError(err) || attempt >= maxRetries) { reject(err); return; }
          attempt++;
          var delay = backoffDelay(attempt);
          if (err.statusCode === 429 || (err.message && err.message.indexOf('HTTP 429') >= 0)) {
            delay = Math.max(delay, 10000);
            try { var retryAfter = response.headers['retry-after']; if (retryAfter) delay = Math.max(delay, parseInt(retryAfter, 10) * 1000); } catch (_) {}
          }
          setTimeout(loop, delay);
        });
      }
      loop();
    }
    doRequest();
  });
}
function fetchBuffer(url, referer) {
  return httpGetWithRetry(url, referer ? { 'Referer': referer } : null).then(function(response) {
    return new Promise(function(resolve, reject) {
      var chunks = [], totalSize = 0;
      response.on('data', function(chunk) { chunks.push(chunk); totalSize += chunk.length; });
      response.on('end', function() { resolve(Buffer.concat(chunks, totalSize)); });
      response.on('error', function(err) { reject(err); });
    });
  });
}
function probeUrl(url) {
  var maxRedirects = REDIRECT_LIMIT, currentUrl = url, redirects = 0;
  return new Promise(function(resolve) {
    function loop() {
      if (redirects > maxRedirects) { resolve({ ok: false, error: 'Too many redirects' }); return; }
      var parsed = new URL(currentUrl);
      var isHttps = parsed.protocol === 'https:';
      var lib = isHttps ? https : http;
      var agent = isHttps ? httpsAgent : httpAgent;
      var reqHeaders = { 'User-Agent': USER_AGENT, 'Accept': '*/*', 'Accept-Encoding': 'gzip, deflate, br', 'Connection': 'keep-alive'};
      if (parsed.hostname.indexOf('github') >= 0) reqHeaders['Accept'] = '*/*';
      var reqOptions = { hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80), path: parsed.pathname + parsed.search, method: 'HEAD', agent: agent, headers: reqHeaders, timeout: CONNECTION_TIMEOUT };
      var p = new Promise(function(res, rej) {
        var req = lib.request(reqOptions, function(response) { res(response); });
        req.on('timeout', function() { req.destroy(new Error('HEAD timeout')); });
        req.on('error', function(err) { rej(err); });
        req.setTimeout(CONNECTION_TIMEOUT, function() { req.destroy(); });
        req.end();
      });
      p.then(function(response) {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.destroy(); currentUrl = new URL(response.headers.location, currentUrl).href; redirects++; loop(); return;
        }
        var headers = {};
        for (var k in response.headers) headers[k.toLowerCase()] = response.headers[k];
        resolve({ ok: response.statusCode < 400, statusCode: response.statusCode, headers: headers, finalUrl: currentUrl });
        response.destroy();
      }).catch(function() { resolve({ ok: false, error: 'probe failed' }); });
    }
    loop();
  });
}
function probeGetRange(url) {
  return httpGetWithRetry(url, { 'Range': 'bytes=0-0' }).then(function(response) {
    var headers = {};
    for (var k in response.headers) headers[k.toLowerCase()] = response.headers[k];
    response.destroy();
    var cr = headers['content-range'] || '';
    var m = cr.match(/\/(\d+)$/);
    var size = m ? parseInt(m[1], 10) : 0;
    return { ok: true, size: size, resumable: true, contentType: headers['content-type'] || '', contentDisposition: headers['content-disposition'] || '', finalUrl: url };
  }).catch(function(err) { return { ok: false, error: err.message }; });
}
function assembleSegments(dl) {
  return new Promise(function(resolve, reject) {
    var ws = fs.createWriteStream(dl.savePath);
    ws.on('error', function(err) { reject(err); });
    ws.on('finish', function() { resolve(); });
    var i = 0;
    function writeNext() {
      if (i >= dl.segments.length) { ws.end(); return; }
      var seg = dl.segments[i++];
      if (!seg.done || !fs.existsSync(seg.filePath)) { ws.end(); reject(new Error('Segment ' + seg.index + ' manquant')); return; }
      var rs = fs.createReadStream(seg.filePath);
      rs.on('error', function(err) { ws.destroy(); reject(err); });
      rs.on('end', function() { try { fs.unlinkSync(seg.filePath); } catch (_) {} writeNext(); });
      rs.pipe(ws, { end: false });
    }
    writeNext();
  });
}
function maybeComplete(dl) {
  var allDone = dl.segments && dl.segments.every(function(s) { return s.done; });
  if (!allDone) return;
  if (dl.status === 'downloading' || dl.status === 'pausing') {
    dl.status = 'assembling';
    emit2('status', snapshot(dl));
    assembleSegments(dl).then(function() {
      if (dl.status === 'assembling') {
        dl.status = 'completed';
        dl.receivedBytes = dl.totalBytes || fileSize(dl.savePath);
        dl.completedAt = Date.now();
        clearMeta(dl);
        cleanupSegments(dl);
        emit2('status', snapshot(dl));
        downloads.delete(dl.id);
      }
    }).catch(function(err) { if (dl.status === 'assembling') fail(dl, 'Assembly failed: ' + err.message); });
  }
}
function fail(dl, message) {
  dl.status = 'error';
  dl.error = message || 'Unknown error';
  dl.failedAt = Date.now();
  saveMeta(dl);
  cleanupSegments(dl);
  emit2('status', snapshot(dl));
  downloads.delete(dl.id);
}
function downloadSegment(dl, seg, onProgress) {
  seg.retryCount = seg.retryCount || 0;
  seg.totalAttempts = seg.totalAttempts || 0;
  var expectedSize = seg.end - seg.start + 1;
  var attempt = 0;
  function tryDownload() {
    if (dl.pauseRequested || dl.status !== 'downloading') return Promise.resolve();
    attempt++;
    seg.totalAttempts++;
    dl.totalAttempts = (dl.totalAttempts || 0) + 1;
    if (dl.totalAttempts > MAX_TOTAL_ATTEMPTS && dl.segmentErrors > SEGMENT_ERROR_THRESHOLD) {
      throw new Error('MAX_ATTEMPTS_EXHAUSTED');
    }
    var existingSize = fileSize(seg.filePath);
    if (existingSize > 0 && existingSize < expectedSize) {
      seg.received = existingSize;
      seg.start = seg.start + existingSize;
    } else if (existingSize >= expectedSize) {
      seg.done = true;
      seg.received = existingSize;
      return Promise.resolve();
    }
    var rangeHeader = 'bytes=' + seg.start + '-' + seg.end;
    return httpGetWithRetry(dl.url, { 'Range': rangeHeader }, { maxRetries: MAX_RETRIES, timeout: CONNECTION_TIMEOUT + seg.index * 100 }).then(function(response) {
      return new Promise(function(resolve, reject) {
        var ws = fs.createWriteStream(seg.filePath, { flags: 'a' });
        var received = 0;
        var emitThrottle = 0;
        ws.on('error', function(err) { try { ws.destroy(); } catch (_) {} reject(err); });
        ws.on('finish', function() { resolve(); });
        response.on('data', function(chunk) {
          received += chunk.length;
          seg.received = seg.received + chunk.length;
          var now = Date.now();
          if (now - emitThrottle >= 50) { emitThrottle = now; if (onProgress) onProgress(seg.received); }
        });
        response.on('end', function() { ws.end(); });
        response.on('error', function(err) { try { ws.destroy(); } catch (_) {} reject(err); });
      });
    }).then(function() {
      var actualSize = fileSize(seg.filePath);
      if (actualSize >= expectedSize + (seg.start - seg.start)) {
        seg.done = true;
        seg.received = actualSize;
        return;
      }
      throw new Error('INCOMPLETE_RETRY');
    }).catch(function(err) {
      if (dl.pauseRequested || dl.status !== 'downloading') return Promise.resolve();
      seg.retryCount++;
      dl.segmentErrors = (dl.segmentErrors || 0) + 1;
      if (err.message && err.message.indexOf('INCOMPLETE_RETRY') >= 0 && seg.retryCount < MAX_RETRIES) {
        return sleep(backoffDelay(seg.retryCount)).then(tryDownload);
      }
      if (isRetryableError(err) && seg.retryCount < MAX_RETRIES) {
        return sleep(backoffDelay(seg.retryCount)).then(tryDownload);
      }
      throw err;
    });
  }
  return tryDownload();
}
function startDownload(url, options) {
  options = options || {};
  if (!url || !/^https?:/i.test(url)) return { ok: false, error: 'Invalid URL' };
  var id = makeId();
  var dl = { id: id, url: url, filename: null, savePath: null, base: null, metaPath: null, totalBytes: 0, receivedBytes: 0, status: 'starting', category: 'other', error: null, segments: [], segmentCount: 0, retryCount: 0, resumable: false, streamType: null, pauseRequested: false, startedAt: Date.now(), lastEmit: 0, request: null, stream: null, segmentErrors: 0, totalAttempts: 0, rangeUnreliableCount: 0, currentSegCount: 0 };
  downloads.set(id, dl);
  emit2('status', snapshot(dl));

  setTimeout(function() {
    probeUrl(dl.url).then(function(probe) {
      if (!probe.ok) { fail(dl, 'Probe failed: ' + (probe.error || probe.statusCode)); return; }
      dl.url = probe.finalUrl;
      var ct = (probe.headers['content-type'] || '').toLowerCase();
      if (ct.indexOf('application/dash') >= 0 || ct.indexOf('application/hls') >= 0 || ct.indexOf('video/mp2t') >= 0) { fail(dl, 'Use startDownloadSmart for streaming formats'); return; }
      var rangeProbe = probeGetRange(probe.finalUrl);
      return rangeProbe.then(function(rangeResult) {
        var filename = filenameFromUrl(probe.finalUrl, probe.headers) || 'download_' + id.slice(0, 8);
        var category = getCategory(filename);
        var catDir = getCategoryDir(category);
        var base = path.join(catDir, filename);
        var savePath = uniquePath(base);
        var finalName = path.basename(savePath);
        dl.filename = finalName;
        dl.savePath = savePath;
        dl.base = savePath;
        dl.metaPath = savePath + '.part.meta.json';
        dl.category = category;
        if (rangeResult.ok && rangeResult.size > 0) {
          dl.totalBytes = rangeResult.size;
          dl.resumable = true;
          dl.streamType = 'direct';
          var segCount = computeSegmentCount(rangeResult.size, options.segments);
          dl.currentSegCount = segCount;
          buildSegments(dl, segCount);
        } else {
          dl.resumable = false;
          dl.streamType = 'direct';
          dl.segments = [];
          dl.segmentCount = 0;
        }
        saveMeta(dl);
        dl.status = 'downloading';
        dl.lastEmit = 0;
        emit2('status', snapshot(dl));
        if (dl.resumable && dl.segments.length > 0) {
          startSegmentWorkers(dl);
        } else {
          directDownload(dl);
        }
      });
    }).catch(function(err) {
      if (dl.status === 'starting' || dl.status === 'downloading') fail(dl, (err && err.message) || 'Download error');
    });
  }, 0);
  return { ok: true, download: snapshot(dl) };
}

function buildSegments(dl, segCount) {
  var segSize = Math.floor(dl.totalBytes / segCount);
  var segments = [];
  for (var i = 0; i < segCount; i++) {
    var start = i * segSize;
    var end = (i === segCount - 1) ? dl.totalBytes - 1 : start + segSize - 1;
    segments.push({ index: i, start: start, end: end, received: 0, filePath: segPath(dl.savePath, i), done: false, active: false, stream: null, request: null, retryCount: 0, totalAttempts: 0 });
  }
  dl.segments = segments;
  dl.segmentCount = segCount;
}

function startSegmentWorkers(dl) {
  var workers = [];
  var workerCount = Math.min(dl.segments.length, MAX_SEGMENTS);
  for (var w = 0; w < workerCount; w++) {
    workers.push((function() {
      function next() {
        if (dl.pauseRequested || dl.status !== 'downloading') return Promise.resolve();
        var seg = null;
        for (var i = 0; i < dl.segments.length; i++) { if (!dl.segments[i].done && !dl.segments[i].active) { seg = dl.segments[i]; break; } }
        if (!seg) { if (dl.segments.every(function(s) { return s.done; })) return Promise.resolve(); return sleep(200).then(next); }
        seg.active = true;
        return downloadSegment(dl, seg, function(bytes) {
          dl.receivedBytes = sumSegments(dl);
          var now = Date.now();
          if (now - dl.lastEmit >= PROGRESS_EMIT_MS) { dl.lastEmit = now; emit2('progress', snapshot(dl)); }
        }).then(function() { seg.active = false; return next(); }).catch(function(err) {
          seg.active = false;
          if (dl.pauseRequested || dl.status !== 'downloading') return;
          dl.segmentErrors = (dl.segmentErrors || 0) + 1;
          dl.rangeUnreliableCount = (dl.rangeUnreliableCount || 0) + 1;
          if (err.message === 'MAX_ATTEMPTS_EXHAUSTED' || dl.totalAttempts > MAX_TOTAL_ATTEMPTS) {
            if (dl.currentSegCount > 1 && dl.rangeUnreliableCount >= RANGE_UNRELIABLE_THRESHOLD) {
              dl.rangeUnreliableCount = 0;
              var newCount = Math.max(1, Math.floor(dl.currentSegCount / 2));
              if (newCount < dl.currentSegCount) {
                dl.currentSegCount = newCount;
                cleanupSegments(dl);
                buildSegments(dl, newCount);
                saveMeta(dl);
                emit2('status', snapshot(dl));
                return startSegmentWorkers(dl);
              }
            }
            if (dl.currentSegCount > 1) {
              dl.currentSegCount = 1;
              cleanupSegments(dl);
              buildSegments(dl, 1);
              saveMeta(dl);
              emit2('status', snapshot(dl));
              return startSegmentWorkers(dl);
            }
            fail(dl, 'MAX_ATTEMPTS_EXHAUSTED: ' + err.message);
            return;
          }
          return sleep(500).then(next);
        });
      }
      return next();
    })());
  }
  Promise.all(workers).then(function() { if (dl.status === 'downloading') maybeComplete(dl); });
}
function directDownload(dl) {
  dl.status = 'downloading';
  dl.resumable = false;
  var baseName = dl.filename || ('download_' + dl.id.slice(0, 8));
  var catDir = getCategoryDir(dl.category || 'other');
  var base = path.join(catDir, baseName);
  dl.base = base;
  dl.savePath = uniquePath(base);
  dl.filename = path.basename(dl.savePath);
  dl.metaPath = dl.savePath + '.part.meta.json';
  saveMeta(dl);
  emit2('status', snapshot(dl));
  var attempt = 0;
  function tryDirect() {
    if (dl.pauseRequested || dl.status !== 'downloading') return;
    return httpGetWithRetry(dl.url, {}, { maxRetries: MAX_RETRIES }).then(function(response) {
      return new Promise(function(resolve, reject) {
        var ws = fs.createWriteStream(dl.savePath);
        var received = 0;
        ws.on('error', function(err) { ws.destroy(); reject(err); });
        ws.on('finish', function() { resolve(); });
        response.on('data', function(chunk) { received += chunk.length; dl.receivedBytes = received; dl.totalBytes = received; var now = Date.now(); if (now - dl.lastEmit >= PROGRESS_EMIT_MS) { dl.lastEmit = now; emit2('progress', snapshot(dl)); } });
        response.on('end', function() { ws.end(); });
        response.on('error', function(err) { ws.destroy(); reject(err); });
      });
    }).then(function() {
      if (dl.status === 'downloading') { dl.status = 'completed'; dl.receivedBytes = fileSize(dl.savePath); dl.completedAt = Date.now(); clearMeta(dl); emit2('status', snapshot(dl)); downloads.delete(dl.id); }
    }).catch(function(err) {
      if (dl.pauseRequested || dl.status !== 'downloading') return;
      if (!isRetryableError(err) && attempt >= MAX_RETRIES) { fail(dl, (err && err.message) || 'Download error'); return; }
      attempt++; dl.retryCount = (dl.retryCount || 0) + 1;
      emit2('status', snapshot(dl));
      return sleep(backoffDelay(Math.min(attempt, 5))).then(tryDirect);
    });
  }
  tryDirect();
}
function pauseDownload(id) {
  var dl = downloads.get(id);
  if (!dl) return { ok: false, error: 'Not found' };
  if (dl.status !== 'downloading' && dl.status !== 'starting') return { ok: false, error: 'Not downloading' };
  dl.pauseRequested = true;
  dl.status = 'pausing';
  emit2('status', snapshot(dl));
  dl.segments.forEach(function(s) { try { if (s.request) s.request.destroy(); } catch (_) {} try { if (s.stream) s.stream.destroy(); } catch (_) {} });
  dl.status = 'paused';
  dl.receivedBytes = sumSegments(dl);
  saveMeta(dl);
  emit2('status', snapshot(dl));
  return { ok: true, download: snapshot(dl) };
}
function resumeDownload(id) {
  var dl = downloads.get(id);
  if (!dl) return { ok: false, error: 'Not found' };
  if (dl.status !== 'paused') return { ok: false, error: 'Not paused' };
  dl.segments.forEach(function(s) {
    if (s.done) { var sz = fileSize(s.filePath); var expected = s.end - s.start + 1; if (sz !== expected) { s.done = false; s.received = 0; try { fs.unlinkSync(s.filePath); } catch (_) {} } }
  });
  dl.pauseRequested = false;
  dl.status = 'downloading';
  dl.retryCount = 0;
  dl.segmentErrors = 0;
  saveMeta(dl);
  emit2('status', snapshot(dl));
  var remaining = dl.segments.filter(function(s) { return !s.done; });
  if (remaining.length === 0) { maybeComplete(dl); return { ok: true, download: snapshot(dl) }; }
  var workers = [];
  var workerCount = Math.min(remaining.length, MAX_SEGMENTS);
  for (var w = 0; w < workerCount; w++) {
    workers.push((function() {
      function next() {
        if (dl.pauseRequested || dl.status !== 'downloading') return Promise.resolve();
        var seg = null;
        for (var i = 0; i < remaining.length; i++) { if (!remaining[i].done && !remaining[i].active) { seg = remaining[i]; break; } }
        if (!seg) { if (remaining.every(function(s) { return s.done; })) return Promise.resolve(); return sleep(200).then(next); }
        seg.active = true;
        return downloadSegment(dl, seg, function() {
          dl.receivedBytes = sumSegments(dl);
          var now = Date.now();
          if (now - dl.lastEmit >= PROGRESS_EMIT_MS) { dl.lastEmit = now; emit2('progress', snapshot(dl)); }
        }).then(function() { seg.active = false; return next(); }).catch(function(err) {
          seg.active = false;
          if (dl.pauseRequested || dl.status !== 'downloading') return;
          dl.segmentErrors = (dl.segmentErrors || 0) + 1;
          if (dl.segmentErrors > dl.segments.length) { fail(dl, 'Resume failed: ' + err.message); return; }
          return next();
        });
      }
      return next();
    })());
  }
  Promise.all(workers.map(function(f) { return f(); })).then(function() { if (dl.status === 'downloading') maybeComplete(dl); });
  return { ok: true, download: snapshot(dl) };
}
function removeDownload(id) {
  var dl = downloads.get(id);
  if (!dl) return { ok: false, error: 'Not found' };
  dl.pauseRequested = true;
  cleanupSegments(dl);
  clearMeta(dl);
  downloads.delete(id);
  emit2('removed', { id: id });
  return { ok: true };
}
function listDownloads() {
  var list = [];
  downloads.forEach(function(dl) { list.push(snapshot(dl)); });
  list.sort(function(a, b) { return b.createdAt - a.createdAt; });
  return list;
}
function scanPendingDownloads() {
  var dir = getDownloadDir();
  var files = []; try { files = fs.readdirSync(dir); } catch (_) {}
  files.forEach(function(f) {
    if (f.endsWith('.part.meta.json')) {
      var metaPath = path.join(dir, f);
      try {
        var raw = fs.readFileSync(metaPath, 'utf8');
        var meta = JSON.parse(raw);
        if (meta.status === 'paused' || meta.status === 'downloading') {
          var dl = { id: meta.id, url: meta.url, filename: meta.filename, savePath: meta.savePath, base: meta.base, metaPath: metaPath, totalBytes: meta.totalBytes || 0, receivedBytes: meta.receivedBytes || 0, status: 'paused', category: meta.category || 'other', error: null, segments: (meta.segments || []).map(function(s) { return Object.assign(s, { request: null, stream: null, active: false }); }), segmentCount: meta.segmentCount || 0, retryCount: meta.retryCount || 0, resumable: !!meta.resumable, streamType: null, pauseRequested: false, startedAt: meta.createdAt || Date.now(), lastEmit: 0, request: null, stream: null, segmentErrors: 0 };
          dl.segments.forEach(function(s) { var sz = fileSize(s.filePath); var expected = s.end - s.start + 1; if (s.done && sz !== expected) { s.done = false; s.received = 0; try { fs.unlinkSync(s.filePath); } catch (_) {} } });
          dl.receivedBytes = sumSegments(dl);
          downloads.set(dl.id, dl);
          emit2('status', snapshot(dl));
        }
      } catch (_) {}
    }
  });
}
function cleanupTempFiles() {
  var dir = getDownloadDir();
  var files = []; try { files = fs.readdirSync(dir); } catch (_) {}
  var now = Date.now(), oneWeek = 7 * 24 * 60 * 60 * 1000;
  files.forEach(function(f) {
    if (f.endsWith('.part') || f.endsWith('.part.meta.json')) {
      var fp = path.join(dir, f);
      try { var st = fs.statSync(fp); if (now - st.mtimeMs > oneWeek) fs.unlinkSync(fp); } catch (_) {}
    }
  });
}
function isHlsUrl(url) { var m = String(url).toLowerCase(); return m.indexOf('.m3u8') >= 0 || m.indexOf('/hls/') >= 0 || m.indexOf('m3u8?') >= 0; }
function isDashUrl(url) { var m = String(url).toLowerCase(); return m.indexOf('.mpd') >= 0 || m.indexOf('/dash/') >= 0 || m.indexOf('mpd?') >= 0; }
function isStreamUrl(url) { return isHlsUrl(url) || isDashUrl(url); }
function parseHlsManifest(text) {
  var lines = text.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean);
  var segments = [], streamInfos = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.startsWith('#EXTINF:')) { var next = lines[i + 1]; if (next && !next.startsWith('#')) { segments.push(next); i++; } }
    else if (line.startsWith('#EXT-X-STREAM-INF:')) { var next2 = lines[i + 1]; if (next2 && !next2.startsWith('#')) { streamInfos.push({ url: next2 }); i++; } }
    else if (!line.startsWith('#') && /\.(ts|aac|mp4|m4s|m4v|m4a|webm|ogg|mp3)/i.test(line)) segments.push(line);
  }
  if (streamInfos.length > 0 && segments.length === 0) return [{ __master: true, url: streamInfos[0].url }];
  return segments;
}
function parseDashManifest(xml) {
  var segments = [];
  var segMatch = xml.match(/<SegmentURL[^>]*media=\"([^\"]+)\"/gi);
  if (segMatch) { segMatch.forEach(function(m) { var um = m.match(/media=\"([^\"]+)\"/i); if (um) segments.push(um[1]); }); }
  var segListMatch = xml.match(/<SegmentList[^>]*>([\s\S]*?)<\/SegmentList>/i);
  if (segListMatch) { var urls = segListMatch[1].match(/media=\"([^\"]+)\"/gi); if (urls) { urls.forEach(function(m) { var um = m.match(/media=\"([^\"]+)\"/i); if (um && segments.indexOf(um[1]) < 0) segments.push(um[1]); }); } }
  var baseMatch = xml.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i);
  if (baseMatch && segments.length > 0) { var base = baseMatch[1].trim(); if (base.startsWith('http')) { segments.forEach(function(s, idx) { if (!s.startsWith('http')) segments[idx] = new URL(s, base).href; }); } }
  return segments;
}
function startHlsDownload(url, options) {
  options = options || {};
  if (!url || !/^https?:/i.test(url)) return { ok: false, error: 'Invalid URL' };
  var id = makeId();
  var dl = { id: id, url: url, filename: null, savePath: null, base: null, metaPath: null, totalBytes: 0, receivedBytes: 0, status: 'starting', category: 'video', error: null, segments: [], segmentCount: 0, retryCount: 0, resumable: false, streamType: 'hls', pauseRequested: false, startedAt: Date.now(), lastEmit: 0, request: null, stream: null, segmentErrors: 0 };
  downloads.set(id, dl);
  emit2('status', snapshot(dl));
  setTimeout(function() {
    fetchBuffer(url, url).then(function(manifest) {
      var text = manifest.toString('utf8');
      var segmentRefs = parseHlsManifest(text);
      if (segmentRefs.length === 1 && segmentRefs[0].__master) {
        return fetchBuffer(segmentRefs[0].url, url).then(function(masterManifest) {
          var mt = masterManifest.toString('utf8');
          var combined = parseHlsManifest(text + '\n' + mt);
          segmentRefs = (combined.length > 0 && !(combined.length === 1 && combined[0].__master)) ? combined : parseHlsManifest(mt);
          if (segmentRefs.length === 0) { var tsMatches = text.match(/https?:\/\/[^\s\"']+\.ts[^\s\"']*/gi); if (tsMatches && tsMatches.length > 0) segmentRefs = tsMatches; }
          return continueHls();
        });
      }
      return continueHls();
      function continueHls() {
        if (segmentRefs.length === 0) throw new Error('No HLS segments found');
        var baseName = path.basename(url.split('#')[0].split('?')[0]).replace(/\.m3u8$/i, '') || 'stream';
        dl.filename = sanitizeFilename(baseName + '.ts');
        var catDir = getCategoryDir('video');
        dl.base = path.join(catDir, dl.filename);
        dl.savePath = uniquePath(dl.base);
        dl.filename = path.basename(dl.savePath);
        dl.base = dl.savePath;
        dl.metaPath = dl.base + '.part.meta.json';
        dl.segments = segmentRefs.map(function(ref, i) { return { index: i, url: resolveUrl(url, ref), start: 0, end: 0, received: 0, filePath: segPath(dl.base, i), done: false, active: false, stream: null, request: null }; });
        dl.segmentCount = dl.segments.length;
        dl.status = 'downloading';
        dl.lastEmit = 0;
        saveMeta(dl);
        emit2('status', snapshot(dl));
        var worker = function() {
          function next() {
            if (dl.pauseRequested || dl.status !== 'downloading') return Promise.resolve();
            var seg = null;
            for (var i = 0; i < dl.segments.length; i++) { if (!dl.segments[i].done && !dl.segments[i].active) { seg = dl.segments[i]; break; } }
            if (!seg) { if (dl.segments.every(function(s) { return s.done; })) return Promise.resolve(); return sleep(200).then(next); }
            seg.active = true;
            var attempt = 0;
            function fetchSeg() {
              if (dl.pauseRequested || dl.status !== 'downloading') return Promise.resolve();
              return fetchBuffer(seg.url, dl.url).then(function(buf) {
                if (dl.pauseRequested || dl.status !== 'downloading') return;
                fs.writeFileSync(seg.filePath, buf);
                seg.received = buf.length;
                dl.receivedBytes = sumSegments(dl);
                var now = Date.now();
                if (now - dl.lastEmit >= PROGRESS_EMIT_MS) { dl.lastEmit = now; emit2('progress', snapshot(dl)); }
              }).catch(function(err) {
                attempt++;
                if (attempt >= 3 || !isRetryableError(err)) throw err;
                return sleep(backoffDelay(attempt)).then(fetchSeg);
              });
            }
            return fetchSeg().then(function() { seg.done = true; seg.active = false; return next(); }).catch(function(err) {
              seg.active = false;
              if (dl.pauseRequested || dl.status !== 'downloading') return;
              dl.segmentErrors = (dl.segmentErrors || 0) + 1;
              if (dl.segmentErrors >= 3) { fail(dl, 'HLS failed: ' + err.message); return; }
              return next();
            });
          }
          return next();
        };
        var workers = [];
        var concurrency = Math.min(HLS_CONCURRENCY, dl.segments.length);
        for (var i = 0; i < concurrency; i++) workers.push(worker());
        Promise.all(workers).then(function() {
          if (dl.status === 'downloading') {
            dl.totalBytes = dl.receivedBytes > 0 ? dl.receivedBytes : dl.totalBytes;
            dl.segments.forEach(function(s) { s.done = true; });
            saveMeta(dl);
            maybeComplete(dl);
          }
        });
      }
    }).catch(function(err) {
      if (dl.status === 'downloading' || dl.status === 'starting') fail(dl, (err && err.message) || 'HLS error');
    });
  }, 0);
  return { ok: true, download: snapshot(dl) };
}
function startDashDownload(url, options) {
  options = options || {};
  if (!url || !/^https?:/i.test(url)) return { ok: false, error: 'Invalid URL' };
  var id = makeId();
  var dl = { id: id, url: url, filename: null, savePath: null, base: null, metaPath: null, totalBytes: 0, receivedBytes: 0, status: 'starting', category: 'video', error: null, segments: [], segmentCount: 0, retryCount: 0, resumable: false, streamType: 'dash', pauseRequested: false, startedAt: Date.now(), lastEmit: 0, request: null, stream: null, segmentErrors: 0 };
  downloads.set(id, dl);
  emit2('status', snapshot(dl));
  setTimeout(function() {
    fetchBuffer(url, url).then(function(manifest) {
      var text = manifest.toString('utf8');
      var segmentRefs = parseDashManifest(text);
      if (segmentRefs.length === 0) {
        var segMatches = text.match(/https?:\/\/[^\s\"']+\.(m4s|mp4|webm|ts|aac)[^\s\"']*/gi);
        if (segMatches && segMatches.length > 0) { segMatches.forEach(function(m) { if (segmentRefs.indexOf(m) < 0) segmentRefs.push(m); }); }
      }
      if (segmentRefs.length === 0) throw new Error('No DASH segments found');
      var baseName = path.basename(url.split('#')[0].split('?')[0]).replace(/\.mpd$/i, '') || 'dash';
      dl.filename = sanitizeFilename(baseName + '.mp4');
      var catDir = getCategoryDir('video');
      dl.base = path.join(catDir, dl.filename);
      dl.savePath = uniquePath(dl.base);
      dl.filename = path.basename(dl.savePath);
      dl.base = dl.savePath;
      dl.metaPath = dl.base + '.part.meta.json';
      dl.segments = segmentRefs.map(function(ref, i) { return { index: i, url: resolveUrl(url, ref), start: 0, end: 0, received: 0, filePath: segPath(dl.base, i), done: false, active: false, stream: null, request: null }; });
      dl.segmentCount = dl.segments.length;
      dl.status = 'downloading';
      dl.lastEmit = 0;
      saveMeta(dl);
      emit2('status', snapshot(dl));
      var worker = function() {
        function next() {
          if (dl.pauseRequested || dl.status !== 'downloading') return Promise.resolve();
          var seg = null;
          for (var i = 0; i < dl.segments.length; i++) { if (!dl.segments[i].done && !dl.segments[i].active) { seg = dl.segments[i]; break; } }
          if (!seg) { if (dl.segments.every(function(s) { return s.done; })) return Promise.resolve(); return sleep(200).then(next); }
          seg.active = true;
          var attempt = 0;
          function fetchSeg() {
            if (dl.pauseRequested || dl.status !== 'downloading') return Promise.resolve();
            return fetchBuffer(seg.url, dl.url).then(function(buf) {
              if (dl.pauseRequested || dl.status !== 'downloading') return;
              fs.writeFileSync(seg.filePath, buf);
              seg.received = buf.length;
              dl.receivedBytes = sumSegments(dl);
              var now = Date.now();
              if (now - dl.lastEmit >= PROGRESS_EMIT_MS) { dl.lastEmit = now; emit2('progress', snapshot(dl)); }
            }).catch(function(err) {
              attempt++;
              if (attempt >= 3 || !isRetryableError(err)) throw err;
              return sleep(backoffDelay(attempt)).then(fetchSeg);
            });
          }
          return fetchSeg().then(function() { seg.done = true; seg.active = false; return next(); }).catch(function(err) {
            seg.active = false;
            if (dl.pauseRequested || dl.status !== 'downloading') return;
            dl.segmentErrors = (dl.segmentErrors || 0) + 1;
            if (dl.segmentErrors >= 3) { fail(dl, 'DASH failed: ' + err.message); return; }
            return next();
          });
        }
        return next();
      };
      var workers = [];
      var concurrency = Math.min(DASH_CONCURRENCY, dl.segments.length);
      for (var i = 0; i < concurrency; i++) workers.push(worker());
      Promise.all(workers).then(function() {
        if (dl.status === 'downloading') {
          dl.totalBytes = dl.receivedBytes > 0 ? dl.receivedBytes : dl.totalBytes;
          dl.segments.forEach(function(s) { s.done = true; });
          saveMeta(dl);
          maybeComplete(dl);
        }
      });
    }).catch(function(err) {
      if (dl.status === 'downloading' || dl.status === 'starting') fail(dl, (err && err.message) || 'DASH error');
    });
  }, 0);
  return { ok: true, download: snapshot(dl) };
}
function startDownloadSmart(url, options) {
  if (isHlsUrl(url)) return startHlsDownload(url, options || {});
  if (isDashUrl(url)) return startDashDownload(url, options || {});
  return startDownload(url, options);
}

module.exports = {
  startDownload: startDownload,
  startDownloadSmart: startDownloadSmart,
  startHlsDownload: startHlsDownload,
  startDashDownload: startDashDownload,
  isHlsUrl: isHlsUrl,
  isDashUrl: isDashUrl,
  isStreamUrl: isStreamUrl,
  pauseDownload: pauseDownload,
  resumeDownload: resumeDownload,
  removeDownload: removeDownload,
  listDownloads: listDownloads,
  getDownloadDir: getDownloadDir,
  setDownloadDir: setDownloadDir,
  setDownloadsBase: setDownloadsBase,
  getCategory: getCategory,
  getCategoryLabel: getCategoryLabel,
  scanPendingDownloads: scanPendingDownloads,
  cleanupTempFiles: cleanupTempFiles,
  setEventSink: setEventSink,
};
