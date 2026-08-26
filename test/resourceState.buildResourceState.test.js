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

  test('resumed reads skip bytes before the cached offset instead of re-streaming them', async () => {
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
      assert.equal(first.messageCount, 2);

      const cache = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
      assert.equal(typeof cache.byteOffset, 'number');

      // Corrupt every byte already folded into the cached accumulator, then
      // append a new line. A resume that ignores byteOffset and re-streams
      // from 0 hits this garbage and fails to parse anything real; a
      // correct resume never reads past the cached offset to see it.
      fs.writeFileSync(
        sessionFilePath,
        'x'.repeat(cache.byteOffset) + assistantLine(3000, '2026-01-01T00:02:00Z') + '\n',
      );

      const second = await buildResourceState(sessionFilePath, { contextWindowTokens: 100000 });
      assert.equal(second.messageCount, 3);
      assert.equal(second.contextUsedTokens, 3000);
    } finally {
      fs.rmSync(sessionFilePath, { force: true });
      fs.rmSync(cacheFilePath, { force: true });
    }
  });

  // Regression: a cache written by an older warden build (missing a field
  // the current fold logic assumes exists, e.g. recentToolCalls) used to
  // throw `Cannot read properties of undefined (reading 'push')` on the next
  // fold — and since writeAccumulatorCache is downstream of that throw, the
  // poisoned cache was never replaced. Warden was then dead for the session
  // until the 30-day sweep. A schema version on the cache payload lets a
  // mismatch (or absence, for a cache predating the field entirely) be
  // detected and invalidated before it's ever folded onto.
  test('a cache with a schema-version mismatch is invalidated, not folded onto', async () => {
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

      if (!fs.existsSync(path.dirname(cacheFilePath))) {
        fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
      }
      // Simulates a cache written by an old schema version — accumulator is
      // missing recentToolCalls entirely, which would throw on the next fold
      // if this cache were trusted and folded onto.
      fs.writeFileSync(
        cacheFilePath,
        JSON.stringify({
          schemaVersion: -1,
          lineCount: 1,
          byteOffset: 0,
          fileSize: 1,
          accumulator: { messageCount: 999 },
        }),
      );

      const state = await buildResourceState(sessionFilePath, { contextWindowTokens: 100000 });
      assert.equal(state.messageCount, 2, 'must recompute fresh, not trust the mismatched cache');
      assert.equal(state.contextUsedTokens, 2000);
    } finally {
      fs.rmSync(sessionFilePath, { force: true });
      fs.rmSync(cacheFilePath, { force: true });
    }
  });

  test('a cache with no schemaVersion field at all (pre-versioning build) is invalidated', async () => {
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

      if (!fs.existsSync(path.dirname(cacheFilePath))) {
        fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
      }
      // No schemaVersion key at all — the accumulator shape here is also
      // missing recentToolCalls, reproducing the exact TypeError from the
      // real regression (Cannot read properties of undefined (reading
      // 'push')) if this cache were folded onto instead of invalidated.
      fs.writeFileSync(
        cacheFilePath,
        JSON.stringify({
          lineCount: 1,
          byteOffset: 0,
          fileSize: 1,
          accumulator: { messageCount: 999, totalInputTokens: 0 },
        }),
      );

      const state = await buildResourceState(sessionFilePath, { contextWindowTokens: 100000 });
      assert.equal(state.messageCount, 2, 'must recompute fresh, not trust the versionless cache');
      assert.equal(state.contextUsedTokens, 2000);
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
