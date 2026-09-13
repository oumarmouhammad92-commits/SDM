// ============================================================================
// SDM - outils : générateur d'icônes PNG (sans dépendance externe)
//
// Dessine le logo SDM (carré arrondi bleu->violet avec flèche vers le bas)
// et encode de vrais fichiers PNG (zlib + CRC32 de Node).
//
// Génère :
//   extension/icons/icon{16,32,48,128}.png
//   assets/app-icon.png                 (256x256, icône de fenêtre Electron)
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

// ---------------- Encodeur PNG minimal ----------------

const CRC_TABLE = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Chaque ligne est préfixée par le filtre 0 (None)
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------- Petit utilitaire de couleur ----------------

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpColor(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// Distance à un segment [ax,ay]-[bx,by]
function distSeg(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const len2 = abx * abx + aby * aby;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (len2 || 1)));
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
  return Math.sqrt(dx * dx + dy * dy);
}
// ---------------- Dessin de l'icône (SDF, anti-aliasing) ----------------

function renderIcon(size) {
  const S = size;
  const px = Math.max(1.1, S / 96);       // largeur d'anti-aliasing
  const radius = S * 0.24;                 // rayon des coins arrondis
  const half = S / 2;

  const rgba = Buffer.alloc(S * S * 4);
  const top = [79, 140, 255];              // #4f8cff
  const bottom = [123, 91, 255];           // #7b5bff
  const white = [255, 255, 255];

  const cx = S / 2;
  const stemHalf = Math.max(0.7, S * 0.042); // barre verticale
  const wingHalf = Math.max(0.9, S * 0.052); // épaisseur du chevron
  const stemTop = S * 0.20, stemBottom = S * 0.50;
  const tipY = S * 0.62;
  const wingX = S * 0.30;
  const barMidY = S * 0.745, barHalfW = S * 0.235, barHalfH = S * 0.045;
  const cap1X = cx - (barHalfW - barHalfH), cap2X = cx + (barHalfW - barHalfH);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const fx = x + 0.5, fy = y + 0.5;

      // Carré arrondi (distance signée du rectangle + coins)
      const qx = Math.abs(fx - cx) - (half - radius);
      const qy = Math.abs(fy - cx) - (half - radius);
      const distRect = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) +
        Math.min(Math.max(qx, qy), 0) - radius;
      const cover = smoothstep(px * 0.5, -px * 0.5, distRect);
      if (cover <= 0.001) continue;

      // Dégradé diagonal (coin haut-gauche -> coin bas-droit)
      const t = clamp01((fx + fy) / (S * 2));
      let col = lerpColor(top, bottom, t);

      // Couverture cumulée des formes blanches
      let whiteCover = 0;

      // 1) Barre verticale centrale
      const dStem = Math.max(Math.abs(fx - cx) - stemHalf, stemTop - fy, fy - stemBottom);
      whiteCover = Math.max(whiteCover, smoothstep(px * 0.5, -px * 0.5, dStem));

      // 2) Branches du chevron
      const dWingL = distSeg(fx, fy, wingX, S * 0.50, cx, tipY) - wingHalf;
      const dWingR = distSeg(fx, fy, S - wingX, S * 0.50, cx, tipY) - wingHalf;
      whiteCover = Math.max(whiteCover, smoothstep(px * 0.5, -px * 0.5, dWingL));
      whiteCover = Math.max(whiteCover, smoothstep(px * 0.5, -px * 0.5, dWingR));

      // 3) Barre horizontale : rectangle central + capsules aux extrémités
      const inner = Math.min(
        Math.max(Math.abs(fy - barMidY) - barHalfH, Math.abs(fx - cx) - (barHalfW - barHalfH)),
        Math.sqrt((fx - cap1X) ** 2 + (fy - barMidY) ** 2) - barHalfH,
        Math.sqrt((fx - cap2X) ** 2 + (fy - barMidY) ** 2) - barHalfH,
      );
      whiteCover = Math.max(whiteCover, smoothstep(px * 0.5, -px * 0.5, inner));

      if (whiteCover > 0) col = lerpColor(col, white, whiteCover);

      const idx = (y * S + x) * 4;
      rgba[idx] = Math.round(col[0]);
      rgba[idx + 1] = Math.round(col[1]);
      rgba[idx + 2] = Math.round(col[2]);
      rgba[idx + 3] = Math.round(cover * 255);
    }
  }
  return encodePng(S, S, rgba);
}

// ---------------- Génération des fichiers ----------------

function writeSizes(list) {
  for (const { size, filePath } of list) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, renderIcon(size));
    console.log('Généré : ' + path.relative(ROOT, filePath) + ' (' + size + 'x' + size + ')');
  }
}

writeSizes([
  { size: 16, filePath: path.join(ROOT, 'extension', 'icons', 'icon16.png') },
  { size: 32, filePath: path.join(ROOT, 'extension', 'icons', 'icon32.png') },
  { size: 48, filePath: path.join(ROOT, 'extension', 'icons', 'icon48.png') },
  { size: 128, filePath: path.join(ROOT, 'extension', 'icons', 'icon128.png') },
  { size: 256, filePath: path.join(ROOT, 'assets', 'app-icon.png') },
]);

console.log('Terminé.');