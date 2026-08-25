'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { WardenPlugin, showToastForAction } = require('../../harnesses/opencode/plugin');
const { ACTIONS } = require('../../decide');

describe('WardenPlugin toast wiring', () => {
  test('a non-CONTINUE decision also fires client.tui.showToast with a warning variant', async () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-opencode-test-${process.hrtime.bigint()}.jsonl`,
    );
    const toastCalls = [];
    const client = { tui: { showToast: async (toastOptions) => toastCalls.push(toastOptions) } };
    const plugin = await WardenPlugin({ client }, { logFilePath, contextWindowTokens: 1000000 });
    await plugin.event({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            sessionID: 'ses_4',
            tokens: { input: 975000, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    });

    assert.equal(toastCalls.length, 1);
    assert.match(toastCalls[0].body.message, /\[warden\]/);
    assert.equal(toastCalls[0].body.variant, 'warning');
  });
});

describe('showToastForAction', () => {
  test('does nothing when client is absent', async () => {
    await assert.doesNotReject(() => showToastForAction(null, ACTIONS.COMPACT, 'msg'));
  });

  test('does nothing when client.tui.showToast is missing', async () => {
    await assert.doesNotReject(() => showToastForAction({ tui: {} }, ACTIONS.COMPACT, 'msg'));
  });

  test('uses variant "error" for STOP and "warning" for everything else', async () => {
    const calls = [];
    const client = { tui: { showToast: async (toastOptions) => calls.push(toastOptions) } };
    await showToastForAction(client, ACTIONS.STOP, 'stop message');
    await showToastForAction(client, ACTIONS.HANDOFF, 'handoff message');
    assert.equal(calls[0].body.variant, 'error');
    assert.equal(calls[0].body.message, 'stop message');
    assert.equal(calls[1].body.variant, 'warning');
  });

  test('fails open (does not throw) when showToast itself rejects', async () => {
    const client = {
      tui: {
        showToast: async () => {
          throw new Error('tui unavailable');
        },
      },
    };
    await assert.doesNotReject(() => showToastForAction(client, ACTIONS.HANDOFF, 'msg'));
  });
});
