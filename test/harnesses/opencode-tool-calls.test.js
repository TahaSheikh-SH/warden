'use strict';

// OpenCode has no on-disk transcript, so tool-call identity is
// captured at the tool.execute.before hook (already wired for the STOP
// block) rather than the event stream, which only sees the turn after
// execution.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionEvaluator, WardenPlugin } = require('../../harnesses/opencode/plugin');

describe('createSessionEvaluator.recordToolCall', () => {
  test('a recorded tool call shows up in state.recentToolCalls on the next ingest', async () => {
    const evaluator = createSessionEvaluator({ contextWindowTokens: 1000000 });
    evaluator.recordToolCall('session-1', { toolName: 'read', targetPath: 'a.js' });

    const result = await evaluator.ingest(
      {
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            sessionID: 'session-1',
            tokens: { input: 10, output: 1, cache: { read: 0, write: 0 } },
          },
        },
      },
      'fallback',
    );

    assert.deepEqual(result.state.recentToolCalls, [
      { toolName: 'read', targetPath: 'a.js', turnIndex: 0 },
    ]);
  });
});

describe('WardenPlugin tool.execute.before records tool identity', () => {
  test('records toolName and targetPath from output.args into the session', async () => {
    const plugin = await WardenPlugin(
      {},
      {
        logFilePath: require('os').tmpdir() + '/warden-opencode-toolcall-test.jsonl',
        contextWindowTokens: 1000000,
      },
    );
    await assert.doesNotReject(() =>
      plugin['tool.execute.before'](
        { tool: 'edit', sessionID: 'session-2' },
        { args: { filePath: 'b.js' } },
      ),
    );
  });
});
