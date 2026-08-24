'use strict';

// Log I/O + best-effort OS notification. Escalation policy (when to
// notify) lives in escalationPolicy.js.

const { execFile } = require('child_process');
const { LOG_DIR, LOG_FILE, sessionLogFile, appendLogEntry, readLogLines } = require('./logStore');
const {
  shouldNotifyHuman,
  countTrailingAction,
  notifyMarkerFile,
  highestReachedMilestone,
  markMilestoneNotified,
} = require('./escalationPolicy');

// JSON.stringify escapes JS string syntax, not AppleScript's — need our own
// escaping so a raw '"' or backslash can't break out of the literal.
function escapeForAppleScript(text) {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Best-effort, never throws/blocks. Platform coverage is partial (no
// notify-send on headless Linux, no msg.exe on Windows Home) — falls back
// to stderr+bell rather than adding a dependency for full coverage.
function notifyHuman(message, { execFileFn = execFile } = {}) {
  try {
    const fallback = () => process.stderr.write(`[warden] \x07${message}\n`);

    let cmd = null;
    let args = null;
    if (process.platform === 'darwin') {
      cmd = 'osascript';
      args = ['-e', `display notification "${escapeForAppleScript(message)}" with title "warden"`];
    } else if (process.platform === 'linux') {
      cmd = 'notify-send';
      args = ['warden', message];
    } else if (process.platform === 'win32') {
      cmd = 'msg';
      args = ['*', `warden: ${message}`];
    }

    if (!cmd) {
      fallback();
      return;
    }

    try {
      execFileFn(cmd, args, (spawnError) => {
        if (spawnError) fallback();
      });
    } catch {
      // binary genuinely missing — best-effort, give up quietly
    }
  } catch {
    // notification is best-effort only, never affects the caller
  }
}

// Opt-in via WARDEN_NOTIFY=1. Call after logDecision(), since this reads
// the log entry logDecision() just wrote. Plain-language messages only —
// full reason detail stays in the JSONL log, not the popup.
const ACTION_MESSAGES = {
  COMPACT: 'Context is getting full. Compact it to keep things running smoothly.',
  CHECKPOINT: 'Good spot to checkpoint before continuing.',
  HANDOFF: 'This session is running long. Start a fresh one.',
  STOP: 'This session is burning tokens. Step in and stop it.',
};

function maybeNotifyHuman(
  effectiveDecision,
  sessionKey,
  logFilePath = sessionLogFile(sessionKey),
  opts = {},
) {
  if (process.env.WARDEN_NOTIFY !== '1') return;
  if (!shouldNotifyHuman(effectiveDecision.action, sessionKey, logFilePath)) return;

  const count = countTrailingAction(effectiveDecision.action, sessionKey, logFilePath);
  const message = ACTION_MESSAGES[effectiveDecision.action] || effectiveDecision.action;
  notifyHuman(message, opts);
  markMilestoneNotified(notifyMarkerFile(logFilePath), highestReachedMilestone(count));
}

module.exports = {
  LOG_DIR,
  LOG_FILE,
  appendLogEntry,
  readLogLines,
  escapeForAppleScript,
  notifyHuman,
  maybeNotifyHuman,
};
