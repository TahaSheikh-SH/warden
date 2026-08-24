'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatStatusLine } = require('../../actuators/statusline');
const { nudgeMessageFor } = require('../../actuators/messages');
const { ACTIONS } = require('../../decide');

function withTempLogFile(lines) {
  const logFilePath = path.join(
    os.tmpdir(),
    `warden-statusline-test-${process.hrtime.bigint()}.jsonl`,
  );
  if (lines.length) fs.writeFileSync(logFilePath, lines.join('\n') + '\n');
  return logFilePath;
}

describe('formatStatusLine', () => {
  test('returns null when the log file does not exist', () => {
    const missingPath = path.join(os.tmpdir(), 'warden-statusline-test-does-not-exist.jsonl');
    assert.equal(formatStatusLine(missingPath), null);
  });

  test('returns null when the log file is empty', () => {
    const logFilePath = withTempLogFile([]);
    assert.equal(formatStatusLine(logFilePath), null);
  });

  test('returns null when the last line is malformed JSON', () => {
    const logFilePath = withTempLogFile(['not json']);
    assert.equal(formatStatusLine(logFilePath), null);
  });

  test('returns null when the last logged action is CONTINUE', () => {
    const logFilePath = withTempLogFile([
      JSON.stringify({ action: ACTIONS.CONTINUE, reasons: ['within thresholds'] }),
    ]);
    assert.equal(formatStatusLine(logFilePath), null);
  });

  for (const action of [ACTIONS.COMPACT, ACTIONS.CHECKPOINT, ACTIONS.HANDOFF, ACTIONS.STOP]) {
    test(`reuses nudgeMessageFor's text so the status line matches every other harness's wording for ${action}`, () => {
      const logFilePath = withTempLogFile([
        JSON.stringify({ action, reasons: ['context high', 'second reason'] }),
      ]);
      assert.equal(
        formatStatusLine(logFilePath),
        nudgeMessageFor(action, ['context high', 'second reason']),
      );
    });
  }

  test('uses only the last line when the log file has multiple entries', () => {
    const logFilePath = withTempLogFile([
      JSON.stringify({ action: ACTIONS.COMPACT, reasons: ['stale'] }),
      JSON.stringify({ action: ACTIONS.HANDOFF, reasons: ['fresh'] }),
    ]);
    assert.equal(formatStatusLine(logFilePath), nudgeMessageFor(ACTIONS.HANDOFF, ['fresh']));
  });
});
