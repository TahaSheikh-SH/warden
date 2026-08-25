'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WardenPlugin } = require('../../harnesses/opencode/plugin');

describe('opencode WardenPlugin fallback sessionKey', () => {
  test('includes process.pid so two same-millisecond instances cannot collide', async () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-opencode-test-pid-${process.hrtime.bigint()}.jsonl`,
    );
    const plugin = await WardenPlugin({}, { logFilePath, contextWindowTokens: 1000000 });

    await plugin.event({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            role: 'assistant',
            tokens: { input: 975000, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    });

    const lines = fs
      .readFileSync(logFilePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    assert.match(lines[0].sessionKey, new RegExp(`^opencode-${process.pid}-`));
  });
});
