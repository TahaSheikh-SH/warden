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

module.exports = { LOG_DIR, LOG_FILE, SESSIONS_DIR, sessionLogFile, appendLogEntry, readLogLines };
