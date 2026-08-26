'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { normalizeEntry } = require('../../harnesses/claude-code/transcript');

function compactBoundaryEntry(compactMetadata) {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    timestamp: '2026-08-26T00:00:00.000Z',
    compactMetadata,
  };
}

describe('normalizeEntry compaction metadata', () => {
  test('extracts trigger/preTokens/postTokens/durationMs from compactMetadata', () => {
    const entry = normalizeEntry(
      compactBoundaryEntry({
        trigger: 'auto',
        preTokens: 239355,
        postTokens: 33482,
        durationMs: 116468,
      }),
    );
    assert.deepEqual(entry.compaction, {
      trigger: 'auto',
      preTokens: 239355,
      postTokens: 33482,
      durationMs: 116468,
    });
  });

  test('compaction is null when the entry is not a compact_boundary', () => {
    const entry = normalizeEntry({ type: 'assistant', timestamp: '2026-08-26T00:00:00.000Z' });
    assert.equal(entry.compaction, null);
  });

  test('compaction is null when a compact_boundary carries no compactMetadata', () => {
    const entry = normalizeEntry({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: '2026-08-26T00:00:00.000Z',
    });
    assert.equal(entry.compaction, null);
  });
});
