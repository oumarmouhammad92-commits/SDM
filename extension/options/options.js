// SDM - extension : options
'use strict';

const api = (typeof browser !== 'undefined') ? browser : chrome;

function sendMessage(type, data) {
  const payload = Object.assign({ type: type }, data || {});
  return new Promise(function (resolve) {
    if (typeof browser !== 'undefined') {
      browser.runtime.sendMessage(payload)
        .then(resolve)
        .catch(function (e) { resolve({ ok: false, error: e && e.message }); });
      return;
    }
    chrome.runtime.sendMessage(payload, function (res) {
      const err = chrome.runtime.lastError;
      resolve(err ? { ok: false, error: err.message } : res);
    });
  });
}

const $ = function (id) { return document.getElementById(id); };

async function load() {
  const res = await sendMessage('getSettings');
  const s = (res && res.settings) || {};
  $('host').value = s.host || 'http://127.0.0.1:26545';
  $('intercept').checked = s.interceptDownloads !== false;
  $('detectLinks').checked = s.detectLinks !== false;
  $('detectVideo').checked = !!s.detectVideo;
  $('connections').value = String(s.connections || 0);
}

async function save() {
  const settings = {
    host: ($('host').value || 'http://127.0.0.1:26545').trim(),
    interceptDownloads: $('intercept').checked,
    detectLinks: $('detectLinks').checked,
    detectVideo: $('detectVideo').checked,
    connections: parseInt($('connections').value, 10) || 0,
  };
  const res = await sendMessage('saveSettings', { settings });
  const el = $('save-result');
  if (res && res.ok) {
    el.className = 'save-result ok';
    el.textContent = '✓ Réglages enregistrés';
  } else {
    el.className = 'save-result error';
    el.textContent = ((res && res.error) || 'Erreur d\'enregistrement');
  }
  setTimeout(function () { el.textContent = ''; }, 2600);
}

async function test() {
  const el = $('test-result');
  el.className = 'test-result';
  el.textContent = 'Vérification…';

  // Sauvegarde l'adresse avant le test pour que le background l'utilise
  const host = ($('host').value || 'http://127.0.0.1:26545').trim();
  await sendMessage('saveSettings', { settings: { host: host } });

  const res = await sendMessage('health');
  if (res && res.ok) {
    el.className = 'test-result ok';
    el.textContent = '✓ SDM est joignable (' + (res.name || 'SDM') + (res.version ? ' v' + res.version : '') + ')';
  } else {
    el.className = 'test-result error';
    el.textContent = "✗ SDM est introuvable — vérifiez que l'application est ouverte";
  }
}

$('btn-save').addEventListener('click', save);
$('btn-test').addEventListener('click', test);

load();