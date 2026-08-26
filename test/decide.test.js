'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { decide, ACTIONS, THRESHOLDS } = require('../decide');

function givenResourceState(overrides = {}) {
  return {
    contextUsedPct: 0.1,
    contextUsedTokens: 20000,
    contextGrowthPerTurn: null,
    projectedTurnsUntilOverflow: null,
    compactionCount: 0,
    sessionAgeMinutes: 10,
    turnsSinceLastCompaction: 1,
    ...overrides,
  };
}

describe('CONTINUE', () => {
  test('within all thresholds', () => {
    const state = givenResourceState();
    const decision = decide(state);
    assert.equal(decision.action, ACTIONS.CONTINUE);
  });
});

describe('HANDOFF', () => {
  test('just under handoff threshold does not fire', () => {
    const state = givenResourceState({ contextUsedPct: THRESHOLDS.handoffContextPct - 0.001 });
    const decision = decide(state);
    assert.notEqual(decision.action, ACTIONS.HANDOFF);
  });

  test('at handoff threshold fires', () => {
    const state = givenResourceState({ contextUsedPct: THRESHOLDS.handoffContextPct });
    const decision = decide(state);
    assert.equal(decision.action, ACTIONS.HANDOFF);
  });

  test('just over handoff threshold fires', () => {
    const state = givenResourceState({ contextUsedPct: THRESHOLDS.handoffContextPct + 0.001 });
    const decision = decide(state);
    assert.equal(decision.action, ACTIONS.HANDOFF);
  });

  // Task 3: handoffContextTokens (200000) had no valid citation and was
  // deleted — see reference/source-verification.md. HANDOFF now has no
  // absolute-token floor, only the pct threshold above.
  test('no absolute token floor exists for HANDOFF — huge token count alone does not fire it', () => {
    const state = givenResourceState({ contextUsedPct: 0.1, contextUsedTokens: 999999999 });
    const decision = decide(state);
    assert.notEqual(decision.action, ACTIONS.HANDOFF);
  });

  test('THRESHOLDS no longer defines handoffContextTokens', () => {
    assert.equal(THRESHOLDS.handoffContextTokens, undefined);
  });
});

describe('COMPACT', () => {
  test('just under compact threshold does not fire', () => {
    const state = givenResourceState({ contextUsedPct: THRESHOLDS.compactContextPct - 0.001 });
    const decision = decide(state);
    assert.notEqual(decision.action, ACTIONS.COMPACT);
  });

  test('at compact threshold fires', () => {
    const state = givenResourceState({ contextUsedPct: THRESHOLDS.compactContextPct });
    const decision = decide(state);
    assert.equal(decision.action, ACTIONS.COMPACT);
  });

  test('just over compact threshold fires', () => {
    const state = givenResourceState({ contextUsedPct: THRESHOLDS.compactContextPct + 0.001 });
    const decision = decide(state);
    assert.equal(decision.action, ACTIONS.COMPACT);
  });

  test('absolute token floor fires even at low contextUsedPct (large window)', () => {
    const state = givenResourceState({
      contextUsedPct: 0.05,
      contextUsedTokens: THRESHOLDS.compactContextTokens,
    });
    const decision = decide(state);
    assert.equal(decision.action, ACTIONS.COMPACT);
  });

  test('below absolute token floor and pct threshold does not fire', () => {
    const state = givenResourceState({
      contextUsedPct: 0.05,
      contextUsedTokens: THRESHOLDS.compactContextTokens - 1,
    });
    const decision = decide(state);
    assert.notEqual(decision.action, ACTIONS.COMPACT);
  });

  test('burn rate trigger fires ahead of static threshold when projected overflow is imminent', () => {
    const state = givenResourceState({
      contextUsedPct: THRESHOLDS.minPctForBurnRateTrigger + 0.01,
      contextGrowthPerTurn: 50000,
      projectedTurnsUntilOverflow: THRESHOLDS.burnRateMinTurnsUntilOverflow,
    });
    const decision = decide(state);
    assert.equal(decision.action, ACTIONS.COMPACT);
  });

  test('burn rate trigger does not false-positive below minPctForBurnRateTrigger floor', () => {
    const state = givenResourceState({
      contextUsedPct: THRESHOLDS.minPctForBurnRateTrigger - 0.01,
      contextGrowthPerTurn: 50000,
      projectedTurnsUntilOverflow: 1,
    });
    const decision = decide(state);
    assert.notEqual(decision.action, ACTIONS.COMPACT);
  });

  test('burn rate trigger does not fire when projected overflow is far out', () => {
    const state = givenResourceState({
      contextUsedPct: THRESHOLDS.minPctForBurnRateTrigger + 0.01,
      contextGrowthPerTurn: 100,
      projectedTurnsUntilOverflow: THRESHOLDS.burnRateMinTurnsUntilOverflow + 1,
    });
    const decision = decide(state);
    assert.notEqual(decision.action, ACTIONS.COMPACT);
  });
});

