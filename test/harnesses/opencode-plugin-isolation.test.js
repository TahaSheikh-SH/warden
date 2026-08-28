'use strict';

// One OpenCode server hosts every session through a single WardenPlugin
// instance (PluginInput carries no sessionID), so per-session state (nudge
// queue, STOP block, token accounting) must be keyed by sessionKey — this is
// the regression coverage for that.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { WardenPlugin } = require('../../harnesses/opencode/plugin');

// A developer with WARDEN_NOTIFY=1 exported would otherwise get real desktop
// notifications from every test here that doesn't inject an execFileFn.
delete process.env.WARDEN_NOTIFY;

describe('WardenPlugin cross-session isolation', () => {
  test('one heavy session does not leak its nudge, block, or token accounting into a concurrent session', async () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-opencode-test-isolation-${process.hrtime.bigint()}.jsonl`,
    );
    const plugin = await WardenPlugin({}, { logFilePath, contextWindowTokens: 1000000 });

    const heavyEvent = (messageId) => ({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: messageId,
            role: 'assistant',
            sessionID: 'ses_heavy',
            // 95% of the 1,000,000-token window — above handoffContextPct (0.92);
            // HANDOFF has no absolute-token floor.
            tokens: { input: 950000, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    });

    for (let turn = 1; turn <= 6; turn += 1) {
      await plugin.event(heavyEvent(`heavy_${turn}`));
    }

    const heavyOutput = {
      system: [
        'You are opencode, an interactive CLI tool that helps users with software engineering tasks.',
      ],
    };
    await plugin['experimental.chat.system.transform']({ sessionID: 'ses_heavy' }, heavyOutput);
    assert.match(heavyOutput.system[1], /stop/i, 'session A must have escalated to STOP');
    await assert.rejects(
      () => plugin['tool.execute.before']({ sessionID: 'ses_heavy' }),
      'session A tool calls must be blocked once it is STOP',
    );

    await plugin.event({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'light_1',
            role: 'assistant',
            sessionID: 'ses_light',
            tokens: { input: 500, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    });

    const lightOutput = {
      system: [
        'You are opencode, an interactive CLI tool that helps users with software engineering tasks.',
      ],
    };
    await plugin['experimental.chat.system.transform']({ sessionID: 'ses_light' }, lightOutput);
    assert.equal(
      lightOutput.system.length,
      1,
      "session B's system prompt must not receive session A's STOP nudge",
    );
    await assert.doesNotReject(
      () => plugin['tool.execute.before']({ sessionID: 'ses_light' }),
      "session B's tool calls must not be blocked by session A's STOP",
    );
  });
});
