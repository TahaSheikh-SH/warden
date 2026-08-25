'use strict';

// Task 5 enabler: the core exposes a last-turn cache read/write split so a
// future cost-aware rule can price the cache instead of only sizing the
// context. No rule consumes it yet; these tests pin the contract, and in
// particular pin that "harness cannot report cache writes" stays distinct
// from "cache writes were zero".

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { reduceTranscriptEntries } = require('../../core/resourceStateCore');

function assistantTurn(usage) {
  return { type: 'assistant', timestamp: '2026-08-25T00:00:00.000Z', usage };
}

describe('last-turn cache split', () => {
  test("reports the final turn's cache read and write, not the session totals", async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1000,
        cacheCreationTokens: 100,
      }),
      assistantTurn({
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 2000,
        cacheCreationTokens: 200,
      }),
    ]);

    assert.equal(state.lastTurnCacheReadTokens, 2000);
    assert.equal(state.lastTurnCacheCreationTokens, 200);
    assert.equal(state.totalCacheReadTokens, 3000);
    assert.equal(state.totalCacheCreationTokens, 300);
  });

  test('leaves both null-safe defaults when no assistant turn carries usage', async () => {
    const state = await reduceTranscriptEntries([{ type: 'user', usage: null }]);

    assert.equal(state.lastTurnCacheReadTokens, 0);
    assert.equal(state.lastTurnCacheCreationTokens, null);
  });

  // The Codex trap: that harness has no cache-write analog, so it sends null.
  // A consumer must be able to tell that apart from a real measured zero, or
  // it would price compaction as free on Codex and never fire there.
  test('keeps an unreportable cache write as null, distinct from a measured zero', async () => {
    const unknown = await reduceTranscriptEntries([
      assistantTurn({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 500,
        cacheCreationTokens: null,
      }),
    ]);
    const measuredZero = await reduceTranscriptEntries([
      assistantTurn({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 500,
        cacheCreationTokens: 0,
      }),
    ]);

    assert.equal(unknown.lastTurnCacheCreationTokens, null);
    assert.equal(measuredZero.lastTurnCacheCreationTokens, 0);
  });

  // Totals stay additive so existing consumers keep working; an unknown write
  // contributes nothing rather than poisoning the sum with NaN.
  test('folds an unknown cache write as 0 in the totals and in context size', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 500,
        cacheCreationTokens: null,
      }),
    ]);

    assert.equal(state.totalCacheCreationTokens, 0);
    assert.equal(state.contextUsedTokens, 510);
  });
});
