'use strict';

// Format-drift canary. Core stays harness-agnostic (AGENTS.md) — it carries
// two generic fields every adapter can populate (harnessVersion, first-wins
// like sessionId/cwd; assistantUsageCount, how many assistant entries
// actually carried a parsed usage object) plus the one shared rule for
// deciding drift from them, so no adapter reimplements that threshold.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  foldEntry,
  finalizeAccumulator,
  initialAccumulator,
  isFormatDriftDetected,
} = require('../../core/resourceStateCore');

function entry(overrides = {}) {
  return {
    type: null,
    timestamp: null,
    usage: null,
    isCompactionBoundary: false,
    sessionId: null,
    cwd: null,
    gitBranch: null,
    ...overrides,
  };
}

describe('harnessVersion', () => {
  test('first entry to report a version wins', () => {
    const accumulator = initialAccumulator();
    foldEntry(accumulator, entry({ harnessVersion: '2.1.239' }));
    foldEntry(accumulator, entry({ harnessVersion: '2.1.999' }));
    const state = finalizeAccumulator(accumulator);
    assert.equal(state.harnessVersion, '2.1.239');
  });

  test('stays null when no entry ever reports one', () => {
    const accumulator = initialAccumulator();
    foldEntry(accumulator, entry());
    const state = finalizeAccumulator(accumulator);
    assert.equal(state.harnessVersion, null);
  });
});

describe('assistantUsageCount', () => {
  test('counts only assistant entries that carried a usage object', () => {
    const accumulator = initialAccumulator();
    foldEntry(accumulator, entry({ type: 'assistant', usage: { inputTokens: 10 } }));
    foldEntry(accumulator, entry({ type: 'assistant', usage: null }));
    foldEntry(accumulator, entry({ type: 'user' }));
    const state = finalizeAccumulator(accumulator);
    assert.equal(state.assistantUsageCount, 1);
    assert.equal(state.messageCount, 2);
  });

  test('stays 0 when every assistant entry has no usage (the drift signature)', () => {
    const accumulator = initialAccumulator();
    foldEntry(accumulator, entry({ type: 'assistant', usage: null }));
    foldEntry(accumulator, entry({ type: 'assistant', usage: null }));
    const state = finalizeAccumulator(accumulator);
    assert.equal(state.assistantUsageCount, 0);
    assert.equal(state.messageCount, 2);
  });

  // Regression: a usage *object* can be present yet carry zero real
  // tokens — e.g. claude-code/transcript.js coerces every missing field with
  // `|| 0`, so renaming a field *inside* usage (input_tokens -> prompt_tokens)
  // still produces `{inputTokens: 0, outputTokens: 0, ...}`, an object that
  // is truthy but measures nothing. Counting presence alone made the canary
  // structurally blind to this class of drift.
  test('stays 0 when every usage object is present but sums to zero real tokens', () => {
    const accumulator = initialAccumulator();
    for (let i = 0; i < 10; i += 1) {
      foldEntry(
        accumulator,
        entry({
          type: 'assistant',
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        }),
      );
    }
    const state = finalizeAccumulator(accumulator);
    assert.equal(state.assistantUsageCount, 0);
    assert.equal(state.messageCount, 10);
    assert.equal(isFormatDriftDetected(state), true);
  });

  test('counts a usage object with only cache-creation tokens as measured', () => {
    const accumulator = initialAccumulator();
    foldEntry(
      accumulator,
      entry({
        type: 'assistant',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 50 },
      }),
    );
    const state = finalizeAccumulator(accumulator);
    assert.equal(state.assistantUsageCount, 1);
  });
});

// One shared rule so every file-streaming adapter (claude-code, codex, ...)
// applies the identical threshold instead of each hand-rolling its own copy.
describe('isFormatDriftDetected', () => {
  test('fires once assistant message count clears the threshold with zero usage entries ever parsed', () => {
    assert.equal(isFormatDriftDetected({ messageCount: 4, assistantUsageCount: 0 }), true);
  });

  test('does not fire below the message-count threshold', () => {
    assert.equal(isFormatDriftDetected({ messageCount: 1, assistantUsageCount: 0 }), false);
  });

  test('does not fire once at least one usage entry parsed, however many assistant messages', () => {
    assert.equal(isFormatDriftDetected({ messageCount: 1000, assistantUsageCount: 1 }), false);
  });

  // Regression: gating on raw line count fired on the first prompt of every
  // session, since a real transcript carries many non-message record types
  // (attachment/mode/last-prompt/etc.) before the first assistant entry.
  test('100 lines with zero assistant messages is not drift', () => {
    assert.equal(isFormatDriftDetected({ messageCount: 0, assistantUsageCount: 0 }), false);
  });

  test('4 assistant messages with no usage is drift', () => {
    assert.equal(isFormatDriftDetected({ messageCount: 4, assistantUsageCount: 0 }), true);
  });
});
