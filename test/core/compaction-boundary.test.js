'use strict';

// A compact_boundary entry carries no usage of its own. Without resetting
// lastTurnContextTokens there, contextUsedTokens keeps reporting the
// pre-compaction size until the next assistant turn logs real usage — long
// enough for a hook firing right after a compact to see a stale, oversized
// number and wrongly nudge HANDOFF/STOP on a session that was just shrunk.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { reduceTranscriptEntries } = require('../../core/resourceStateCore');

function assistantTurn(usage) {
  return { type: 'assistant', timestamp: '2026-08-25T00:00:00.000Z', usage };
}

function compactionBoundary() {
  return { type: 'system', timestamp: '2026-08-25T00:00:01.000Z', isCompactionBoundary: true };
}

describe('compaction boundary resets last-turn usage', () => {
  test('contextUsedTokens drops to 0 immediately after a compaction, not the pre-compaction size', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn({ inputTokens: 200000, outputTokens: 5, cacheReadTokens: 0 }),
      compactionBoundary(),
    ]);

    assert.equal(state.contextUsedTokens, 0);
  });

  test('a real assistant turn after compaction overwrites the reset value', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn({ inputTokens: 200000, outputTokens: 5, cacheReadTokens: 0 }),
      compactionBoundary(),
      assistantTurn({ inputTokens: 500, outputTokens: 5, cacheReadTokens: 0 }),
    ]);

    assert.equal(state.contextUsedTokens, 500);
  });

  test('compactionCount still increments and the growth window still clears', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn({ inputTokens: 200000, outputTokens: 5, cacheReadTokens: 0 }),
      compactionBoundary(),
      assistantTurn({ inputTokens: 500, outputTokens: 5, cacheReadTokens: 0 }),
    ]);

    assert.equal(state.compactionCount, 1);
    assert.equal(state.contextGrowthPerTurn, null);
  });
});
