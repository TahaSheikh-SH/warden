'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Locates a Claude Code session transcript on disk. Claude Code writes one
 * .jsonl per session under ~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl
 * — this is the project's own local session storage, not a documented
 * public API, so this file is the thing that breaks first if Claude Code
 * changes its on-disk format.
 */
function sanitizeCwdToProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function findLatestSessionFile(cwd = process.cwd()) {
  const projectDir = path.join(os.homedir(), '.claude', 'projects', sanitizeCwdToProjectDir(cwd));

  if (!fs.existsSync(projectDir)) {
    throw new Error(`no Claude Code session directory found for ${cwd}: ${projectDir}`);
  }

  const sessionFiles = fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(projectDir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (sessionFiles.length === 0) {
    throw new Error(`no session files found in ${projectDir}`);
  }

  return sessionFiles[0].full;
}

module.exports = { findLatestSessionFile, sanitizeCwdToProjectDir };
