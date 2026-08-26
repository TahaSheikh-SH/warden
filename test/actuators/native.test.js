'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getLastNudgedAction } = require('../../actuators/escalationPolicy');
const {
  respondFor,
  computeEffectiveDecision,
  logDecisionAndNotify,
} = require('../../actuators/native');
const { ACTIONS } = require('../../decide');
const { LOG_FILE: SHARED_LOG_FILE } = require('../../actuators/logStore');
const { driftWarningFor } = require('../../actuators/messages');

function withTempLogFile(entries) {
  const logFilePath = path.join(os.tmpdir(), `warden-native-test-${process.hrtime.bigint()}.jsonl`);
  const lines = entries.map((entry) => JSON.stringify(entry)).join('\n');
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
  // Task 2: exit code 2 on UserPromptSubmit erases the user's prompt
  // (Claude Code docs) — STOP must never hard-block on this harness.
  test('STOP never returns a non-zero exit code', () => {
    const { exitCode, output, stderr } = respondFor(ACTIONS.STOP, ['handoff ignored 5x']);
    assert.equal(exitCode, 0);
    assert.match(output.hookSpecificOutput.additionalContext, /\[warden\]/);
    assert.match(stderr, /\[warden\]/);
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

// CONTINUE has no nudge text at all, which is
// exactly the case a renamed transcript field falls into — drift must still
// surface here, not just on the harnesses whose action already has a message.
describe('respondFor drift warning', () => {
  test('CONTINUE with driftDetected renders the drift warning, not nothing', () => {
    const { exitCode, output, stderr } = respondFor(ACTIONS.CONTINUE, ['within thresholds'], true);
    assert.equal(exitCode, 0);
    assert.equal(stderr, driftWarningFor());
    assert.equal(output.systemMessage, driftWarningFor());
  });

  test('CONTINUE with no drift still renders nothing', () => {
    const { output, stderr } = respondFor(ACTIONS.CONTINUE, ['within thresholds'], false);
    assert.equal(output, null);
    assert.equal(stderr, undefined);
  });

  test('a real action nudge wins over a stale drift flag rather than being replaced', () => {
    const { output } = respondFor(ACTIONS.COMPACT, ['context high'], true);
    assert.match(output.systemMessage, /Context usage is high/);
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

// Regression: notifyingHumanThisTurn used to come from a shouldNotifyHuman
// call made BEFORE this turn's log entry was appended, one turn behind
// maybeNotifyHuman's own count-after-append — so on the exact turn the
// notification fired, the suppression guard below still thought no
// notification had fired and suppressed the nudge text too.
describe('notification suppression ordering', () => {
  test('nudge text is not suppressed on the turn a repeated-action notification fires', () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-native-suppression-test-${process.hrtime.bigint()}.jsonl`,
    );
    process.env.WARDEN_NOTIFY = '1';
    try {
      const sessionKey = `/transcripts/suppression-${process.hrtime.bigint()}.jsonl`;
      // Two prior HANDOFF entries: getLastNudgedAction already equals
      // HANDOFF (alreadyNudgedThisAction), and this call's own append lands
      // the trailing count exactly on NOTIFY_TURN_LIMIT (3).
      const entries = Array.from({ length: 2 }, () => ({ sessionKey, action: ACTIONS.HANDOFF }));
      fs.writeFileSync(logFilePath, entries.map((e) => JSON.stringify(e) + '\n').join(''));

      const decision = { action: ACTIONS.HANDOFF, reasons: ['handoff ignored'] };
      const alreadyNudgedThisAction =
        getLastNudgedAction(sessionKey, logFilePath) === decision.action;
      assert.equal(alreadyNudgedThisAction, true);

      const state = { contextUsedPct: 0.5, compactionCount: 0, sessionAgeMinutes: 1 };
      const notifyingHumanThisTurn = logDecisionAndNotify(
        decision,
        state,
        sessionKey,
        sessionKey,
        { execFileFn: (cmd, args, cb) => cb(null) },
        logFilePath,
      );
      assert.equal(notifyingHumanThisTurn, true);

      // Mirrors main()'s suppression expression.
      const suppressed =
        decision.action !== ACTIONS.CONTINUE && alreadyNudgedThisAction && !notifyingHumanThisTurn;
      assert.equal(suppressed, false);

      const { output } = suppressed
        ? { output: null }
        : respondFor(decision.action, decision.reasons, false);
      assert.ok(output && output.systemMessage);
    } finally {
      delete process.env.WARDEN_NOTIFY;
      if (fs.existsSync(logFilePath)) fs.unlinkSync(logFilePath);
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
