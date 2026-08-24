'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { timestampAtLine } = require('../../scripts/backfill-log');

describe('timestampAtLine', () => {
  test('returns the timestamp of the nearest timestamped line at or before n', () => {
    const p = path.join(os.tmpdir(), `warden-backfill-test-${process.hrtime.bigint()}.jsonl`);
    fs.writeFileSync(
      p,
      [
        JSON.stringify({ timestamp: '2026-01-01T00:00:00Z' }),
        JSON.stringify({ timestamp: '2026-01-01T00:01:00Z' }),
        JSON.stringify({ timestamp: '2026-01-01T00:02:00Z' }),
      ].join('\n'),
    );
    assert.equal(timestampAtLine(p, 2), '2026-01-01T00:01:00Z');
  });

  test('falls back to epoch when no line up to n has a timestamp', () => {
    const p = path.join(os.tmpdir(), `warden-backfill-test-${process.hrtime.bigint()}.jsonl`);
    fs.writeFileSync(p, [JSON.stringify({ type: 'system' })].join('\n'));
    assert.equal(timestampAtLine(p, 1), new Date(0).toISOString());
  });

  test('tolerates malformed JSON lines while scanning backward', () => {
    const p = path.join(os.tmpdir(), `warden-backfill-test-${process.hrtime.bigint()}.jsonl`);
    fs.writeFileSync(
      p,
      [JSON.stringify({ timestamp: '2026-01-01T00:00:00Z' }), '{not valid json'].join('\n'),
    );
    assert.equal(timestampAtLine(p, 2), '2026-01-01T00:00:00Z');
  });
});
