'use strict';
// Build détaché de l'installateur Windows : lance `npm run dist`,
// journalise dans build-final.log et écrit build-status.txt à la fin.
// Usage : node tools/build-dist.js  (lancé en processus détaché)
const { spawn } = require('child_process');
const fss = require('fs');
const pth = require('path');

const ROOT = pth.join(__dirname, '..');
const LOG = pth.join(ROOT, 'build-final.log');
const STATUS = pth.join(ROOT, 'build-status.txt');

function appendLog(s) {
  try { fss.appendFileSync(LOG, s, 'utf8'); } catch (_) { /* ignoré */ }
}

try { fss.writeFileSync(LOG, '== build-dist demarre ' + new Date().toISOString() + ' ==\n', 'utf8'); } catch (_) {}
try { fss.writeFileSync(STATUS, 'RUNNING ts=' + Date.now() + '\n', 'utf8'); } catch (_) {}

const env = Object.assign({}, process.env, {
  CSC_IDENTITY_AUTO_DISCOVERY: 'false', // pas de certificat : ne pas bloquer
});

const child = spawn('cmd.exe', ['/c', 'npm.cmd run dist'], { cwd: ROOT, env, shell: false, windowsHide: true });
child.stdout.on('data', (d) => appendLog(d.toString()));
child.stderr.on('data', (d) => appendLog(d.toString()));
child.on('error', (e) => {
  appendLog('\nSPAWN ERROR: ' + (e && e.stack || e) + '\n');
});
child.on('close', (code) => {
  appendLog('\n== EXIT code=' + code + ' ==\n');
  let listing = '';
  try {
    const distDir = pth.join(ROOT, 'dist');
    const files = fss.existsSync(distDir) ? fss.readdirSync(distDir) : [];
    const exes = files.filter((f) => /\.exe$/i.test(f));
    for (const f of exes) {
      try {
        const st = fss.statSync(pth.join(distDir, f));
        listing += f + ' size=' + st.size + ' mtime=' + st.mtime.toISOString() + '\n';
      } catch (_) { listing += f + ' (stat impossible)\n'; }
    }
    if (!exes.length) listing = 'AUCUN-EXE files=[' + files.join(',') + ']\n';
  } catch (e) { listing = 'LIST-ERR ' + (e && e.message) + '\n'; }
  let copyLine = '';
  try {
    const distDir = pth.join(ROOT, 'dist');
    const cands = fss.existsSync(distDir) ? fss.readdirSync(distDir).filter((f) => /^SDM_Setup.*\.exe$/i.test(f)) : [];
    const src = fss.existsSync(pth.join(distDir, 'SDM_Setup_1.0.0.exe'))
      ? pth.join(distDir, 'SDM_Setup_1.0.0.exe')
      : (cands.length ? pth.join(distDir, cands[0]) : null);
    if (src) {
      fss.copyFileSync(src, pth.join(distDir, 'SDM_Setup.exe'));
      copyLine = 'COPIE-OK ' + pth.basename(src) + ' -> SDM_Setup.exe\n';
    } else {
      copyLine = 'COPIE-IMPOSSIBLE aucun SDM_Setup*.exe trouvé\n';
    }
  } catch (e) { copyLine = 'COPIE-ERR ' + (e && e.message) + '\n'; }
  let tail = '';
  try {
    const content = fss.readFileSync(LOG, 'utf8');
    const tailLines = content.split('\n');
    tail = tailLines.slice(Math.max(0, tailLines.length - 25)).join('\n');
  } catch (_) {}
  try {
    fss.writeFileSync(STATUS,
      (code === 0 ? 'DONE-OK' : 'DONE-FAIL') + ' code=' + code + ' ts=' + Date.now() + '\n'
      + listing + copyLine + '---TAIL---\n' + tail + '\n', 'utf8');
  } catch (_) {}
});
