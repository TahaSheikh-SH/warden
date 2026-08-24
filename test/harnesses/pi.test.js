'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { streamNormalizedEntries } = require('../../harnesses/pi/transcript');

// Fixture mirrors the real Pi session format, confirmed against
// @earendil-works/pi-coding-agent's session-manager.d.ts and real files
// under ~/.pi/agent/sessions/**/*.jsonl: header is {type:"session", id,
// timestamp, cwd} (no parentId); turn entries are tree-structured
// {type:"message", id, parentId, message:{role, usage}} where usage is
// {input, output, cacheRead, cacheWrite}; compaction is its own entry type.
function fixtureLines() {
  return [
    JSON.stringify({
      type: 'session',
      id: 'sess-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/repo',
    }),
    JSON.stringify({
      type: 'message',
      id: 'a1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    }),
    JSON.stringify({
      type: 'message',
      id: 'a2',
      parentId: 'a1',
      timestamp: '2026-01-01T00:01:00.000Z',
      message: {
        role: 'assistant',
        usage: { input: 500, output: 50, cacheRead: 100, cacheWrite: 20 },
      },
    }),
    // orphaned branch — should be excluded since it's not an ancestor of the leaf
    JSON.stringify({
      type: 'message',
      id: 'branch-x',
      parentId: 'a1',
      timestamp: '2026-01-01T00:01:30.000Z',
      message: {
        role: 'assistant',
        usage: { input: 999999, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    }),
    JSON.stringify({
      type: 'compaction',
      id: 'a3',
      parentId: 'a2',
      timestamp: '2026-01-01T00:02:00.000Z',
      summary: 'summary',
      firstKeptEntryId: 'a2',
      tokensBefore: 570,
    }),
    JSON.stringify({
      type: 'message',
      id: 'a4',
      parentId: 'a3',
      timestamp: '2026-01-01T00:03:00.000Z',
      message: {
        role: 'assistant',
        usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 },
      },
    }),
  ];
}

describe('pi streamNormalizedEntries', () => {
  test('walks the active branch from the leaf, excluding sibling branches', async () => {
    const tmpFile = path.join(os.tmpdir(), `warden-pi-fixture-${process.pid}.jsonl`);
    fs.writeFileSync(tmpFile, fixtureLines().join('\n') + '\n');
    try {
      const entries = [];
      for await (const entry of streamNormalizedEntries(tmpFile)) {
        entries.push(entry);
      }
      const assistantUsages = entries
        .filter((e) => e.type === 'assistant')
        .map((e) => e.usage.inputTokens);
      assert.deepEqual(assistantUsages, [500, 200]);
      assert.ok(entries.some((e) => e.isCompactionBoundary));
      assert.equal(entries[0].sessionId, 'sess-1');
      assert.equal(entries[0].cwd, '/repo');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
