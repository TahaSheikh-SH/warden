'use strict';

// An unmeasurable value must be encoded as null, never a fabricated 0 —
// a fake 0 is indistinguishable from a real "measured empty" in a reason
// string or a log line, and on pi (see harnesses/pi/extension.js's
// trustworthiness gate) a fabricated 0% context reading became a real
// user-visible CONTINUE verdict. This file pins the null encoding at the
// core, and that decide()'s CONTINUE fallback reason renders it as "unknown"
// rather than a fake number.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { reduceTranscriptEntries } = require('../../core/resourceStateCore');
const { decide, ACTIONS } = require('../../decide');

function assistantTurn(usage) {
  return { type: 'assistant', timestamp: null, usage };
}

describe('contextUsedPct null encoding', () => {
  test('stays null (not 0) when no context window is known', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 0 }),
    ]);
    assert.equal(state.contextWindowTokens, null);
    assert.equal(state.contextUsedPct, null);
  });

  test('is a real number once a window is known', async () => {
    const state = await reduceTranscriptEntries(
      [assistantTurn({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 0 })],
      { contextWindowTokens: 1000 },
    );
    // contextUsedTokens is input + cacheRead + cacheCreation only (output
    // tokens are the model's response, not context it's carrying) = 100.
    assert.equal(state.contextUsedPct, 100 / 1000);
  });
});

describe('sessionAgeMinutes null encoding', () => {
  test('stays null (not 0) when no entry carries a timestamp', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 0 }),
    ]);
    assert.equal(state.sessionAgeMinutes, null);
  });

  test('is a real number once timestamps are present', async () => {
    const state = await reduceTranscriptEntries([
      { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', usage: { inputTokens: 1 } },
      { type: 'assistant', timestamp: '2026-01-01T00:01:00Z', usage: { inputTokens: 1 } },
    ]);
    assert.equal(state.sessionAgeMinutes, 1);
  });
});

describe('decide() CONTINUE fallback renders unknown, not a fabricated number', () => {
  function nullState(overrides = {}) {
    return {
      contextUsedPct: null,
      contextUsedTokens: 0,
      contextGrowthPerTurn: null,
      projectedTurnsUntilOverflow: null,
      compactionCount: 0,
      sessionAgeMinutes: null,
      turnsSinceLastCompaction: 0,
      ...overrides,
    };
  }

  test('does not throw and does not print a fake 0% / 0m for a fully-unmeasured state', () => {
    const state = nullState();
    const decision = decide(state);
    assert.equal(decision.action, ACTIONS.CONTINUE);
    assert.ok(
      !decision.reasons[0].includes('0.0%') && !decision.reasons[0].includes('0m'),
      `reason must not fabricate a measured zero: "${decision.reasons[0]}"`,
    );
    assert.match(decision.reasons[0], /unknown/);
  });

  // null <= n is true in JS (unlike null >= n, which is false) —
  // isBurstingBurnRate must not accidentally fire off that
  // asymmetry when contextUsedPct is null but a stale/adversarial
  // projectedTurnsUntilOverflow value is still present on the state.
  test('isBurstingBurnRate stands down when contextUsedPct is null, even if projectedTurnsUntilOverflow looks urgent', () => {
    const state = nullState({ projectedTurnsUntilOverflow: 1, contextGrowthPerTurn: 50000 });
    const decision = decide(state);
    assert.notEqual(decision.action, ACTIONS.COMPACT);
  });
});
