// Liste dist -> dist-status.txt (contourne shell instable)
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'dist-status.txt');
function walk(dir, base) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) { out.push('DIR  ' + rel); out.push(...walk(full, base)); }
      else { out.push('FILE ' + rel + ' size=' + st.size + ' mtime=' + st.mtime.toISOString()); }
    } catch (_) {}
  }
  return out;
}
const lines = [];
lines.push('ts=' + new Date().toISOString());
lines.push(...walk(DIST, DIST));
try {
  const lf = path.join(ROOT, 'build-final.log');
  const st = fs.statSync(lf);
  lines.push('--- build-final.log size=' + st.size + ' mtime=' + st.mtime.toISOString());
  const content = fs.readFileSync(lf, 'utf8');
  const lns = content.split('\n');
  lines.push('--- last 30 lines of build-final.log:');
  lines.push(...lns.slice(-30));
} catch (e) { lines.push('no build-final.log: ' + e.message); }
// process check: tasklist via wmic not needed, just node processes from ps?
lines.push('--- node proc check done via powershell separately');
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('wrote ' + OUT);
