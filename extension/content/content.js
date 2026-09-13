// ============================================================================
// SDM - extension (content script)
// Ajoute un bouton « Télécharger avec SDM » à côté des liens de fichiers et
// des lecteurs vidéo (balises <video>, flux HLS .m3u8).
// Toute la communication avec l'application SDM passe par le background.
// ============================================================================

'use strict';

(function () {
  if (window.__sdmInjected) return;
  window.__sdmInjected = true;

  const EXTENSION_RE = /\.(zip|rar|7z|tar|gz|bz2|xz|zst|exe|msi|apk|msix|appx|deb|rpm|dmg|iso|jar|pkg|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md|epub|mobi|rtf|odt|ods|odp|csv|xml|json|mp4|mkv|avi|mov|webm|m4v|flv|wmv|mpg|mpeg|3gp|ts|ogv|mp3|wav|flac|ogg|m4a|aac|wma|opus|png|jpg|jpeg|gif|webp|svg|bmp|ico|tiff|m3u8)([?#][^ ]*)?$/i;

  let settings = { detectLinks: true, detectVideo: false, connections: 0 };
  const processedLinks = new Set();
  const processedVideos = new Set();

  // ---------------- Communication avec le background ----------------

  function sendMessage(type, data) {
    const payload = Object.assign({ type: type }, data || {});
    return new Promise(function (resolve) {
      if (typeof browser !== 'undefined' && browser.runtime) {
        try {
          browser.runtime.sendMessage(payload)
            .then(resolve)
            .catch(function (e) { resolve({ ok: false, error: e && e.message }); });
          return;
        } catch (e) { resolve({ ok: false, error: e.message }); return; }
      }
      try {
        chrome.runtime.sendMessage(payload, function (res) {
          const err = chrome.runtime.lastError;
          resolve(err ? { ok: false, error: err.message } : res);
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  // ---------------- Petit toast de confirmation ----------------

  function showToast(message, ok) {
    const old = document.querySelector('.sdm-toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.className = 'sdm-toast ' + (ok ? 'ok' : 'error');
    t.textContent = message;
    document.documentElement.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }

  function shortName(url) {
    try {
      const p = new URL(url).pathname.split('/').filter(Boolean).pop();
      return p ? decodeURIComponent(p).slice(0, 40) : url;
    } catch (_) { return String(url).slice(0, 40); }
  }

  function isHttpUrl(url) {
    return typeof url === 'string' && /^https?:/i.test(url);
  }

  // ---------------- Liens de fichiers ----------------

  function isFileUrl(href) {
    if (!isHttpUrl(href)) return false;
    return EXTENSION_RE.test(String(href).split('#')[0]);
  }

  function scanLinks() {
    if (!settings.detectLinks) return;
    const anchors = document.querySelectorAll('a[href]');
    anchors.forEach(function (a) {
      if (processedLinks.has(a)) return;
      const href = (a.getAttribute('href') || '').trim();
      if (!isFileUrl(href)) return;
      processedLinks.add(a);

      a.classList.add('sdm-has-btn');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sdm-link-btn';
      btn.title = 'Télécharger avec SDM';
      btn.textContent = '⬇ SDM';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        btn.textContent = '…';
        sendMessage('download', { url: a.href })
          .then(function (res) {
            btn.textContent = '⬇ SDM';
            if (res && res.ok) showToast('Envoyé à SDM : ' + shortName(a.href), true);
            else showToast((res && res.error) || "SDM n'a pas accepté le lien", false);
          });
      });
      a.appendChild(btn);
    });
  }

  // ---------------- Détection vidéo (si légalement autorisé) ----------------

  function videoSourceUrl(video) {
    if (video.currentSrc) return video.currentSrc;
    const source = video.querySelector('source[src]');
    if (source && source.src) return source.src;
    const attr = video.getAttribute('src');
    return attr ? attr : '';
  }

  function scanVideos() {
    if (!settings.detectVideo) return;
    document.querySelectorAll('video').forEach(function (video) {
      if (processedVideos.has(video)) return;
      const url = videoSourceUrl(video);
      if (!isHttpUrl(url)) return;
      processedVideos.add(video);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sdm-video-btn';
      btn.textContent = '⬇ Télécharger avec SDM';
      btn.setAttribute('title', 'Envoyer cette vidéo à SDM');
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        btn.disabled = true;
        btn.textContent = 'Envoi…';
        const target = videoSourceUrl(video) || url;
        sendMessage('download', { url: target })
          .then(function (res) {
            btn.disabled = false;
            btn.textContent = (res && res.ok) ? 'Envoyé à SDM ✓' : '⬇ Télécharger avec SDM';
            if (!res || !res.ok) showToast((res && res.error) || "SDM n'a pas accepté la vidéo", false);
          });
      });

      const parent = video.parentNode;
      if (parent) parent.insertBefore(btn, video.nextSibling);
    });
  }

  // ---------------- Déclenchement et suivi des changements de page ----------------

  function apply() {
    scanLinks();
    scanVideos();
  }

  // Re-scanne les contenus ajoutés dynamiquement (applications web modernes)
  let scanTimer = null;
  try {
    new MutationObserver(function () {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(apply, 700);
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) { /* MutationObserver indisponible */ }

  // Charge les réglages puis applique
  sendMessage('getSettings')
    .then(function (res) {
      settings = Object.assign(settings, (res && res.settings) || {});
      apply();
    })
    .catch(function () { apply(); });
})();