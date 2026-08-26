'use strict';

// Each adapter surfaces its own harness version field, normalized
// into the shared NormalizedTranscriptEntry.harnessVersion so core can
// first-wins accumulate it generically (see test/core/format-drift.test.js).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEntry: normalizeClaudeEntry } = require('../../harnesses/claude-code/transcript');
const { normalizeEntry: normalizeCodexEntry } = require('../../harnesses/codex/transcript');

describe('claude-code harnessVersion', () => {
  test('a system entry with a version field reports it', () => {
    const normalized = normalizeClaudeEntry({ type: 'system', version: '2.1.239' });
    assert.equal(normalized.harnessVersion, '2.1.239');
  });

  test('an entry with no version field reports null', () => {
    const normalized = normalizeClaudeEntry({ type: 'assistant', message: {} });
    assert.equal(normalized.harnessVersion, null);
  });
});

describe('codex harnessVersion', () => {
  test('session_meta.cli_version reports it', () => {
    const normalized = normalizeCodexEntry({
      type: 'session_meta',
      payload: { id: 's1', cli_version: '0.117.0-alpha.24' },
    });
    assert.equal(normalized.harnessVersion, '0.117.0-alpha.24');
  });

  test('a session_meta with no cli_version reports null', () => {
    const normalized = normalizeCodexEntry({ type: 'session_meta', payload: { id: 's1' } });
    assert.equal(normalized.harnessVersion, null);
  });
});
