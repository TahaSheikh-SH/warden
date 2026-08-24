'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validateTranscriptEntry } = require('../resourceState');

describe('validateTranscriptEntry', () => {
  test('rejects non-object entries', () => {
    assert.equal(validateTranscriptEntry(null).valid, false);
    assert.equal(validateTranscriptEntry(5).valid, false);
    assert.equal(validateTranscriptEntry([1, 2]).valid, false);
  });

  test('accepts a minimal system entry', () => {
    const entry = { type: 'system', subtype: 'compact_boundary' };
    assert.equal(validateTranscriptEntry(entry).valid, true);
  });

  test('accepts a well-formed assistant entry with numeric usage', () => {
    const entry = {
      type: 'assistant',
      message: {
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
      },
    };
    assert.equal(validateTranscriptEntry(entry).valid, true);
  });

  test('accepts an entry missing optional fields entirely', () => {
    assert.equal(validateTranscriptEntry({}).valid, true);
  });

  test('rejects a non-string type', () => {
    assert.equal(validateTranscriptEntry({ type: 42 }).valid, false);
  });

  test('rejects a non-numeric usage token field', () => {
    const entry = { type: 'assistant', message: { usage: { input_tokens: '100' } } };
    assert.equal(validateTranscriptEntry(entry).valid, false);
  });

  test('rejects a non-object message', () => {
    assert.equal(validateTranscriptEntry({ message: 'oops' }).valid, false);
  });
});
