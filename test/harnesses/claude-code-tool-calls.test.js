'use strict';

// Task 12: Claude Code tool-call normalization reads tool_use blocks from the
// transcript directly (not the PostToolUse hook) — see plan.md Task 12 step 1.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEntry } = require('../../harnesses/claude-code/transcript');

function assistantEntry(content) {
  return { type: 'assistant', timestamp: '2026-08-26T00:00:00.000Z', message: { content } };
}

describe('toolCalls normalization', () => {
  test('extracts toolName and targetPath from a tool_use block with file_path', () => {
    const entry = assistantEntry([
      { type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/foo.js' } },
    ]);
    const normalized = normalizeEntry(entry);
    assert.deepEqual(normalized.toolCalls, [{ toolName: 'Read', targetPath: '/repo/src/foo.js' }]);
  });

  test('targetPath is null for a tool with no single file argument', () => {
    const entry = assistantEntry([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]);
    const normalized = normalizeEntry(entry);
    assert.deepEqual(normalized.toolCalls, [{ toolName: 'Bash', targetPath: null }]);
  });

  test('multiple tool_use blocks in one assistant turn all get extracted', () => {
    const entry = assistantEntry([
      { type: 'tool_use', name: 'Read', input: { file_path: 'a.js' } },
      { type: 'text', text: 'looking' },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'b.js' } },
    ]);
    const normalized = normalizeEntry(entry);
    assert.deepEqual(normalized.toolCalls, [
      { toolName: 'Read', targetPath: 'a.js' },
      { toolName: 'Edit', targetPath: 'b.js' },
    ]);
  });

  test('non-assistant entries and entries with no content normalize to an empty array', () => {
    assert.deepEqual(
      normalizeEntry({ type: 'user', timestamp: 't', message: { content: 'hi' } }).toolCalls,
      [],
    );
    assert.deepEqual(normalizeEntry({ type: 'system', timestamp: 't' }).toolCalls, []);
  });
});
