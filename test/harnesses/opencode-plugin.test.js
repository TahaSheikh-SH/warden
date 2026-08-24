'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WardenPlugin } = require('../../harnesses/opencode/plugin');

describe('WardenPlugin', () => {
  test('is an async factory that accepts PluginInput and returns a hooks object', async () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-opencode-test-${process.hrtime.bigint()}.jsonl`,
    );
    const plugin = await WardenPlugin({ directory: '/repo', worktree: '/repo' }, { logFilePath });
    assert.equal(typeof plugin.event, 'function');
    assert.equal(typeof plugin['experimental.chat.system.transform'], 'function');
    assert.equal(typeof plugin['tool.execute.before'], 'function');
  });

  test('tool.execute.before does not throw while no STOP has been reached', async () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-opencode-test-${process.hrtime.bigint()}.jsonl`,
    );
    const plugin = await WardenPlugin({}, { logFilePath });
    await assert.doesNotReject(() => plugin['tool.execute.before']());
  });

  test('event handler does not throw on a CONTINUE-decision event', async () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-opencode-test-${process.hrtime.bigint()}.jsonl`,
    );
    const plugin = await WardenPlugin({}, { logFilePath });
    await assert.doesNotReject(() =>
      plugin.event({
        event: {
          type: 'message.updated',
          properties: {
            info: {
              role: 'assistant',
              sessionID: 'ses_2',
              tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          },
        },
      }),
    );
  });

  test('a non-CONTINUE decision is injected into the next system-prompt transform, then cleared', async () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-opencode-test-${process.hrtime.bigint()}.jsonl`,
    );
    const plugin = await WardenPlugin({}, { logFilePath });
    await plugin.event({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            sessionID: 'ses_3',
            tokens: { input: 975000, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    });

    const output = { system: [] };
    await plugin['experimental.chat.system.transform']({}, output);
    assert.equal(output.system.length, 1);
    assert.match(output.system[0], /\[warden\]/);

    const secondOutput = { system: [] };
    await plugin['experimental.chat.system.transform']({}, secondOutput);
    assert.equal(secondOutput.system.length, 0);
  });
});

describe('WardenPlugin human notify wiring', () => {
  test('calls maybeNotifyHuman via an injected execFileFn once NOTIFY_TURN_LIMIT is reached', async () => {
    process.env.WARDEN_NOTIFY = '1';
    try {
      const logFilePath = path.join(
        os.tmpdir(),
        `warden-opencode-test-notify-${process.hrtime.bigint()}.jsonl`,
      );
      const calls = [];
      const execFileFn = (command, commandArgs, callback) => {
        calls.push({ cmd: command, args: commandArgs });
        callback(null);
      };
      const plugin = await WardenPlugin({}, { logFilePath, notifyOpts: { execFileFn } });
      const sessionID = 'ses_notify';

      const handoffEvent = {
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            sessionID,
            tokens: { input: 975000, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      };

      for (let turn = 0; turn < 3; turn++) {
        await plugin.event({ event: handoffEvent });
      }

      assert.ok(calls.length >= 1, 'maybeNotifyHuman must reach execFileFn via notifyHuman');
    } finally {
      delete process.env.WARDEN_NOTIFY;
    }
  });
});

describe('WardenPlugin STOP escalation', () => {
  test('escalates to STOP after GRACE_TURN_LIMIT consecutive ignored HANDOFF decisions for the same session, using an injected temp log file', async () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-opencode-test-escalate-${process.hrtime.bigint()}.jsonl`,
    );
    const plugin = await WardenPlugin({}, { logFilePath });
    const sessionID = 'ses_escalate';

    const handoffEvent = {
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          sessionID,
          tokens: { input: 975000, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    };

    let finalOutput;
    for (let turn = 0; turn < 6; turn++) {
      await plugin.event({ event: handoffEvent });
      finalOutput = { system: [] };
      await plugin['experimental.chat.system.transform']({}, finalOutput);
    }

    assert.match(finalOutput.system[0], /stop/i);
    assert.ok(
      fs.existsSync(logFilePath),
      'escalation must log to the injected path, not the real default',
    );

    // Regression test for finding #5: OpenCode has no turn/generation-abort
    // hook, but tool.execute.before CAN throw to reject a tool call — once
    // STOP is the effective decision, that's now real enforcement, not just
    // a toast/system-prompt nudge.
    await assert.rejects(() => plugin['tool.execute.before']());
  });

  test('falls back to a per-plugin-instance synthetic sessionKey when info.sessionID is absent, instead of collapsing sessions into one bucket', async () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-opencode-test-null-session-${process.hrtime.bigint()}.jsonl`,
    );
    const plugin = await WardenPlugin({}, { logFilePath });

    await plugin.event({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            // no sessionID
            tokens: { input: 975000, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    });

    const lines = fs
      .readFileSync(logFilePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].sessionKey, 'sessionKey must not be null/falsy');
    assert.match(lines[0].sessionKey, /^opencode-/);
  });

  test('logs/escalates once per completed assistant message, not once per message.updated event', async () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-opencode-test-per-message-${process.hrtime.bigint()}.jsonl`,
    );
    const plugin = await WardenPlugin({}, { logFilePath });
    const sessionID = 'ses_streaming';
    const messageId = 'msg_1';

    const streamingEvent = {
      type: 'message.updated',
      properties: {
        info: {
          id: messageId,
          role: 'assistant',
          sessionID,
          tokens: { input: 975000, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    };

    // Simulate the same assistant message streaming: many events, same
    // info.id. Only the first should be logged/escalated.
    for (let i = 0; i < 4; i++) {
      await plugin.event({ event: streamingEvent });
    }

    const lines = fs
      .readFileSync(logFilePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    assert.equal(lines.length, 1, 'repeat updates to the same in-progress message must not re-log');

    // A genuinely new message (different id) must be processed again.
    await plugin.event({
      event: {
        type: 'message.updated',
        properties: {
          info: { ...streamingEvent.properties.info, id: 'msg_2' },
        },
      },
    });
    const linesAfter = fs
      .readFileSync(logFilePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    assert.equal(linesAfter.length, 2, 'a new message id must still be logged');
  });
});
