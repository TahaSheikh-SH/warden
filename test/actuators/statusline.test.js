'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatStatusLine, resolveLogFile } = require('../../actuators/statusline');
const { nudgeMessageFor, driftWarningFor } = require('../../actuators/messages');
const { ACTIONS } = require('../../decide');
const { sessionLogFile, latestLogFile } = require('../../actuators/logStore');

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

  // The status line is the only channel that
  // already renders unconditionally on Claude Code, so drift must not be
  // swallowed just because the action itself is the silent-CONTINUE case.
  test('renders the drift warning even when the logged action is CONTINUE', () => {
    const logFilePath = withTempLogFile([
      JSON.stringify({
        action: ACTIONS.CONTINUE,
        reasons: ['within thresholds'],
        driftDetected: true,
      }),
    ]);
    assert.equal(formatStatusLine(logFilePath), driftWarningFor());
  });

  test('a real nudge still wins over a stale drift flag from an earlier line', () => {
    const logFilePath = withTempLogFile([
      JSON.stringify({ action: ACTIONS.COMPACT, reasons: ['context high'], driftDetected: true }),
    ]);
    assert.equal(formatStatusLine(logFilePath), nudgeMessageFor(ACTIONS.COMPACT, ['context high']));
  });

  test('uses only the last line when the log file has multiple entries', () => {
    const logFilePath = withTempLogFile([
      JSON.stringify({ action: ACTIONS.COMPACT, reasons: ['stale'] }),
      JSON.stringify({ action: ACTIONS.HANDOFF, reasons: ['fresh'] }),
    ]);
    assert.equal(formatStatusLine(logFilePath), nudgeMessageFor(ACTIONS.HANDOFF, ['fresh']));
  });
});

describe('resolveLogFile', () => {
  test('resolves the log file for this session from transcript_path on stdin', () => {
    const transcriptPath = '/Users/example/.claude/projects/foo/session-a.jsonl';
    assert.equal(
      resolveLogFile(JSON.stringify({ transcript_path: transcriptPath })),
      sessionLogFile(transcriptPath),
    );
  });

  test('two different sessions resolve to two different log files', () => {
    const a = resolveLogFile(JSON.stringify({ transcript_path: '/tmp/session-a.jsonl' }));
    const b = resolveLogFile(JSON.stringify({ transcript_path: '/tmp/session-b.jsonl' }));
    assert.notEqual(a, b);
  });

  test('falls back to latestLogFile() when stdin is malformed JSON', () => {
    assert.equal(resolveLogFile('not json'), latestLogFile());
  });

  test('falls back to latestLogFile() when transcript_path is missing', () => {
    assert.equal(resolveLogFile(JSON.stringify({})), latestLogFile());
  });
});
