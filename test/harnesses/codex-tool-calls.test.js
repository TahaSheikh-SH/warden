'use strict';

// response_item was previously unhandled — every Codex tool call was
// discarded. Verified against a real rollout, see
// reference/harness-capability-matrix.md.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEntry } = require('../../harnesses/codex/transcript');

describe('Codex toolCalls normalization', () => {
  test('function_call with a JSON path argument extracts targetPath', () => {
    const entry = {
      type: 'response_item',
      payload: { type: 'function_call', name: 'read_file', arguments: '{"file_path":"a.js"}' },
    };
    assert.deepEqual(normalizeEntry(entry).toolCalls, [
      { toolName: 'read_file', targetPath: 'a.js' },
    ]);
  });

  test('function_call with no path-shaped argument gets null targetPath', () => {
    const entry = {
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}' },
    };
    assert.deepEqual(normalizeEntry(entry).toolCalls, [
      { toolName: 'exec_command', targetPath: null },
    ]);
  });

  test('function_call with non-JSON arguments does not throw and yields null targetPath', () => {
    const entry = {
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: 'not json' },
    };
    assert.deepEqual(normalizeEntry(entry).toolCalls, [
      { toolName: 'exec_command', targetPath: null },
    ]);
  });

  test('custom_tool_call (apply_patch) extracts path from the patch header', () => {
    const entry = {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Update File: spec/lib/foo_spec.rb\n@@ -1 +1 @@\n',
      },
    };
    assert.deepEqual(normalizeEntry(entry).toolCalls, [
      { toolName: 'apply_patch', targetPath: 'spec/lib/foo_spec.rb' },
    ]);
  });

  test('other response_item payload types normalize to no tool calls', () => {
    const entry = { type: 'response_item', payload: { type: 'reasoning' } };
    assert.deepEqual(normalizeEntry(entry).toolCalls, []);
  });

  test('non-response_item entries still default toolCalls to empty', () => {
    assert.deepEqual(normalizeEntry({ type: 'turn_context', payload: {} }).toolCalls, []);
  });
});
