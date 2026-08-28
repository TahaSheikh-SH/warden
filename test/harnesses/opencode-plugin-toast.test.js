'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const {
  WardenPlugin,
  showToastForAction,
  appendPromptForAction,
} = require('../../harnesses/opencode/plugin');
const { ACTIONS } = require('../../decide');

describe('WardenPlugin toast wiring', () => {
  test('a non-CONTINUE decision also fires client.tui.showToast with a warning variant', async () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-opencode-test-${process.hrtime.bigint()}.jsonl`,
    );
    const toastCalls = [];
    const client = {
      tui: {
        showToast: async (toastOptions) => toastCalls.push(toastOptions),
        appendPrompt: async () => {},
      },
    };
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

  test('a non-CONTINUE decision also appends the nudge into the prompt box', async () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-opencode-test-prompt-${process.hrtime.bigint()}.jsonl`,
    );
    const promptCalls = [];
    const client = {
      tui: {
        showToast: async () => {},
        appendPrompt: async ({ body }) => promptCalls.push(body),
      },
    };
    const plugin = await WardenPlugin({ client }, { logFilePath, contextWindowTokens: 1000000 });
    await plugin.event({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            sessionID: 'ses_5',
            tokens: { input: 975000, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    });

    assert.equal(promptCalls.length, 1);
    assert.match(promptCalls[0].text, /\[warden\]/);
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

  test('mirrors the nudge to stderr instead of throwing when showToast rejects', async () => {
    const writes = [];
    const client = {
      tui: {
        showToast: async () => {
          throw new Error('tui unavailable');
        },
      },
    };
    await showToastForAction(client, ACTIONS.COMPACT, 'stderr-visible message', {
      stderrWrite: (s) => writes.push(s),
    });
    assert.equal(writes.length, 1);
    assert.match(writes[0], /stderr-visible message/);
  });

  test('times out a hanging showToast and falls back to stderr', async () => {
    const writes = [];
    const client = {
      tui: {
        showToast: () => new Promise(() => {}), // never resolves
      },
    };
    await showToastForAction(client, ACTIONS.COMPACT, 'hang message', {
      timeoutMs: 10,
      stderrWrite: (s) => writes.push(s),
    });
    assert.equal(writes.length, 1);
    assert.match(writes[0], /hang message/);
  });

  test('does not write to stderr when showToast succeeds', async () => {
    const writes = [];
    const client = {
      tui: {
        showToast: async () => ({ data: true }),
      },
    };
    await showToastForAction(client, ACTIONS.COMPACT, 'ok message', {
      timeoutMs: 50,
      stderrWrite: (s) => writes.push(s),
    });
    assert.equal(writes.length, 0);
  });
});

describe('appendPromptForAction', () => {
  test('does nothing when client is absent', async () => {
    await assert.doesNotReject(() => appendPromptForAction(null, 'msg'));
  });

  test('does nothing when client.tui.appendPrompt is missing', async () => {
    await assert.doesNotReject(() => appendPromptForAction({ tui: {} }, 'msg'));
  });

  test('sends the message as the prompt text', async () => {
    const calls = [];
    const client = { tui: { appendPrompt: async ({ body }) => calls.push(body) } };
    await appendPromptForAction(client, '[warden] fyi');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, '[warden] fyi');
  });

  test('times out a hanging appendPrompt and falls back to stderr', async () => {
    const writes = [];
    const client = {
      tui: {
        appendPrompt: () => new Promise(() => {}), // never resolves
      },
    };
    await appendPromptForAction(client, '[warden] hang', {
      timeoutMs: 10,
      stderrWrite: (s) => writes.push(s),
    });
    assert.equal(writes.length, 1);
    assert.match(writes[0], /\[warden\] hang/);
  });
});
