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
// escaping so a raw '"' or backslash can't break out of the literal. A raw
// newline is also a syntax error inside an osascript -e string literal.
function escapeForAppleScript(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n/g, ' ');
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
      // execFile bypasses the shell, so %USERNAME% wouldn't expand — read it
      // from the environment directly. '*' (all sessions) only as a fallback.
      args = [process.env.USERNAME || '*', `warden: ${message}`];
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

// Opt-in via WARDEN_NOTIFY=1, and call after logDecision(): this counts the
// entry that call just wrote. Full reason detail stays in the log.
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
  if (process.env.WARDEN_NOTIFY !== '1') return false;
  if (!shouldNotifyHuman(effectiveDecision.action, sessionKey, logFilePath)) return false;

  const count = countTrailingAction(effectiveDecision.action, sessionKey, logFilePath);
  const message = ACTION_MESSAGES[effectiveDecision.action] || effectiveDecision.action;
  notifyHuman(message, opts);
  markMilestoneNotified(
    notifyMarkerFile(logFilePath, effectiveDecision.action),
    highestReachedMilestone(count, effectiveDecision.action),
  );
  return true;
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
