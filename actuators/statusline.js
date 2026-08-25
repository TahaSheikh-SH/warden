#!/usr/bin/env node
'use strict';

// Claude Code statusLine command: renders warden's most recently logged
// decision as an extra footer line, since systemMessage/stderr don't
// reliably reach the user on advisory (exit 0) turns (see
// projects/2026-08-23-deterministic-cli-visibility/spec.md). Not
// session-scoped — shows the latest logged decision across all warden
// sessions, a known simplification until log entries carry cwd/session
// identity to filter on.

const { LOG_FILE, readLogLines } = require('./logStore');
const { nudgeMessageFor } = require('./messages');

function formatStatusLine(logFilePath) {
  const lines = readLogLines(logFilePath).filter(Boolean);
  if (!lines.length) return null;

  let entry;
  try {
    entry = JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }

  if (!entry || !Array.isArray(entry.reasons)) return null;
  // JSONL log doesn't carry full state, so cost clause is omitted here.
  return nudgeMessageFor(entry.action, entry.reasons, null);
}

function main() {
  try {
    const line = formatStatusLine(LOG_FILE);
    if (line) process.stdout.write(line + '\n');
  } catch {
    // a broken status line must never break the user's whole footer
  }
}

if (require.main === module) {
  main();
}

module.exports = { formatStatusLine };
