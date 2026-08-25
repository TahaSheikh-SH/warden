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
    const output = { system: [] };
    await plugin['experimental.chat.system.transform']({}, output);
    assert.equal(output.system.length, 1);
  });

  test('suppresses the same action on the next turn', async () => {
    const { plugin, toasts } = await pluginWithToastLog(tempLogFilePath());
    await plugin.event(assistantEvent('msg_1', 150000));
    // Drain the first turn's injection, so what the second turn queues (or
    // doesn't) is what this asserts on.
    await plugin['experimental.chat.system.transform']({}, { system: [] });

    await plugin.event(assistantEvent('msg_2', 160000));

    assert.equal(toasts.length, 1);
    const output = { system: [] };
    await plugin['experimental.chat.system.transform']({}, output);
    assert.equal(output.system.length, 0);
  });

  test('still shows a nudge when the action escalates to a different one', async () => {
    const { plugin, toasts } = await pluginWithToastLog(tempLogFilePath());
    await plugin.event(assistantEvent('msg_1', 150000)); // COMPACT floor
    await plugin.event(assistantEvent('msg_2', 160000)); // same action, suppressed
    await plugin.event(assistantEvent('msg_3', 300000)); // HANDOFF floor

    assert.equal(toasts.length, 2);
    assert.notEqual(toasts[0].body.message, toasts[1].body.message);
  });

  test('keeps blocking tool calls while STOP holds, even on a suppressed turn', async () => {
    const logFilePath = tempLogFilePath();
    const { plugin } = await pluginWithToastLog(logFilePath);
    // Five consecutive ignored HANDOFFs escalate to STOP; dedup must not stop
    // the escalation counter from being logged each turn.
    for (let turn = 1; turn <= 6; turn += 1) {
      await plugin.event(assistantEvent(`msg_${turn}`, 300000 + turn));
    }

    await assert.rejects(() => plugin['tool.execute.before']());
  });
});
