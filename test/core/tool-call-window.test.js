'use strict';

// Task 12: repeated file view/edit detection needs a trailing window of tool
// calls in the accumulator, same shape as recentTurnTokens.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { reduceTranscriptEntries, TOOL_CALL_WINDOW } = require('../../core/resourceStateCore');

function assistantTurn(usage, toolCalls) {
  return { type: 'assistant', timestamp: '2026-08-25T00:00:00.000Z', usage, toolCalls };
}

function compactionBoundary() {
  return { type: 'system', timestamp: '2026-08-25T00:00:01.000Z', isCompactionBoundary: true };
}

describe('recentToolCalls window', () => {
  test('folds toolCalls from assistant entries in order', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn(null, [{ toolName: 'Read', targetPath: 'a.js' }]),
      assistantTurn(null, [{ toolName: 'Edit', targetPath: 'b.js' }]),
    ]);

    assert.deepEqual(state.recentToolCalls, [
      { toolName: 'Read', targetPath: 'a.js' },
      { toolName: 'Edit', targetPath: 'b.js' },
    ]);
  });

  test('entries with no toolCalls do not push anything', async () => {
    const state = await reduceTranscriptEntries([assistantTurn(null, undefined)]);
    assert.deepEqual(state.recentToolCalls, []);
  });

  test('window is bounded to TOOL_CALL_WINDOW, oldest dropped first', async () => {
    const entries = [];
    for (let i = 0; i < TOOL_CALL_WINDOW + 3; i += 1) {
      entries.push(assistantTurn(null, [{ toolName: 'Read', targetPath: `f${i}.js` }]));
    }
    const state = await reduceTranscriptEntries(entries);

    assert.equal(state.recentToolCalls.length, TOOL_CALL_WINDOW);
    assert.equal(state.recentToolCalls[0].targetPath, 'f3.js');
    assert.equal(
      state.recentToolCalls[state.recentToolCalls.length - 1].targetPath,
      `f${TOOL_CALL_WINDOW + 2}.js`,
    );
  });

  test('a compaction boundary does not clear the tool-call window (unlike recentTurnTokens)', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, [
        { toolName: 'Read', targetPath: 'a.js' },
      ]),
      compactionBoundary(),
    ]);

    assert.deepEqual(state.recentToolCalls, [{ toolName: 'Read', targetPath: 'a.js' }]);
  });
});
