'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { escalateHandoffToStop, GRACE_TURN_LIMIT } = require('../../actuators/escalationPolicy');
const { ACTIONS } = require('../../decide');

function withTempLogFile(entries) {
  const logFilePath = path.join(
    os.tmpdir(),
    `warden-shared-perf-test-${process.hrtime.bigint()}.jsonl`,
  );
  const lines = entries.map((entry) => JSON.stringify(entry)).join('\n');
  if (lines) fs.writeFileSync(logFilePath, lines + '\n');
  return logFilePath;
}

describe('escalateHandoffToStop log-read efficiency', () => {
  test('reads the log file at most once per call, not once per internal check', () => {
    const logFilePath = withTempLogFile(
      Array.from({ length: GRACE_TURN_LIMIT }, () => ({
        sessionKey: 'session-a',
        action: ACTIONS.HANDOFF,
      })),
    );
    const original = fs.readFileSync;
    let readCount = 0;
    fs.readFileSync = (...args) => {
      if (args[0] === logFilePath) readCount += 1;
      return original(...args);
    };
    try {
      const decision = { action: ACTIONS.HANDOFF, reasons: ['handoff reason'] };
      escalateHandoffToStop(decision, 'session-a', logFilePath);
    } finally {
      fs.readFileSync = original;
    }
    assert.equal(readCount, 1);
  });
});
