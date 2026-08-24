'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  evaluateCodexSession,
  respondFor,
  computeEffectiveDecision,
  logDecisionAndNotify,
} = require('../../harnesses/codex/actuator');
const { ACTIONS } = require('../../decide');

function line(obj) {
  return JSON.stringify(obj);
}

describe('codex actuator respondFor', () => {
  test('CONTINUE produces no output (nothing to nudge)', () => {
    assert.equal(respondFor(ACTIONS.CONTINUE, []), null);
  });

  test('COMPACT produces an additionalContext nudge naming /compact', () => {
    const output = respondFor(ACTIONS.COMPACT, ['context at 92%']);
    assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(output.hookSpecificOutput.additionalContext, /compact/);
  });

  test('COMPACT also sets a top-level systemMessage so Codex renders it visibly, not just additionalContext', () => {
    const output = respondFor(ACTIONS.COMPACT, ['context at 92%']);
    assert.ok(
      output.systemMessage,
      'systemMessage must be set — additionalContext alone is silent to the user',
    );
    assert.equal(output.systemMessage, output.hookSpecificOutput.additionalContext);
  });

  test("COMPACT also mirrors the message to stderr, since systemMessage doesn't reliably render (anthropics/claude-code#50542)", () => {
    const output = respondFor(ACTIONS.COMPACT, ['context at 92%']);
    assert.equal(output.stderr, output.systemMessage);
  });

  test('STOP sets continue:false with a stopReason', () => {
    const output = respondFor(ACTIONS.STOP, ['handoff ignored 5x']);
    assert.equal(output.continue, false);
    assert.match(output.stopReason, /\[warden\]/);
  });
});

describe('codex actuator computeEffectiveDecision', () => {
  test('wires the transcript path through as the escalation sessionKey', () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-codex-actuator-escalate-${process.pid}.jsonl`,
    );
    const entries = Array.from({ length: 5 }, () => ({
      sessionKey: '/transcripts/wired.jsonl',
      action: ACTIONS.HANDOFF,
    }));
    fs.writeFileSync(logFilePath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');

    const decision = { action: ACTIONS.HANDOFF, reasons: ['handoff reason'] };
    const result = computeEffectiveDecision(decision, '/transcripts/wired.jsonl', logFilePath);
    assert.equal(result.action, ACTIONS.STOP);
  });
});

describe('codex actuator logDecisionAndNotify', () => {
  test('calls maybeNotifyHuman after logging, reachable from an injected execFileFn', () => {
    // logDecision now accepts an injectable logFilePath, so this test uses a
    // temp file instead of the real SHARED_LOG_FILE — avoids racing with
    // other test files (e.g. native.test.js) that touch the same shared log
    // concurrently under node's parallel test runner.
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-codex-notify-test-${process.hrtime.bigint()}.jsonl`,
    );

    process.env.WARDEN_NOTIFY = '1';
    try {
      const sessionKey = `/transcripts/codex-notify-${process.hrtime.bigint()}.jsonl`;
      const entries = Array.from({ length: 2 }, () => ({
        sessionKey,
        action: ACTIONS.HANDOFF,
      }));
      fs.writeFileSync(logFilePath, entries.map((entry) => JSON.stringify(entry) + '\n').join(''));

      const calls = [];
      const execFileFn = (command, commandArgs, callback) => {
        calls.push({ cmd: command, args: commandArgs });
        callback(null);
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

describe('codex actuator evaluateCodexSession', () => {
  test('reduces a fixture rollout and returns a CONTINUE decision when usage is low', async () => {
    const tmpFile = path.join(os.tmpdir(), `warden-codex-actuator-${process.pid}.jsonl`);
    fs.writeFileSync(
      tmpFile,
      [
        line({
          timestamp: '2026-03-30T02:03:58.026Z',
          type: 'session_meta',
          payload: { id: 'abc', cwd: '/repo', git: { branch: 'main' } },
        }),
        line({
          timestamp: '2026-03-30T02:04:10.870Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 },
              model_context_window: 258400,
            },
          },
        }),
      ].join('\n') + '\n',
    );

    try {
      const { state, decision } = await evaluateCodexSession(tmpFile);
      assert.equal(state.sessionId, 'abc');
      assert.equal(state.contextWindowTokens, 258400);
      assert.ok(decision);
      assert.equal(decision.action, ACTIONS.CONTINUE);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
