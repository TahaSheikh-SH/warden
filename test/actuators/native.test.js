'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getLastNudgedAction } = require('../../actuators/shared');
const {
  respondFor,
  computeEffectiveDecision,
  logDecisionAndNotify,
} = require('../../actuators/native');
const { ACTIONS } = require('../../decide');
const { LOG_FILE: SHARED_LOG_FILE } = require('../../actuators/shared');

function withTempLogFile(entries) {
  const logFilePath = path.join(os.tmpdir(), `warden-native-test-${process.hrtime.bigint()}.jsonl`);
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  if (lines) fs.writeFileSync(logFilePath, lines + '\n');
  return logFilePath;
}

describe('getLastNudgedAction', () => {
  test('returns null when the log file does not exist', () => {
    const missingPath = path.join(os.tmpdir(), 'warden-native-test-does-not-exist.jsonl');
    assert.equal(getLastNudgedAction('/transcripts/a.jsonl', missingPath), null);
  });

  test('returns null when no entry matches this transcript', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: '/transcripts/other.jsonl', action: ACTIONS.COMPACT },
    ]);
    assert.equal(getLastNudgedAction('/transcripts/a.jsonl', logFilePath), null);
  });

  test('returns the most recent action logged for this transcript', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: '/transcripts/a.jsonl', action: ACTIONS.COMPACT },
      { sessionKey: '/transcripts/other.jsonl', action: ACTIONS.HANDOFF },
      { sessionKey: '/transcripts/a.jsonl', action: ACTIONS.HANDOFF },
    ]);
    assert.equal(getLastNudgedAction('/transcripts/a.jsonl', logFilePath), ACTIONS.HANDOFF);
  });

  test('ignores malformed lines instead of throwing', () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-native-test-${process.hrtime.bigint()}.jsonl`,
    );
    fs.writeFileSync(
      logFilePath,
      'not json\n' +
        JSON.stringify({ sessionKey: '/transcripts/a.jsonl', action: ACTIONS.CHECKPOINT }) +
        '\n',
    );
    assert.equal(getLastNudgedAction('/transcripts/a.jsonl', logFilePath), ACTIONS.CHECKPOINT);
  });
});

describe('respondFor STOP', () => {
  test('STOP hard-blocks with exit code 2 by default', () => {
    const { exitCode, output, stderr } = respondFor(ACTIONS.STOP, ['handoff ignored 5x']);
    assert.equal(exitCode, 2);
    assert.equal(output, null);
    assert.match(stderr, /\[warden\]/);
  });

  test('STOP falls back to advisory when WARDEN_DISABLE_STOP_BLOCK is set', () => {
    process.env.WARDEN_DISABLE_STOP_BLOCK = '1';
    try {
      const { exitCode, output } = respondFor(ACTIONS.STOP, ['handoff ignored 5x']);
      assert.equal(exitCode, 0);
      assert.match(output.hookSpecificOutput.additionalContext, /\[warden\]/);
    } finally {
      delete process.env.WARDEN_DISABLE_STOP_BLOCK;
    }
  });
});

describe('respondFor advisory actions', () => {
  for (const action of [ACTIONS.COMPACT, ACTIONS.CHECKPOINT, ACTIONS.HANDOFF]) {
    test(`${action} sets a top-level systemMessage so Claude Code renders it in the transcript, not just additionalContext`, () => {
      const { exitCode, output } = respondFor(action, ['context high']);
      assert.equal(exitCode, 0);
      assert.ok(
        output.systemMessage,
        'systemMessage must be set — additionalContext alone is silent to the user',
      );
      assert.equal(output.systemMessage, output.hookSpecificOutput.additionalContext);
    });
  }

  test("also mirrors the message to stderr, since systemMessage doesn't reliably render (anthropics/claude-code#50542)", () => {
    const { stderr, output } = respondFor(ACTIONS.COMPACT, ['context high']);
    assert.equal(stderr, output.systemMessage);
  });
});

describe('logDecisionAndNotify', () => {
  test('calls maybeNotifyHuman after logging, reachable from an injected execFileFn', () => {
    // native.js's logDecision now accepts an injectable logFilePath, so this
    // test uses a temp file instead of the real SHARED_LOG_FILE — avoids
    // racing with other test files (e.g. codex-actuator.test.js) that touch
    // the same shared log concurrently under node's parallel test runner.
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-native-notify-test-${process.hrtime.bigint()}.jsonl`,
    );

    process.env.WARDEN_NOTIFY = '1';
    try {
      const sessionKey = `/transcripts/notify-${process.hrtime.bigint()}.jsonl`;
      // Seed NOTIFY_TURN_LIMIT - 1 prior HANDOFF entries so this call's own
      // log write lands exactly on the milestone.
      const entries = Array.from({ length: 2 }, () => ({
        sessionKey,
        action: ACTIONS.HANDOFF,
      }));
      fs.writeFileSync(logFilePath, entries.map((e) => JSON.stringify(e) + '\n').join(''));

      const calls = [];
      const execFileFn = (cmd, args, cb) => {
        calls.push({ cmd, args });
        cb(null);
      };

      const state = { contextUsedPct: 0.5, compactionCount: 0, sessionAgeMinutes: 1 };
      const decision = { action: ACTIONS.HANDOFF, reasons: ['handoff ignored'] };

      logDecisionAndNotify(decision, state, sessionKey, sessionKey, { execFileFn }, logFilePath);

      assert.equal(calls.length, 1, 'maybeNotifyHuman must reach execFileFn via notifyHuman');
    } finally {
      delete process.env.WARDEN_NOTIFY;
      if (fs.existsSync(logFilePath)) {
        fs.unlinkSync(logFilePath);
      }
    }
  });
});

describe('computeEffectiveDecision', () => {
  test('wires the transcript path through as the escalation sessionKey', () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-native-test-${process.hrtime.bigint()}.jsonl`,
    );
    const entries = Array.from({ length: 5 }, () => ({
      sessionKey: '/transcripts/wired.jsonl',
      action: ACTIONS.HANDOFF,
    }));
    fs.writeFileSync(logFilePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const decision = { action: ACTIONS.HANDOFF, reasons: ['handoff reason'] };
    const result = computeEffectiveDecision(decision, '/transcripts/wired.jsonl', logFilePath);
    assert.equal(result.action, ACTIONS.STOP);
  });

  test('leaves non-HANDOFF decisions untouched', () => {
    const decision = { action: ACTIONS.COMPACT, reasons: ['context high'] };
    assert.deepEqual(
      computeEffectiveDecision(decision, '/transcripts/wired.jsonl', SHARED_LOG_FILE),
      decision,
    );
  });
});
