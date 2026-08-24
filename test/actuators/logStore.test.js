'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  LOG_DIR,
  SESSIONS_DIR,
  sessionLogFile,
  appendLogEntry,
  readLogLines,
} = require('../../actuators/logStore');

describe('sessionLogFile', () => {
  test('places the file under SESSIONS_DIR, named after the sessionKey', () => {
    const result = sessionLogFile('session-a');
    assert.equal(result, path.join(SESSIONS_DIR, 'session-a.jsonl'));
    assert.equal(path.dirname(SESSIONS_DIR), LOG_DIR);
  });

  test('collapses filesystem-unsafe characters (e.g. a full transcript path) into a valid filename', () => {
    const result = sessionLogFile('/Users/me/.claude/projects/foo/session.jsonl');
    assert.equal(path.dirname(result), SESSIONS_DIR);
    assert.doesNotMatch(path.basename(result), /\//);
  });

  test('two different sessionKeys never collapse to the same file', () => {
    const a = sessionLogFile('session-a');
    const b = sessionLogFile('session-b');
    assert.notEqual(a, b);
  });
});

describe('appendLogEntry default path', () => {
  test('derives the log path from entry.sessionKey when no explicit path is given', () => {
    const sessionKey = `logstore-test-${process.hrtime.bigint()}`;
    const expectedPath = sessionLogFile(sessionKey);
    try {
      appendLogEntry({ sessionKey, action: 'CONTINUE' });
      const lines = readLogLines(expectedPath).filter(Boolean);
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]).sessionKey, sessionKey);
    } finally {
      fs.rmSync(expectedPath, { force: true });
    }
  });

  test('honors an explicit logFile override, ignoring entry.sessionKey', () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-logstore-test-${process.hrtime.bigint()}.jsonl`,
    );
    try {
      appendLogEntry({ sessionKey: 'irrelevant', action: 'CONTINUE' }, logFilePath);
      const lines = readLogLines(logFilePath).filter(Boolean);
      assert.equal(lines.length, 1);
    } finally {
      fs.rmSync(logFilePath, { force: true });
    }
  });
});
