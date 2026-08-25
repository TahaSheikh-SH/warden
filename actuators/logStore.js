'use strict';

// JSONL decision log I/O, shared by escalationPolicy.js (reads) and
// notify.js (writes). Split out to avoid a require() cycle between them.

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR = path.join(os.homedir(), '.warden');
const LOG_FILE = path.join(LOG_DIR, 'log.jsonl');
const SESSIONS_DIR = path.join(LOG_DIR, 'sessions');

// One log file per session avoids cross-session write contention and
// unbounded growth of a shared log. sessionKey isn't always filename-safe
// (native/codex use the full transcript path), so non-filename chars get
// collapsed.
function sessionLogFile(sessionKey) {
  const safeKey = String(sessionKey).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(SESSIONS_DIR, `${safeKey}.jsonl`);
}

// The most recently written per-session log, falling back to the legacy
// shared log when no per-session logs exist. Readers that want "the latest
// decision across all sessions" must resolve the file this way: nothing has
// appended to LOG_FILE since per-session files landed, so reading LOG_FILE
// directly pins the reader to whatever was last written before that split.
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

// Shared by hasEverStopped/countTrailingAction so escalateHandoffToStop
// reads the file once instead of twice per call. Fails open (returns []).
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
