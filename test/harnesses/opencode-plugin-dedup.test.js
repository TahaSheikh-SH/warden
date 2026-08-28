'use strict';

// decide() is stateless, so it re-emits the same action on every turn once a
// floor is crossed. native.js and pi's extension both suppress the repeat;
// these cover the same guard in the OpenCode plugin, which is a separate code
// path from its lastProcessedMessageId guard (that one only collapses the
// repeated message.updated events of a single streaming message).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { WardenPlugin } = require('../../harnesses/opencode/plugin');

// A developer with WARDEN_NOTIFY=1 exported would otherwise get real desktop
// notifications from every test here that doesn't inject an execFileFn.
delete process.env.WARDEN_NOTIFY;

function tempLogFilePath() {
  return path.join(os.tmpdir(), `warden-opencode-dedup-${process.hrtime.bigint()}.jsonl`);
}

// Distinct `id` per call so lastProcessedMessageId doesn't absorb the second
// turn before the nudge dedup is even reached.
function assistantEvent(messageId, inputTokens) {
  return {
    event: {
      type: 'message.updated',
      properties: {
        info: {
          id: messageId,
          role: 'assistant',
          sessionID: 'ses_dedup',
          tokens: { input: inputTokens, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  };
}

async function pluginWithToastLog(logFilePath) {
  const toasts = [];
  const client = { tui: { showToast: async (options) => toasts.push(options) } };
  const plugin = await WardenPlugin({ client }, { logFilePath, contextWindowTokens: 1000000 });
  return { plugin, toasts };
}

describe('WardenPlugin nudge dedup', () => {
  test('shows the nudge on the turn it first fires', async () => {
    const { plugin, toasts } = await pluginWithToastLog(tempLogFilePath());
    await plugin.event(assistantEvent('msg_1', 150000));

    assert.equal(toasts.length, 1);
    const output = {
      system: [
        'You are opencode, an interactive CLI tool that helps users with software engineering tasks.',
      ],
    };
    await plugin['experimental.chat.system.transform']({ sessionID: 'ses_dedup' }, output);
    assert.equal(output.system.length, 2);
  });

  test('suppresses the same action on the next turn', async () => {
    const { plugin, toasts } = await pluginWithToastLog(tempLogFilePath());
    await plugin.event(assistantEvent('msg_1', 150000));
    // Drain the first turn's injection, so what the second turn queues (or
    // doesn't) is what this asserts on. Drain through a main-agent-shaped
    // transform, mirroring the real runtime's request shape.
    await plugin['experimental.chat.system.transform'](
      { sessionID: 'ses_dedup' },
      {
        system: [
          'You are opencode, an interactive CLI tool that helps users with software engineering tasks.',
        ],
      },
    );

    await plugin.event(assistantEvent('msg_2', 160000));

    assert.equal(toasts.length, 1);
    const output = {
      system: [
        'You are opencode, an interactive CLI tool that helps users with software engineering tasks.',
      ],
    };
    await plugin['experimental.chat.system.transform']({ sessionID: 'ses_dedup' }, output);
    assert.equal(output.system.length, 1);
  });

  test('still shows a nudge when the action escalates to a different one', async () => {
    const { plugin, toasts } = await pluginWithToastLog(tempLogFilePath());
    await plugin.event(assistantEvent('msg_1', 150000)); // COMPACT floor
    await plugin.event(assistantEvent('msg_2', 160000)); // same action, suppressed
    await plugin.event(assistantEvent('msg_3', 950000)); // HANDOFF floor (92% of 1M window)

    assert.equal(toasts.length, 2);
    assert.notEqual(toasts[0].body.message, toasts[1].body.message);
  });

  test('suppression does not stall the HANDOFF-to-STOP escalation', async () => {
    const { plugin, toasts } = await pluginWithToastLog(tempLogFilePath());
    // Every turn is logged even when its nudge is suppressed, so five ignored
    // HANDOFFs still escalate — one toast for the first HANDOFF, one for STOP,
    // and nothing for the four repeats in between.
    for (let turn = 1; turn <= 6; turn += 1) {
      await plugin.event(assistantEvent(`msg_${turn}`, 950000 + turn));
    }

    assert.equal(toasts.length, 2);
    assert.equal(toasts[1].body.variant, 'error');
    await assert.rejects(() => plugin['tool.execute.before']({ sessionID: 'ses_dedup' }));
  });
});