describe('CHECKPOINT', () => {
  // Task 6: the decay backtest (reference/compaction-backtest.md) found no N
  // at which repeated compaction measurably degrades a session — the
  // checkpointContextPct gate this rule used to require is gone. The rule now
  // fires on compactionCount alone, justified by measured cost (~55k
  // token-equivalents of cache re-write per compaction), not decay.
  test('repeated compaction tripwire fires on compaction count alone, even at low contextUsedPct', () => {
    const state = givenResourceState({
      contextUsedPct: 0.1,
      compactionCount: THRESHOLDS.checkpointCompactionCount,
    });
    const decision = decide(state);
    assert.equal(decision.action, ACTIONS.CHECKPOINT);
  });

  test('repeated compaction tripwire does not fire below compaction count', () => {
    const state = givenResourceState({
      contextUsedPct: 0.1,
      compactionCount: THRESHOLDS.checkpointCompactionCount - 1,
    });
    const decision = decide(state);
    assert.notEqual(decision.action, ACTIONS.CHECKPOINT);
  });

  test('repeated compaction tripwire still fires once pct reaches the compact threshold (regression: COMPACT must not shadow it)', () => {
    const state = givenResourceState({
      contextUsedPct: THRESHOLDS.compactContextPct,
      compactionCount: THRESHOLDS.checkpointCompactionCount,
    });
    const decision = decide(state);
    assert.equal(decision.action, ACTIONS.CHECKPOINT);
  });

  test('long-uncompacted-session tripwire fires at the turn threshold', () => {
    const state = givenResourceState({
      turnsSinceLastCompaction: THRESHOLDS.checkpointTurnsSinceCompaction,
    });
    const decision = decide(state);
    assert.equal(decision.action, ACTIONS.CHECKPOINT);
  });

  test('long-uncompacted-session tripwire does not fire below the turn threshold', () => {
    const state = givenResourceState({
      turnsSinceLastCompaction: THRESHOLDS.checkpointTurnsSinceCompaction - 1,
    });
    const decision = decide(state);
    assert.notEqual(decision.action, ACTIONS.CHECKPOINT);
  });
});

// Task 3: pins every cited threshold value so an edit to the number fails
// loudly here rather than silently drifting from its citation in
// reference/source-verification.md / README.md's "Why these thresholds".
describe('THRESHOLDS regression — every value must match its citation', () => {
  test('pinned values', () => {
    assert.deepEqual(THRESHOLDS, {
      handoffContextPct: 0.92,
      compactContextPct: 0.7,
      compactContextTokens: 100000,
      checkpointCompactionCount: 2,
      checkpointTurnsSinceCompaction: 300,
      burnRateMinTurnsUntilOverflow: 3,
      minPctForBurnRateTrigger: 0.5,
    });
  });
});

describe('Task 12 — repeated file access observation', () => {
  function withToolCalls(path, count, windowSize = count) {
    const calls = [];
    for (let i = 0; i < windowSize - count; i += 1) {
      calls.push({ toolName: 'Read', targetPath: `other${i}.js` });
    }
    for (let i = 0; i < count; i += 1) {
      calls.push({ toolName: 'Read', targetPath: path });
    }
    return calls;
  }

  test('CHECKPOINT reason gains an observation when a file was accessed repeatedly', () => {
    const state = givenResourceState({
      compactionCount: THRESHOLDS.checkpointCompactionCount,
      recentToolCalls: withToolCalls('src/foo.js', 3),
    });
    const decision = decide(state);
    assert.equal(decision.action, ACTIONS.CHECKPOINT);
    assert.ok(decision.reasons.some((r) => r.includes('src/foo.js accessed 3 times')));
  });

  test('HANDOFF reason gains an observation when a file was accessed repeatedly', () => {
    const state = givenResourceState({
      contextUsedPct: THRESHOLDS.handoffContextPct,
      recentToolCalls: withToolCalls('src/bar.js', 2),
    });
    const decision = decide(state);
    assert.equal(decision.action, ACTIONS.HANDOFF);
    assert.ok(decision.reasons.some((r) => r.includes('src/bar.js accessed 2 times')));
  });

  test('no observation appended when no file was accessed more than once', () => {
    const state = givenResourceState({
      compactionCount: THRESHOLDS.checkpointCompactionCount,
      recentToolCalls: [{ toolName: 'Read', targetPath: 'a.js' }],
    });
    const decision = decide(state);
    assert.equal(decision.reasons.length, 1);
  });

  test('does not strengthen COMPACT — observation only attaches to CHECKPOINT/HANDOFF', () => {
    const state = givenResourceState({
      contextUsedPct: THRESHOLDS.compactContextPct,
      recentToolCalls: withToolCalls('src/foo.js', 5),
    });
    const decision = decide(state);
    assert.equal(decision.action, ACTIONS.COMPACT);
    assert.equal(decision.reasons.length, 1);
  });

  test('missing recentToolCalls does not throw', () => {
    const state = givenResourceState({ compactionCount: THRESHOLDS.checkpointCompactionCount });
    delete state.recentToolCalls;
    assert.doesNotThrow(() => decide(state));
  });
});

describe('STOP', () => {
  test('no current input path returns STOP — v0 never emits it (documents reachability, not a rule)', () => {
    const state = givenResourceState({
      contextUsedPct: 0.99,
      compactionCount: 99,
      sessionAgeMinutes: 9999,
      turnsSinceLastCompaction: 9999,
      contextUsedTokens: 999999,
      contextGrowthPerTurn: 99999,
      projectedTurnsUntilOverflow: 0,
    });
    const decision = decide(state);
    assert.notEqual(decision.action, ACTIONS.STOP);
  });
});
