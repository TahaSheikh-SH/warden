'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEntries, transcriptCompactedAfter, rollup } = require('../../scripts/rollup');

describe('loadEntries', () => {
  test('parses JSONL, skipping blank and malformed trailing lines', async () => {
    const p = path.join(os.tmpdir(), `warden-rollup-test-${process.hrtime.bigint()}.jsonl`);
    fs.writeFileSync(p, '{"action":"COMPACT"}\n\n{"action":"HANDOFF"}\n{not valid json');
    const entries = await loadEntries(p);
    assert.deepEqual(entries, [{ action: 'COMPACT' }, { action: 'HANDOFF' }]);
  });
});

describe('transcriptCompactedAfter', () => {
  test('returns false when sessionKey path does not exist', () => {
    assert.equal(
      transcriptCompactedAfter('/nonexistent/path.jsonl', '2026-01-01T00:00:00Z'),
      false,
    );
  });

  test('returns true when a compact_boundary entry appears after the timestamp', () => {
    const p = path.join(os.tmpdir(), `warden-rollup-transcript-${process.hrtime.bigint()}.jsonl`);
    fs.writeFileSync(
      p,
      [
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          timestamp: '2026-01-02T00:00:00Z',
        }),
      ].join('\n'),
    );
    assert.equal(transcriptCompactedAfter(p, '2026-01-01T00:00:00Z'), true);
  });

  test('returns false when the compact_boundary is before the timestamp', () => {
    const p = path.join(os.tmpdir(), `warden-rollup-transcript-${process.hrtime.bigint()}.jsonl`);
    fs.writeFileSync(
      p,
      [
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          timestamp: '2026-01-01T00:00:00Z',
        }),
      ].join('\n'),
    );
    assert.equal(transcriptCompactedAfter(p, '2026-01-02T00:00:00Z'), false);
  });
});

describe('rollup', () => {
  test('tallies count and average context pct per action', () => {
    const { byAction } = rollup([
      { action: 'CONTINUE', contextUsedPct: 0.2 },
      { action: 'CONTINUE', contextUsedPct: 0.4 },
      { action: 'COMPACT', contextUsedPct: 0.7 },
    ]);
    assert.equal(byAction.CONTINUE.count, 2);
    assert.ok(Math.abs(byAction.CONTINUE.sumContextPct - 0.6) < 1e-9);
    assert.equal(byAction.COMPACT.count, 1);
  });

  test('counts a HANDOFF/STOP block as overridden when a later entry exists for the same sessionKey', () => {
    const { blocks, blocksOverridden } = rollup([
      { action: 'HANDOFF', sessionKey: 's1', timestamp: '2026-01-01T00:00:00Z' },
      { action: 'CONTINUE', sessionKey: 's1', timestamp: '2026-01-01T00:05:00Z' },
    ]);
    assert.equal(blocks, 1);
    assert.equal(blocksOverridden, 1);
  });

  test('does not count a block as overridden when no later entry exists', () => {
    const { blocks, blocksOverridden } = rollup([
      { action: 'STOP', sessionKey: 's1', timestamp: '2026-01-01T00:00:00Z' },
    ]);
    assert.equal(blocks, 1);
    assert.equal(blocksOverridden, 0);
  });

  test('falls back to transcriptPath when sessionKey is absent', () => {
    const { blocksOverridden } = rollup([
      { action: 'HANDOFF', transcriptPath: 't1', timestamp: '2026-01-01T00:00:00Z' },
      { action: 'CONTINUE', transcriptPath: 't1', timestamp: '2026-01-01T00:05:00Z' },
    ]);
    assert.equal(blocksOverridden, 1);
  });
});
