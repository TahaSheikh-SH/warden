'use strict';

// JSONL decision log I/O, shared by escalationPolicy.js (reads) and
// notify.js (writes). Split out to avoid a require() cycle between them.

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR = path.join(os.homedir(), '.warden');
const LOG_FILE = path.join(LOG_DIR, 'log.jsonl');
const SESSIONS_DIR = path.join(LOG_DIR, 'sessions');

// One file per session, so sessions don't contend for one growing log.
// sessionKey is often a full transcript path, so collapse unsafe chars.
function sessionLogFile(sessionKey) {
  const safeKey = String(sessionKey).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(SESSIONS_DIR, `${safeKey}.jsonl`);
}

// Newest per-session log, falling back to the legacy shared one. Readers
// that want "the latest decision" must resolve it this way: nothing appends
// to LOG_FILE anymore, so reading it directly returns a frozen entry.
function latestLogFile(sessionsDir = SESSIONS_DIR) {
  try {
    const files = fs
      .readdirSync(sessionsDir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => path.join(sessionsDir, name));
    if (!files.length) return LOG_FILE;
    return files.reduce((newest, candidate) =>
      fs.statSync(candidate).mtimeMs > fs.statSync(newest).mtimeMs ? candidate : newest,
    );
  } catch {
    return LOG_FILE; // sessions dir missing/unreadable — legacy log is the best available
  }
}

function appendLogEntry(entry, logFile = sessionLogFile(entry.sessionKey)) {
  try {
    const logDir = path.dirname(logFile);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch {
    // logging must never block or crash the caller
  }
}

// Fails open (returns []) — a broken log must never block a turn.
function readLogLines(logFilePath) {
  try {
    if (!fs.existsSync(logFilePath)) return [];
    return fs.readFileSync(logFilePath, 'utf8').split('\n');
  } catch {
    return [];
  }
}

module.exports = {
  LOG_DIR,
  LOG_FILE,
  SESSIONS_DIR,
  sessionLogFile,
  latestLogFile,
  appendLogEntry,
  readLogLines,
};
