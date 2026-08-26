'use strict';

// Task-8-class work (see AGENTS.md "Keep harness-specific behavior out of the
// shared core"): compactMetadata is Claude-Code-only telemetry, normalized
// into an optional `compaction` field so the core stays harness-agnostic.
// `postTokens` is a strictly better post-compaction seed than the zeroing
// fallback (commit 0064601), when a harness reports it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { reduceTranscriptEntries } = require('../../core/resourceStateCore');

function assistantTurn(usage) {
  return { type: 'assistant', timestamp: '2026-08-26T00:00:00.000Z', usage };
}

function compactionBoundary(compaction = null) {
  return {
    type: 'system',
    timestamp: '2026-08-26T00:00:01.000Z',
    isCompactionBoundary: true,
    compaction,
  };
}

describe('compaction metadata', () => {
  test('seeds lastTurnContextTokens from postTokens when present', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn({ inputTokens: 200000, outputTokens: 5, cacheReadTokens: 0 }),
      compactionBoundary({
        trigger: 'manual',
        preTokens: 200000,
        postTokens: 33482,
        durationMs: 1000,
      }),
    ]);
    assert.equal(state.contextUsedTokens, 33482);
  });

  test('falls back to zeroing when no compaction metadata is present', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn({ inputTokens: 200000, outputTokens: 5, cacheReadTokens: 0 }),
      compactionBoundary(),
    ]);
    assert.equal(state.contextUsedTokens, 0);
  });
});
