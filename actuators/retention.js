'use strict';

const fs = require('fs');
const path = require('path');

// ~/.warden/sessions and ~/.warden/cache accumulate one file per
// session forever, and setup.js's *.bak.<epoch> files pile up beside every
// settings file it touches. This is the one shared sweep both use — a
// size/age check on write, since SessionEnd (Claude Code only) isn't a
// harness-agnostic trigger (Gate B, AGENTS.md). Best-effort: retention must
// never block or crash the caller over a filesystem hiccup.
function sweepDirectory(dir, { maxAgeMs, keepNewest, pattern, now } = {}) {
  try {
    const names = fs.readdirSync(dir).filter((name) => !pattern || pattern.test(name));

    const files = names.map((name) => {
      const filePath = path.join(dir, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    });
    files.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

    const cutoff = (now ?? Date.now()) - (maxAgeMs ?? Infinity);
    files.forEach((file, index) => {
      const tooOld = file.mtimeMs < cutoff;
      const beyondKeepCount = keepNewest != null && index >= keepNewest;
      if (tooOld || beyondKeepCount) {
        fs.unlinkSync(file.filePath);
      }
    });
  } catch {
    // best-effort — a missing/unwritable directory must never block the caller
  }
}

module.exports = { sweepDirectory };
