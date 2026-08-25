'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  normalizeEntry,
  contextWindowForModel,
  MODEL_CONTEXT_WINDOWS,
} = require('../../harnesses/claude-code/transcript');
const { reduceTranscriptEntries } = require('../../core/resourceStateCore');

function assistantLine(model, inputTokens) {
  return {
    type: 'assistant',
    timestamp: '2026-08-25T12:00:00.000Z',
    message: { model, usage: { input_tokens: inputTokens, output_tokens: 10 } },
  };
}

describe('contextWindowForModel', () => {
  test('resolves 1M-window models', () => {
    for (const model of [
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5',
      'claude-sonnet-4-6',
      'claude-opus-4-8',
    ]) {
      assert.equal(contextWindowForModel(model), 1000000, model);
    }
  });

  test('resolves 200k-window models', () => {
    for (const model of [
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-1',
      'claude-3-5-sonnet-20241022',
    ]) {
      assert.equal(contextWindowForModel(model), 200000, model);
    }
  });

  test('returns null for unknown, synthetic, and missing models', () => {
    assert.equal(contextWindowForModel('<synthetic>'), null);
    assert.equal(contextWindowForModel('some-other-provider/model'), null);
    assert.equal(contextWindowForModel(undefined), null);
    assert.equal(contextWindowForModel(null), null);
  });
});

const KNOWN_MODELS = [
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-fable-5',
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-1',
  'claude-3-5-sonnet-20241022',
];

describe('MODEL_CONTEXT_WINDOWS ordering', () => {
  // Guards the claim in the table's comment: the patterns are disjoint, so the
  // resolved window can't depend on which one happens to be listed first. A
  // future pattern that overlaps an existing one fails here rather than
  // silently changing an unrelated model's window.
  test('no model matches more than one pattern', () => {
    for (const model of KNOWN_MODELS) {
      const matches = MODEL_CONTEXT_WINDOWS.filter(([pattern]) => pattern.test(model));
      assert.equal(matches.length, 1, `${model} matched ${matches.length} patterns`);
    }
  });

  test('reversing the table changes nothing', () => {
    const reversed = [...MODEL_CONTEXT_WINDOWS].reverse();
    for (const model of KNOWN_MODELS) {
      const forward = MODEL_CONTEXT_WINDOWS.find(([pattern]) => pattern.test(model))[1];
      const backward = reversed.find(([pattern]) => pattern.test(model))[1];
      assert.equal(backward, forward, model);
    }
  });
});

describe('claude-code window detection reaches decide()', () => {
  test('a 200k-model session is measured against 200k, not the default', async () => {
    async function* entries() {
      yield normalizeEntry(assistantLine('claude-sonnet-4-5-20250929', 190000));
    }

    const state = await reduceTranscriptEntries(entries());

    assert.equal(state.contextWindowTokens, 200000);
    // The regression this guards: against the 1M default, 190k reads as 19%
    // and every percentage rule stays dead while the session is nearly full.
    assert.ok(state.contextUsedPct > 0.9, `expected >0.9, got ${state.contextUsedPct}`);
  });

  test('a 1M-model session does not fall back to the default by accident', async () => {
    async function* entries() {
      yield normalizeEntry(assistantLine('claude-sonnet-5', 500000));
    }

    const state = await reduceTranscriptEntries(entries());

    assert.equal(state.contextWindowTokens, 1000000);
  });

  test('an explicit caller override still wins over the detected window', async () => {
    async function* entries() {
      yield normalizeEntry(assistantLine('claude-sonnet-4-5-20250929', 190000));
    }

    const state = await reduceTranscriptEntries(entries(), { contextWindowTokens: 500000 });

    assert.equal(state.contextWindowTokens, 500000);
  });
  test('an unknown model leaves the window unresolved rather than assuming one', async () => {
    async function* entries() {
      yield normalizeEntry(assistantLine('<synthetic>', 1000));
    }

    const state = await reduceTranscriptEntries(entries());

    assert.equal(state.contextWindowTokens, null);
  });
});
