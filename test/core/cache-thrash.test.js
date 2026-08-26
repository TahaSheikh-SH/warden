'use strict';

// The cache-thrash rule needs a consecutive-turn streak counter — a write
// with no read means the 5-minute TTL likely expired between turns.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { reduceTranscriptEntries } = require('../../core/resourceStateCore');

function assistantTurn(cacheCreationTokens, cacheReadTokens) {
  return {
    type: 'assistant',
    timestamp: '2026-08-26T00:00:00.000Z',
    usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens, cacheCreationTokens },
  };
}

describe('consecutiveCacheThrashTurns', () => {
  test('increments across consecutive write-with-no-read turns', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn(500, 0),
      assistantTurn(500, 0),
      assistantTurn(500, 0),
    ]);
    assert.equal(state.consecutiveCacheThrashTurns, 3);
  });

  test('resets to 0 on a turn that reads the cache', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn(500, 0),
      assistantTurn(500, 0),
      assistantTurn(0, 400),
    ]);
    assert.equal(state.consecutiveCacheThrashTurns, 0);
  });

  test('resets to 0 when a harness reports null cache-creation (Codex) — unknown does not extend the streak', async () => {
    const state = await reduceTranscriptEntries([assistantTurn(500, 0), assistantTurn(null, 0)]);
    assert.equal(state.consecutiveCacheThrashTurns, 0);
  });

  test('a turn with cache-creation but also a read is not a thrash turn', async () => {
    const state = await reduceTranscriptEntries([assistantTurn(500, 200)]);
    assert.equal(state.consecutiveCacheThrashTurns, 0);
  });
});
