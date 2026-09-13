'use strict';
// Lance `npm run dist` en tâche de fond détachée (survit à la fin du shell
// appelant) et journalise dans dist-build.log (UTF-8).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const logPath = path.join(ROOT, 'dist-build.log');
try { fs.unlinkSync(logPath); } catch (_) { /* ignore */ }
const log = fs.openSync(logPath, 'a');

const child = spawn('npm.cmd', ['run', 'dist'], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', log, log],
});
child.unref();
console.log('dist lance en arriere-plan, pid=' + child.pid);


