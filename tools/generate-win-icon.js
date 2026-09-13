// ============================================================================
// SDM - outils : génère l'icône Windows .ico à partir des PNG existants
//
// Construit assets/app-icon.ico en embarquant les PNG (16/32/48/128/256)
// comme entrées d'icône (format ICO à entrées PNG compressées, valide sur
// Windows Vista+). Sans dépendance externe.
// Usage : node tools/generate-win-icon.js
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'app-icon.ico');

const SOURCES = [
  path.join(ROOT, 'extension', 'icons', 'icon16.png'),
  path.join(ROOT, 'extension', 'icons', 'icon32.png'),
  path.join(ROOT, 'extension', 'icons', 'icon48.png'),
  path.join(ROOT, 'extension', 'icons', 'icon128.png'),
  path.join(ROOT, 'assets', 'app-icon.png'),
];

function pngSize(png) {
  // Largeur/hauteur aux octets 16-23 de l'en-tête PNG (IHDR, big-endian).
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function buildIco(entries) {
  const count = entries.length;
  let offset = 6 + count * 16; // les données PNG commencent après ICONDIR + entrées
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // réservé
  header.writeUInt16LE(1, 2); // type = icône
  header.writeUInt16LE(count, 4);
  const parts = [header];
  for (let i = 0; i < count; i++) {
    const { width, height, data } = entries[i];
    const entry = Buffer.alloc(16);
    entry[0] = width >= 256 ? 0 : width;
    entry[1] = height >= 256 ? 0 : height;
    entry[2] = 0; // palette
    entry[3] = 0; // réservé
    entry.writeUInt16LE(1, 4); // plans
    entry.writeUInt16LE(32, 6); // bits par pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    parts.push(entry);
    offset += data.length;
  }
  for (const { data } of entries) parts.push(data);
  return Buffer.concat(parts);
}

(function main() {
  const entries = [];
  for (const file of SOURCES) {
    if (!fs.existsSync(file)) {
      console.error('PNG manquant : ' + path.relative(ROOT, file));
      console.error("Lance d'abord : node tools/generate-icons.js");
      process.exit(1);
    }
    const data = fs.readFileSync(file);
    const { width, height } = pngSize(data);
    entries.push({ width, height, data });
    console.log(`Entrée : ${path.relative(ROOT, file)} (${width}x${height})`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buildIco(entries));
  console.log('Généré : ' + path.relative(ROOT, OUT));
})();
