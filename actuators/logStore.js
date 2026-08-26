'use strict';

// JSONL decision log I/O, shared by escalationPolicy.js (reads) and
// notify.js (writes). Split out to avoid a require() cycle between them.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR = path.join(os.homedir(), '.warden');
const LOG_FILE = path.join(LOG_DIR, 'log.jsonl');
const SESSIONS_DIR = path.join(LOG_DIR, 'sessions');

// One file per session, so sessions don't contend for one growing log.
// sessionKey is often a full transcript path, so collapse unsafe chars —
// a short hash of the raw key is appended because that collapse alone is
// lossy (e.g. "/a/b" and "a-b" both sanitize to "a_b"); the hash keeps such
// keys from silently sharing one session's log file.
function sessionLogFile(sessionKey) {
  const raw = String(sessionKey);
  const safeKey = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return path.join(SESSIONS_DIR, `${safeKey}-${hash}.jsonl`);
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

// Shared shape for a decision-log line, used by every harness actuator so a
// schema change is a one-file edit. `harness` is omitted (native.js, Claude
// Code) or named (codex/opencode/pi); extra fields undefined for a given
// harness (e.g. contextWindowSource) are dropped by JSON.stringify, so they
// stay harmless no-ops for harnesses that don't set them.
function logDecision({ harness, decision, state, sessionKey, logFilePath }) {
  appendLogEntry(
    {
      timestamp: new Date().toISOString(),
      harness,
      sessionKey,
      action: decision.action,
      reasons: decision.reasons,
      contextUsedPct: state.contextUsedPct,
      contextWindowSource: state.contextWindowSource,
      compactionCount: state.compactionCount,
      sessionAgeMinutes: state.sessionAgeMinutes,
    },
    logFilePath,
  );
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
  logDecision,
  readLogLines,
};
