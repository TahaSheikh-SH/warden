#!/usr/bin/env node
'use strict';

// Claude Code statusLine command: renders warden's most recent logged decision
// as a footer line, since systemMessage/stderr don't reliably reach the human
// on advisory turns. Claude Code delivers the statusLine payload on stdin
// (same as hooks), carrying transcript_path — resolve that session's own log
// file so this session's footer never shows another session's decision.

const { latestLogFile, sessionLogFile, readLogLines } = require('./logStore');
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

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// Malformed/absent stdin falls back to the cross-session latest file rather
// than showing nothing — better a possibly-stale line than a silently blank
// footer on every render.
function resolveLogFile(raw) {
  try {
    const input = JSON.parse(raw);
    if (input && input.transcript_path) return sessionLogFile(input.transcript_path);
  } catch {
    // fall through to latestLogFile()
  }
  return latestLogFile();
}

async function main() {
  try {
    const raw = await readStdin();
    const line = formatStatusLine(resolveLogFile(raw));
    if (line) process.stdout.write(line + '\n');
  } catch {
    // a broken status line must never break the user's whole footer
  }
}

if (require.main === module) {
  main();
}

module.exports = { formatStatusLine, resolveLogFile };
