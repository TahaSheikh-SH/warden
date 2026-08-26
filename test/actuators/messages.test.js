'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { nudgeMessageFor, driftWarningFor } = require('../../actuators/messages');
const { ACTIONS } = require('../../decide');

describe('nudgeMessageFor', () => {
  test('COMPACT names the action to take', () => {
    const message = nudgeMessageFor(ACTIONS.COMPACT, ['context high']);
    assert.match(message, /Context usage is high/);
    assert.match(message, /Run \/compact/);
    assert.match(message, /context high/);
  });

  test('CHECKPOINT names the action to take', () => {
    assert.match(nudgeMessageFor(ACTIONS.CHECKPOINT, ['repeated compaction']), /Checkpoint/);
  });

  test('HANDOFF names the action to take', () => {
    assert.match(nudgeMessageFor(ACTIONS.HANDOFF, ['context severe']), /handed off/);
  });

  test('STOP names the action to take', () => {
    assert.match(nudgeMessageFor(ACTIONS.STOP, ['ignored too long']), /should stop/);
  });

  test('CONTINUE returns null', () => {
    assert.equal(nudgeMessageFor(ACTIONS.CONTINUE, ['within thresholds']), null);
  });

  test('unrecognized action returns null', () => {
    assert.equal(nudgeMessageFor('UNKNOWN_ACTION', ['reason']), null);
  });

  test('joins multiple reasons with semicolons', () => {
    assert.match(nudgeMessageFor(ACTIONS.COMPACT, ['reason 1', 'reason 2']), /reason 1; reason 2/);
  });

  // Vendor pricing only resolved on one harness, so it was removed rather
  // than quoted wrongly on the other three. Nothing in the nudge may
  // reintroduce a dollar figure without a per-harness rate source.
  test('quotes no dollar amount for any action', () => {
    for (const action of Object.values(ACTIONS)) {
      const message = nudgeMessageFor(action, ['context high']);
      if (message) assert.doesNotMatch(message, /\$/);
    }
  });
});

// A distinct message from the action nudges
// above, since drift can fire even on CONTINUE (that's the whole point —
// it's the case decide() itself can't see).
describe('driftWarningFor', () => {
  test('names the observability failure, not a decide() action', () => {
    const message = driftWarningFor();
    assert.match(message, /warden/i);
    assert.match(message, /format/i);
  });
});
