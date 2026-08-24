'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEntry, streamNormalizedEntries } = require('../../harnesses/codex/transcript');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Fixture lines mirror the real on-disk shape of a Codex rollout .jsonl
// (~/.codex/sessions/**/*.jsonl), confirmed against a live session on this
// machine: {timestamp, type, payload}, where usage lives at top-level
// type "event_msg" / payload.type "token_count" / payload.info, and a
// compaction boundary is a top-level type "compacted" entry (not nested
// under event_msg).
const SESSION_META_LINE = JSON.stringify({
  timestamp: '2026-03-30T02:03:58.026Z',
  type: 'session_meta',
  payload: {
    id: '019d3c7b-41d1-7b01-b353-a8c5282edd35',
    cwd: '/Users/dev/repo',
    git: { branch: 'main' },
  },
});

const TOKEN_COUNT_LINE = JSON.stringify({
  timestamp: '2026-03-30T02:04:10.870Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: 17882,
        cached_input_tokens: 7680,
        output_tokens: 648,
        total_tokens: 18530,
      },
      last_token_usage: {
        input_tokens: 17882,
        cached_input_tokens: 7680,
        output_tokens: 648,
        total_tokens: 18530,
      },
      model_context_window: 258400,
    },
  },
});

const EMPTY_TOKEN_COUNT_LINE = JSON.stringify({
  timestamp: '2026-03-30T02:03:58.215Z',
  type: 'event_msg',
  payload: { type: 'token_count', info: null },
});

const COMPACTED_LINE = JSON.stringify({
  timestamp: '2026-03-30T02:05:00.000Z',
  type: 'compacted',
  payload: { message: '', replacement_history: [] },
});

describe('codex normalizeEntry', () => {
  test('maps session_meta to sessionId/cwd/gitBranch', () => {
    const normalized = normalizeEntry(JSON.parse(SESSION_META_LINE));
    assert.equal(normalized.sessionId, '019d3c7b-41d1-7b01-b353-a8c5282edd35');
    assert.equal(normalized.cwd, '/Users/dev/repo');
    assert.equal(normalized.gitBranch, 'main');
    assert.equal(normalized.usage, null);
  });

  test('maps a token_count event_msg with info to an assistant usage entry', () => {
    const normalized = normalizeEntry(JSON.parse(TOKEN_COUNT_LINE));
    assert.equal(normalized.type, 'assistant');
    assert.deepEqual(normalized.usage, {
      inputTokens: 17882,
      outputTokens: 648,
      cacheReadTokens: 7680,
      cacheCreationTokens: 0,
    });
    assert.equal(normalized.detectedContextWindowTokens, 258400);
  });

  test('ignores a token_count event_msg with null info', () => {
    const normalized = normalizeEntry(JSON.parse(EMPTY_TOKEN_COUNT_LINE));
    assert.equal(normalized.usage, null);
  });

  test('maps a top-level "compacted" entry to a compaction boundary', () => {
    const normalized = normalizeEntry(JSON.parse(COMPACTED_LINE));
    assert.equal(normalized.isCompactionBoundary, true);
  });
});

describe('codex streamNormalizedEntries', () => {
  test('streams a fixture rollout file into normalized entries', async () => {
    const tmpFile = path.join(os.tmpdir(), `warden-codex-fixture-${process.pid}.jsonl`);
    fs.writeFileSync(
      tmpFile,
      [SESSION_META_LINE, TOKEN_COUNT_LINE, COMPACTED_LINE].join('\n') + '\n',
    );
    try {
      const entries = [];
      for await (const entry of streamNormalizedEntries(tmpFile)) {
        entries.push(entry);
      }
      assert.equal(entries.length, 3);
      assert.equal(entries[1].usage.inputTokens, 17882);
      assert.equal(entries[2].isCompactionBoundary, true);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
