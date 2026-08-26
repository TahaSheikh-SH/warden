#!/usr/bin/env node
'use strict';

// Claude Code statusLine command: renders warden's most recent logged decision
// as a footer line, since systemMessage/stderr don't reliably reach the human
// on advisory turns. Not session-scoped — it shows the latest decision across
// all sessions, until log entries carry enough identity to filter on.

const { latestLogFile, readLogLines } = require('./logStore');
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
  return nudgeMessageFor(entry.action, entry.reasons);
}

function main() {
  try {
    const line = formatStatusLine(latestLogFile());
    if (line) process.stdout.write(line + '\n');
  } catch {
    // a broken status line must never break the user's whole footer
  }
}

if (require.main === module) {
  main();
}

module.exports = { formatStatusLine };
