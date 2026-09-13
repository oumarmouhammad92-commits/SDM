// SDM - extension : popup
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

function setStatus(ok, text) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  dot.className = 'status-dot ' + (ok === true ? 'ok' : (ok === false ? 'error' : ''));
  label.textContent = text;
}

function shortName(url) {
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean).pop();
    return p ? decodeURIComponent(p) : url;
  } catch (_) { return url; }
}

function timeAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'il y a ' + s + ' s';
  const m = Math.round(s / 60);
  if (m < 60) return 'il y a ' + m + ' min';
  const h = Math.round(m / 60);
  if (h < 24) return 'il y a ' + h + ' h';
  return 'il y a ' + Math.round(h / 24) + ' j';
}

async function renderHistory() {
  const res = await sendMessage('getHistory');
  const history = (res && res.history) || [];
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  list.innerHTML = '';
  empty.style.display = history.length ? 'none' : '';

  history.forEach(function (item, i) {
    const row = document.createElement('div');
    row.className = 'history-item';

    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.textContent = item.sent ? '✓' : '⬇';

    const info = document.createElement('div');
    info.className = 'info';
    const fname = document.createElement('div');
    fname.className = 'fname' + (item.sent ? ' sent' : '');
    fname.textContent = shortName(item.filename || item.url);
    fname.title = item.url;
    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = timeAgo(item.time);
    info.appendChild(fname);
    info.appendChild(time);
    row.appendChild(icon);
    row.appendChild(info);

    if (!item.sent) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'send';
      btn.textContent = 'Envoyer';
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        btn.textContent = '…';
        const out = await sendMessage('download', { url: item.url });
        if (out && out.ok) {
          btn.textContent = 'Envoyé ✓';
          setTimeout(renderHistory, 800);
        } else {
          btn.textContent = 'Réessayer';
          btn.disabled = false;
        }
      });
      row.appendChild(btn);
    }

    list.appendChild(row);
  });
}

async function check() {
  setStatus(null, 'Vérification…');
  const res = await sendMessage('health');
  if (res && res.ok) setStatus(true, 'SDM est connecté (port local)');
  else setStatus(false, 'SDM est introuvable — ouvrez l\'application');
}

document.getElementById('btn-check').addEventListener('click', check);
document.getElementById('btn-options').addEventListener('click', function () {
  api.runtime.openOptionsPage();
});

check();
renderHistory();