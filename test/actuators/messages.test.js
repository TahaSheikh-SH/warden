'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { nudgeMessageFor } = require('../../actuators/messages');
const { ACTIONS } = require('../../decide');

describe('nudgeMessageFor COMPACT with state', () => {
  test('includes cost and latency clause when contextWindowTokens is known', () => {
    const state = {
      contextWindowTokens: 100000,
      contextUsedTokens: 80000,
    };
    const message = nudgeMessageFor(ACTIONS.COMPACT, ['context high'], state);
    assert.match(message, /Context usage is high/);
    assert.match(message, /Run \/compact/);
    assert.match(message, /Compaction costs/);
    assert.match(message, /153s latency/);
  });

  test('includes dollar amount in cost clause', () => {
    const state = {
      contextWindowTokens: 100000,
      contextUsedTokens: 80000,
    };
    const message = nudgeMessageFor(ACTIONS.COMPACT, ['context high'], state);
    assert.match(message, /\$[\d.]+/);
  });

  // Cost depends only on tokens in context, so an unknown window must not
  // suppress it — the absolute-token floors can still fire a COMPACT there.
  test('still prices compaction when contextWindowTokens is null', () => {
    const state = {
      contextWindowTokens: null,
      contextUsedTokens: 80000,
    };
    const message = nudgeMessageFor(ACTIONS.COMPACT, ['context high'], state);
    assert.match(message, /Context usage is high/);
    assert.match(message, /Run \/compact/);
    assert.match(message, /Compaction costs/);
  });

  test('omits cost clause when contextUsedTokens is unknown', () => {
    const state = {
      contextWindowTokens: 1000000,
      contextUsedTokens: null,
    };
    const message = nudgeMessageFor(ACTIONS.COMPACT, ['context high'], state);
    assert.doesNotMatch(message, /Compaction costs/);
  });

  // Same token count, dearer model — the clause must track state.model
  // rather than always quoting the default row.
  test('prices with the session model when state carries one', () => {
    const base = { contextUsedTokens: 500000 };
    const dollarsIn = (message) => Number(message.match(/\$([\d.]+)/)[1]);
    const withDefault = dollarsIn(nudgeMessageFor(ACTIONS.COMPACT, ['x'], base));
    const withOpus = dollarsIn(
      nudgeMessageFor(ACTIONS.COMPACT, ['x'], { ...base, model: 'claude-opus-5' }),
    );
    assert.ok(withOpus > withDefault, `${withOpus} should exceed ${withDefault}`);
  });

  test('omits cost clause when state is null', () => {
    const message = nudgeMessageFor(ACTIONS.COMPACT, ['context high'], null);
    assert.match(message, /Context usage is high/);
    assert.doesNotMatch(message, /Compaction costs/);
  });

  test('omits cost clause when state is undefined', () => {
    const message = nudgeMessageFor(ACTIONS.COMPACT, ['context high'], undefined);
    assert.match(message, /Context usage is high/);
    assert.doesNotMatch(message, /Compaction costs/);
  });

  test('handles very small contextWindowTokens gracefully', () => {
    const state = {
      contextWindowTokens: 1000,
      contextUsedTokens: 800,
    };
    const message = nudgeMessageFor(ACTIONS.COMPACT, ['context high'], state);
    assert.match(message, /Compaction costs/);
    // Should produce valid output without NaN or errors
    assert.ok(message.includes('$'));
  });

  test('omits cost clause when contextUsedTokens is zero', () => {
    const state = {
      contextWindowTokens: 100000,
      contextUsedTokens: 0,
    };
    const message = nudgeMessageFor(ACTIONS.COMPACT, ['context high'], state);
    assert.doesNotMatch(message, /Compaction costs/);
  });
});

describe('nudgeMessageFor non-COMPACT actions', () => {
  test('CHECKPOINT ignores state and omits cost clause', () => {
    const state = {
      contextWindowTokens: 100000,
      contextUsedTokens: 80000,
    };
    const message = nudgeMessageFor(ACTIONS.CHECKPOINT, ['repeated compaction'], state);
    assert.match(message, /Checkpoint recommended/);
    assert.doesNotMatch(message, /Compaction costs/);
    assert.doesNotMatch(message, /latency/);
  });

  test('HANDOFF ignores state and omits cost clause', () => {
    const state = {
      contextWindowTokens: 100000,
      contextUsedTokens: 80000,
    };
    const message = nudgeMessageFor(ACTIONS.HANDOFF, ['context severe'], state);
    assert.match(message, /should be handed off/);
    assert.doesNotMatch(message, /Compaction costs/);
  });

  test('STOP ignores state and omits cost clause', () => {
    const state = {
      contextWindowTokens: 100000,
      contextUsedTokens: 80000,
    };
    const message = nudgeMessageFor(ACTIONS.STOP, ['ignored too long'], state);
    assert.match(message, /should stop/);
    assert.doesNotMatch(message, /Compaction costs/);
  });

  test('CONTINUE returns null regardless of state', () => {
    const state = {
      contextWindowTokens: 100000,
      contextUsedTokens: 80000,
    };
    const message = nudgeMessageFor(ACTIONS.CONTINUE, ['within thresholds'], state);
    assert.equal(message, null);
  });

  test('unrecognized action returns null', () => {
    const message = nudgeMessageFor('UNKNOWN_ACTION', ['reason']);
    assert.equal(message, null);
  });
});

describe('nudgeMessageFor reason handling', () => {
  test('joins multiple reasons with semicolons', () => {
    const state = {
      contextWindowTokens: 100000,
      contextUsedTokens: 80000,
    };
    const message = nudgeMessageFor(ACTIONS.COMPACT, ['reason 1', 'reason 2'], state);
    assert.match(message, /reason 1; reason 2/);
  });

  test('handles single reason', () => {
    const state = {
      contextWindowTokens: 100000,
      contextUsedTokens: 80000,
    };
    const message = nudgeMessageFor(ACTIONS.COMPACT, ['single reason'], state);
    assert.match(message, /single reason/);
  });
});

describe('nudgeMessageFor backward compatibility', () => {
  test('COMPACT works without state parameter (cost clause omitted)', () => {
    const message = nudgeMessageFor(ACTIONS.COMPACT, ['context high']);
    assert.match(message, /Context usage is high/);
    assert.doesNotMatch(message, /Compaction costs/);
  });

  test('non-COMPACT actions work without state parameter', () => {
    const message = nudgeMessageFor(ACTIONS.CHECKPOINT, ['repeated compaction']);
    assert.match(message, /Checkpoint recommended/);
  });
});
