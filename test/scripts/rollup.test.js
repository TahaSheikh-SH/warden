'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadEntries,
  transcriptCompactedAfter,
  compactionsAfter,
  rollup,
} = require('../../scripts/rollup');

describe('loadEntries', () => {
  test('parses JSONL, skipping blank and malformed trailing lines', async () => {
    const filePath = path.join(os.tmpdir(), `warden-rollup-test-${process.hrtime.bigint()}.jsonl`);
    fs.writeFileSync(filePath, '{"action":"COMPACT"}\n\n{"action":"HANDOFF"}\n{not valid json');
    const entries = await loadEntries(filePath);
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
    const filePath = path.join(
      os.tmpdir(),
      `warden-rollup-transcript-${process.hrtime.bigint()}.jsonl`,
    );
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          timestamp: '2026-01-02T00:00:00Z',
        }),
      ].join('\n'),
    );
    assert.equal(transcriptCompactedAfter(filePath, '2026-01-01T00:00:00Z'), true);
  });

  test('returns false when the compact_boundary is before the timestamp', () => {
    const filePath = path.join(
      os.tmpdir(),
      `warden-rollup-transcript-${process.hrtime.bigint()}.jsonl`,
    );
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          timestamp: '2026-01-01T00:00:00Z',
        }),
      ].join('\n'),
    );
    assert.equal(transcriptCompactedAfter(filePath, '2026-01-02T00:00:00Z'), false);
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

describe('rollup: block override vs. compaction reset', () => {
  test('does not count a block as overridden when continuation only follows a compaction reset', () => {
    const filePath = path.join(
      os.tmpdir(),
      `warden-rollup-block-compact-${process.hrtime.bigint()}.jsonl`,
    );
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-01-01T00:03:00Z',
        compactMetadata: { trigger: 'auto' },
      }) + '\n',
    );
    const { blocksOverridden } = rollup([
      { action: 'HANDOFF', sessionKey: filePath, timestamp: '2026-01-01T00:00:00Z' },
      { action: 'CONTINUE', sessionKey: filePath, timestamp: '2026-01-01T00:05:00Z' },
    ]);
    assert.equal(blocksOverridden, 0);
  });

  test('still counts a block as overridden when continuation precedes any compaction', () => {
    const filePath = path.join(
      os.tmpdir(),
      `warden-rollup-block-precedes-${process.hrtime.bigint()}.jsonl`,
    );
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-01-01T00:10:00Z',
        compactMetadata: { trigger: 'auto' },
      }) + '\n',
    );
    const { blocksOverridden } = rollup([
      { action: 'HANDOFF', sessionKey: filePath, timestamp: '2026-01-01T00:00:00Z' },
      { action: 'CONTINUE', sessionKey: filePath, timestamp: '2026-01-01T00:05:00Z' },
    ]);
    assert.equal(blocksOverridden, 1);
  });
});

describe('rollup: nudge follow-through by trigger', () => {
  test('counts nudge follow-through as manual only, tracking auto-triggered compactions separately', () => {
    const filePath = path.join(
      os.tmpdir(),
      `warden-rollup-nudge-trigger-${process.hrtime.bigint()}.jsonl`,
    );
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-01-01T00:05:00Z',
        compactMetadata: { trigger: 'auto' },
      }) + '\n',
    );
    const { nudgesFollowedManual, nudgesFollowedAuto } = rollup([
      { action: 'COMPACT', sessionKey: filePath, timestamp: '2026-01-01T00:00:00Z' },
    ]);
    assert.equal(nudgesFollowedManual, 0);
    assert.equal(nudgesFollowedAuto, 1);
  });

  test('counts nudge follow-through as manual when the harness reports a manual trigger', () => {
    const filePath = path.join(
      os.tmpdir(),
      `warden-rollup-nudge-manual-${process.hrtime.bigint()}.jsonl`,
    );
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-01-01T00:05:00Z',
        compactMetadata: { trigger: 'manual' },
      }) + '\n',
    );
    const { nudgesFollowedManual, nudgesFollowedAuto } = rollup([
      { action: 'COMPACT', sessionKey: filePath, timestamp: '2026-01-01T00:00:00Z' },
    ]);
    assert.equal(nudgesFollowedManual, 1);
    assert.equal(nudgesFollowedAuto, 0);
  });

  test('buckets follow-through as unknown-trigger when the harness never sets compactMetadata', () => {
    const filePath = path.join(
      os.tmpdir(),
      `warden-rollup-nudge-unknown-${process.hrtime.bigint()}.jsonl`,
    );
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-01-01T00:05:00Z',
      }) + '\n',
    );
    const { nudgesFollowedManual, nudgesFollowedAuto, nudgesFollowedUnknownTrigger } = rollup([
      {
        action: 'COMPACT',
        harness: 'codex',
        sessionKey: filePath,
        timestamp: '2026-01-01T00:00:00Z',
      },
    ]);
    assert.equal(nudgesFollowedManual, 0);
    assert.equal(nudgesFollowedAuto, 0);
    assert.equal(nudgesFollowedUnknownTrigger, 1);
  });

  test('tallies nudgesByHarness, defaulting undefined harness to claude-code', () => {
    const { nudgesByHarness } = rollup([
      { action: 'COMPACT', timestamp: '2026-01-01T00:00:00Z' },
      { action: 'CHECKPOINT', harness: 'codex', timestamp: '2026-01-01T00:00:00Z' },
    ]);
    assert.equal(nudgesByHarness['claude-code'], 1);
    assert.equal(nudgesByHarness.codex, 1);
  });
});

describe('compactionsAfter', () => {
  test('returns the trigger for each compact_boundary after the timestamp', () => {
    const filePath = path.join(
      os.tmpdir(),
      `warden-rollup-compactions-${process.hrtime.bigint()}.jsonl`,
    );
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-01-02T00:00:00Z',
        compactMetadata: { trigger: 'manual' },
      }) + '\n',
    );
    assert.deepEqual(compactionsAfter(filePath, '2026-01-01T00:00:00Z'), [
      { timestamp: '2026-01-02T00:00:00Z', trigger: 'manual' },
    ]);
  });

  test('trigger is null when compactMetadata is absent', () => {
    const filePath = path.join(
      os.tmpdir(),
      `warden-rollup-compactions-null-${process.hrtime.bigint()}.jsonl`,
    );
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-01-02T00:00:00Z',
      }) + '\n',
    );
    assert.deepEqual(compactionsAfter(filePath, '2026-01-01T00:00:00Z'), [
      { timestamp: '2026-01-02T00:00:00Z', trigger: null },
    ]);
  });
});
