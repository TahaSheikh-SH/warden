'use strict';

// Task 7 (see AGENTS.md "Keep harness-specific behavior out of the shared
// core"): sessionAgeMinutes/lastActivityAgeMinutes measured wall-clock age,
// but lastActivityAgeMinutes was always ~0 in practice (Date.now() evaluated
// in a hook that only fires because the user just typed) — a dead gate. This
// field replaces it with something derivable purely from the transcript.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { reduceTranscriptEntries } = require('../../core/resourceStateCore');

function assistantTurn(usage = { inputTokens: 100, outputTokens: 5, cacheReadTokens: 0 }) {
  return { type: 'assistant', timestamp: '2026-08-25T00:00:00.000Z', usage };
}

function compactionBoundary() {
  return { type: 'system', timestamp: '2026-08-25T00:00:01.000Z', isCompactionBoundary: true };
}

describe('turnsSinceLastCompaction', () => {
  test('counts assistant turns before any compaction', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn(),
      assistantTurn(),
      assistantTurn(),
    ]);
    assert.equal(state.turnsSinceLastCompaction, 3);
  });

  test('resets to 0 at a compaction boundary', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn(),
      assistantTurn(),
      compactionBoundary(),
    ]);
    assert.equal(state.turnsSinceLastCompaction, 0);
  });

  test('counts only turns after the most recent compaction', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn(),
      assistantTurn(),
      compactionBoundary(),
      assistantTurn(),
    ]);
    assert.equal(state.turnsSinceLastCompaction, 1);
  });
});
