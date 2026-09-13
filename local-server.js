// ============================================================================
// SDM - Sekou Download Manager
// Serveur HTTP local (127.0.0.1:26545) : reçoit les liens envoyés par
// l'extension navigateur (Chrome, Edge, Brave, Firefox).
// CORS activé pour autoriser les pages d'extension (chrome-extension://…).
// ============================================================================

'use strict';

const http = require('http');

let APP_VERSION = '1.0.0';
try {
  APP_VERSION = require('./package.json').version || APP_VERSION;
} catch (_) { /* ignoré */ }

const DEFAULT_PORT = 26545;

function startServer(engine, options) {
  const port = (options && options.port) || DEFAULT_PORT;
  const onStatus = options && options.onStatus;

  const server = http.createServer((req, res) => {
    // ---- En-têtes CORS (visible par l'extension) ----
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let parsed;
    try { parsed = new URL(req.url, 'http://127.0.0.1:' + port); } catch (_) {
      sendJson(res, 400, { ok: false, error: 'Requête invalide' });
      return;
    }

    if (parsed.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, name: 'SDM', version: APP_VERSION });
      return;
    }

    if (parsed.pathname === '/api/add') {
      handleAdd(engine, req, res, parsed);
      return;
    }

    if (parsed.pathname === '/api/list') {
      sendJson(res, 200, { ok: true, downloads: engine.listDownloads() });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Point de terminaison inconnu' });
  });

  server.on('error', (err) => {
    if (onStatus) onStatus(false, err && err.code === 'EADDRINUSE'
      ? 'Port ' + port + ' déjà utilisé (une autre instance de SDM est peut-être ouverte)'
      : (err && err.message) || 'Erreur inconnue');
  });

  server.listen(port, '127.0.0.1', () => {
    if (onStatus) onStatus(true, port);
  });

  return server;
}

// Délègue au moteur : flux HLS (.m3u8) ou téléchargement classique multi-segments.
// Toujours renvoie une Promesse (startDownload est async).
function startFromEngine(engine, url, connections) {
  const opts = connections ? { connections } : {};
  if (engine.isHlsUrl(url)) return Promise.resolve(engine.startHlsDownload(url, opts));
  return engine.startDownload(url, opts);
}

function respondFrom(engine, url, connections, res) {
  startFromEngine(engine, url, connections)
    .then((result) => {
      if (result && result.ok) {
        sendJson(res, 200, { ok: true, download: result.download });
      } else {
        sendJson(res, 400, { ok: false, error: (result && result.error) || "Impossible de démarrer le téléchargement" });
      }
    })
    .catch((err) => {
      sendJson(res, 500, { ok: false, error: (err && err.message) || 'Erreur interne' });
    });
}

function handleAdd(engine, req, res, parsed) {
  if (req.method === 'GET') {
    const url = parsed.searchParams.get('url');
    const connections = parseInt(parsed.searchParams.get('connections') || '0', 10) || 0;
    if (!url) return sendJson(res, 400, { ok: false, error: 'Paramètre « url » manquant' });
    respondFrom(engine, url, connections, res);
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1000000) req.destroy();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        respondFrom(engine, data.url, data.connections, res);
      } catch (_) {
        sendJson(res, 400, { ok: false, error: 'Corps JSON invalide' });
      }
    });
    return;
  }

  sendJson(res, 405, { ok: false, error: 'Méthode non autorisée' });
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

module.exports = { startServer, DEFAULT_PORT };