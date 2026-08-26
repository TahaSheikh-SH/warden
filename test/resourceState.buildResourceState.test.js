'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildResourceState } = require('../resourceState');

function assistantLine(inputTokens, timestamp) {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: { usage: { input_tokens: inputTokens, output_tokens: 10 } },
  });
}

function tempTranscriptPath() {
  return path.join(os.tmpdir(), `warden-resourcestate-test-${process.hrtime.bigint()}.jsonl`);
}

function cacheFileFor(sessionFilePath) {
  const safeKey = sessionFilePath.replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = crypto.createHash('sha1').update(sessionFilePath).digest('hex').slice(0, 8);
  return path.join(os.homedir(), '.warden', 'cache', `${safeKey}-${hash}.json`);
}

describe('buildResourceState incremental cache', () => {
  test('a second call after appending lines matches a fresh full-file recompute', async () => {
    const sessionFilePath = tempTranscriptPath();
    const cacheFilePath = cacheFileFor(sessionFilePath);
    try {
      fs.writeFileSync(
        sessionFilePath,
        [
          assistantLine(1000, '2026-01-01T00:00:00Z'),
          assistantLine(2000, '2026-01-01T00:01:00Z'),
        ].join('\n') + '\n',
      );

      const first = await buildResourceState(sessionFilePath, { contextWindowTokens: 100000 });
      assert.equal(first.contextUsedTokens, 2000);
      assert.ok(fs.existsSync(cacheFilePath), 'cache file should be written after a real call');

      fs.appendFileSync(sessionFilePath, assistantLine(3000, '2026-01-01T00:02:00Z') + '\n');

      const second = await buildResourceState(sessionFilePath, { contextWindowTokens: 100000 });

      // Fresh, cache-free recompute over the full (now 3-line) file must
      // agree with the incrementally-folded result.
      fs.rmSync(cacheFilePath, { force: true });
      const fullRecompute = await buildResourceState(sessionFilePath, {
        contextWindowTokens: 100000,
      });

      assert.equal(second.contextUsedTokens, fullRecompute.contextUsedTokens);
      assert.equal(second.messageCount, fullRecompute.messageCount);
      assert.equal(second.totalInputTokens, fullRecompute.totalInputTokens);
      assert.equal(second.messageCount, 3);
    } finally {
      fs.rmSync(sessionFilePath, { force: true });
      fs.rmSync(cacheFilePath, { force: true });
    }
  });

  test('a shrunken file (reused sessionKey) invalidates the cache instead of folding onto stale totals', async () => {
    const sessionFilePath = tempTranscriptPath();
    const cacheFilePath = cacheFileFor(sessionFilePath);
    try {
      fs.writeFileSync(
        sessionFilePath,
        [
          assistantLine(1000, '2026-01-01T00:00:00Z'),
          assistantLine(2000, '2026-01-01T00:01:00Z'),
        ].join('\n') + '\n',
      );
      await buildResourceState(sessionFilePath, { contextWindowTokens: 100000 });
      assert.ok(fs.existsSync(cacheFilePath));

      // Simulate a reused sessionKey pointing at a brand new, shorter transcript.
      fs.writeFileSync(sessionFilePath, assistantLine(500, '2026-02-01T00:00:00Z') + '\n');

      const result = await buildResourceState(sessionFilePath, { contextWindowTokens: 100000 });
      assert.equal(result.messageCount, 1);
      assert.equal(result.contextUsedTokens, 500);
    } finally {
      fs.rmSync(sessionFilePath, { force: true });
      fs.rmSync(cacheFilePath, { force: true });
    }
  });

  test('opts.maxLines (partial replay) never reads or writes the incremental cache', async () => {
    const sessionFilePath = tempTranscriptPath();
    const cacheFilePath = cacheFileFor(sessionFilePath);
    try {
      fs.writeFileSync(
        sessionFilePath,
        [
          assistantLine(1000, '2026-01-01T00:00:00Z'),
          assistantLine(2000, '2026-01-01T00:01:00Z'),
        ].join('\n') + '\n',
      );
      await buildResourceState(sessionFilePath, { contextWindowTokens: 100000, maxLines: 1 });
      assert.ok(!fs.existsSync(cacheFilePath));
    } finally {
      fs.rmSync(sessionFilePath, { force: true });
      fs.rmSync(cacheFilePath, { force: true });
    }
  });
});
