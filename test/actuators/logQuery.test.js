'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getLastNudgedAction,
  countTrailingAction,
  hasEverStopped,
  GRACE_TURN_LIMIT,
} = require('../../actuators/escalationPolicy');
const { ACTIONS } = require('../../decide');

function withTempLogFile(entries) {
  const logFilePath = path.join(
    os.tmpdir(),
    `warden-logquery-test-${process.hrtime.bigint()}.jsonl`,
  );
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  if (lines) fs.writeFileSync(logFilePath, lines + '\n');
  return logFilePath;
}

describe('getLastNudgedAction', () => {
  test('returns null when the log file does not exist', () => {
    const missingPath = path.join(os.tmpdir(), 'warden-logquery-test-does-not-exist.jsonl');
    assert.equal(getLastNudgedAction('session-a', missingPath), null);
  });

  test('returns null when no entry matches this sessionKey', () => {
    const logFilePath = withTempLogFile([{ sessionKey: 'session-other', action: ACTIONS.COMPACT }]);
    assert.equal(getLastNudgedAction('session-a', logFilePath), null);
  });

  test('returns the most recent action logged for this sessionKey', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.COMPACT },
      { sessionKey: 'session-other', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
    ]);
    assert.equal(getLastNudgedAction('session-a', logFilePath), ACTIONS.HANDOFF);
  });

  test('ignores malformed lines instead of throwing', () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-logquery-test-${process.hrtime.bigint()}.jsonl`,
    );
    fs.writeFileSync(
      logFilePath,
      'not json\n' + JSON.stringify({ sessionKey: 'session-a', action: ACTIONS.CHECKPOINT }) + '\n',
    );
    assert.equal(getLastNudgedAction('session-a', logFilePath), ACTIONS.CHECKPOINT);
  });
});

describe('countTrailingAction', () => {
  test('returns 0 when the log file does not exist', () => {
    const missingPath = path.join(os.tmpdir(), 'warden-logquery-test-missing2.jsonl');
    assert.equal(countTrailingAction(ACTIONS.HANDOFF, 'session-a', missingPath), 0);
  });

  test('returns 0 when the trailing entry for this session does not match', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.COMPACT },
    ]);
    assert.equal(countTrailingAction(ACTIONS.HANDOFF, 'session-a', logFilePath), 0);
  });

  test('counts consecutive matching trailing entries for this session', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.COMPACT },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
    ]);
    assert.equal(countTrailingAction(ACTIONS.HANDOFF, 'session-a', logFilePath), 3);
  });

  test('stops at the first non-matching entry, ignoring entries from other sessions in between', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.COMPACT },
      { sessionKey: 'session-b', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
    ]);
    assert.equal(countTrailingAction(ACTIONS.HANDOFF, 'session-a', logFilePath), 2);
  });

  test('ignores malformed lines instead of throwing or breaking the count', () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-logquery-test-${process.hrtime.bigint()}.jsonl`,
    );
    fs.writeFileSync(
      logFilePath,
      [
        JSON.stringify({ sessionKey: 'session-a', action: ACTIONS.HANDOFF }),
        'not json',
        JSON.stringify({ sessionKey: 'session-a', action: ACTIONS.HANDOFF }),
      ].join('\n') + '\n',
    );
    assert.equal(countTrailingAction(ACTIONS.HANDOFF, 'session-a', logFilePath), 2);
  });

  test('reaches GRACE_TURN_LIMIT after 5 consecutive ignored HANDOFF entries', () => {
    const logFilePath = withTempLogFile(
      Array.from({ length: GRACE_TURN_LIMIT }, () => ({
        sessionKey: 'session-a',
        action: ACTIONS.HANDOFF,
      })),
    );
    assert.equal(countTrailingAction(ACTIONS.HANDOFF, 'session-a', logFilePath), GRACE_TURN_LIMIT);
  });
});

describe('hasEverStopped', () => {
  test('returns false when the log file does not exist', () => {
    const missingPath = path.join(os.tmpdir(), 'warden-logquery-test-missing3.jsonl');
    assert.equal(hasEverStopped('session-a', missingPath), false);
  });

  test('returns false when no STOP entry exists for this sessionKey', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-b', action: ACTIONS.STOP },
    ]);
    assert.equal(hasEverStopped('session-a', logFilePath), false);
  });

  test('returns true when a STOP entry for this sessionKey exists anywhere in the log, not just the last entry', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.STOP },
      { sessionKey: 'session-a', action: ACTIONS.CONTINUE },
      { sessionKey: 'session-a', action: ACTIONS.COMPACT },
    ]);
    assert.equal(hasEverStopped('session-a', logFilePath), true);
  });
});
