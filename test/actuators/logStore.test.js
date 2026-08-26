'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  LOG_DIR,
  LOG_FILE,
  SESSIONS_DIR,
  sessionLogFile,
  latestLogFile,
  appendLogEntry,
  readLogLines,
  logDecision,
} = require('../../actuators/logStore');

describe('sessionLogFile', () => {
  test('places the file under SESSIONS_DIR, named after the sessionKey', () => {
    const result = sessionLogFile('session-a');
    assert.equal(path.dirname(result), SESSIONS_DIR);
    assert.match(path.basename(result), /^session-a-[0-9a-f]{8}\.jsonl$/);
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

  test('two keys that only differ by a separator character no longer collide', () => {
    // Naive sanitization (replace unsafe chars with "_") maps both of these
    // to "a_b" — the regression this hash suffix guards against.
    const a = sessionLogFile('/a/b');
    const b = sessionLogFile('a-b');
    assert.notEqual(a, b);
  });

  test('is deterministic: the same sessionKey always resolves to the same file', () => {
    assert.equal(sessionLogFile('session-a'), sessionLogFile('session-a'));
  });
});

describe('latestLogFile', () => {
  function withTempSessionsDir(files) {
    const dir = path.join(os.tmpdir(), `warden-sessions-test-${process.hrtime.bigint()}`);
    fs.mkdirSync(dir, { recursive: true });
    // mtime is set explicitly rather than relying on write order — two writes
    // in the same millisecond would otherwise make "newest" a coin flip.
    files.forEach(({ name, mtimeMs }) => {
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, '{}\n');
      fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
    });
    return dir;
  }

  test('returns the most recently modified per-session log', () => {
    const dir = withTempSessionsDir([
      { name: 'old.jsonl', mtimeMs: 1_700_000_000_000 },
      { name: 'newest.jsonl', mtimeMs: 1_800_000_000_000 },
      { name: 'middle.jsonl', mtimeMs: 1_750_000_000_000 },
    ]);
    try {
      assert.equal(latestLogFile(dir), path.join(dir, 'newest.jsonl'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // .notified marker files live in the same directory and are not decision logs.
  test('ignores non-.jsonl files even when they are newer', () => {
    const dir = withTempSessionsDir([
      { name: 'real.jsonl', mtimeMs: 1_700_000_000_000 },
      { name: 'real.jsonl.notified', mtimeMs: 1_900_000_000_000 },
    ]);
    try {
      assert.equal(latestLogFile(dir), path.join(dir, 'real.jsonl'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to the legacy shared log when no per-session logs exist', () => {
    const dir = withTempSessionsDir([]);
    try {
      assert.equal(latestLogFile(dir), LOG_FILE);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to the legacy shared log when the sessions dir is missing', () => {
    const missing = path.join(os.tmpdir(), `warden-sessions-missing-${process.hrtime.bigint()}`);
    assert.equal(latestLogFile(missing), LOG_FILE);
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

// logDecision is the one shared write path every harness actuator uses, so
// this is where a drift signal must surface to reach all four — not just
// the strongest display channel (AGENTS.md).
describe('logDecision drift fields', () => {
  function tempLogFilePath() {
    return path.join(os.tmpdir(), `warden-logstore-drift-test-${process.hrtime.bigint()}.jsonl`);
  }

  test('carries state.harnessVersion and state.driftDetected through to the logged entry', () => {
    const logFilePath = tempLogFilePath();
    try {
      logDecision({
        harness: 'claude-code',
        decision: { action: 'CONTINUE', reasons: ['within thresholds'] },
        state: {
          contextUsedPct: 0.1,
          contextWindowSource: 'detected',
          compactionCount: 0,
          sessionAgeMinutes: 1,
          harnessVersion: '2.1.239',
          driftDetected: true,
        },
        sessionKey: 'session-a',
        logFilePath,
      });
      const entry = JSON.parse(readLogLines(logFilePath).filter(Boolean)[0]);
      assert.equal(entry.harnessVersion, '2.1.239');
      assert.equal(entry.driftDetected, true);
    } finally {
      fs.rmSync(logFilePath, { force: true });
    }
  });

  test('omits harnessVersion/driftDetected rather than writing null/false noise when state lacks them', () => {
    const logFilePath = tempLogFilePath();
    try {
      logDecision({
        decision: { action: 'CONTINUE', reasons: ['within thresholds'] },
        state: { contextUsedPct: 0.1, compactionCount: 0, sessionAgeMinutes: 1 },
        sessionKey: 'session-a',
        logFilePath,
      });
      const entry = JSON.parse(readLogLines(logFilePath).filter(Boolean)[0]);
      assert.equal('harnessVersion' in entry, false);
      assert.equal('driftDetected' in entry, false);
    } finally {
      fs.rmSync(logFilePath, { force: true });
    }
  });
});
