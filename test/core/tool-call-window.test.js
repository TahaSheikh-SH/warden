'use strict';

// Repeated file view/edit detection needs a trailing window of tool calls in
// the accumulator, bounded by distinct turns rather than raw call count.

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
      { toolName: 'Read', targetPath: 'a.js', turnIndex: 1 },
      { toolName: 'Edit', targetPath: 'b.js', turnIndex: 2 },
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

    assert.deepEqual(state.recentToolCalls, [
      { toolName: 'Read', targetPath: 'a.js', turnIndex: 1 },
    ]);
  });
});

// turnIndex lets a consumer tell "one turn's parallel fan-out" apart from
// "the same call repeating across separate turns", which a flat array with
// no turn identity cannot distinguish.
describe('recentToolCalls turnIndex', () => {
  test('multiple tool calls on the same entry share one turnIndex (a batch, not a cycle across turns)', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn(null, [
        { toolName: 'Read', targetPath: 'a.js' },
        { toolName: 'Read', targetPath: 'b.js' },
        { toolName: 'Read', targetPath: 'a.js' },
      ]),
    ]);

    const turnIndexes = new Set(state.recentToolCalls.map((call) => call.turnIndex));
    assert.equal(turnIndexes.size, 1, 'one assistant entry is one turn, regardless of fan-out');
  });

  test('tool calls on separate assistant entries get distinct, increasing turnIndex values', async () => {
    const state = await reduceTranscriptEntries([
      assistantTurn(null, [{ toolName: 'Read', targetPath: 'a.js' }]),
      assistantTurn(null, [{ toolName: 'Read', targetPath: 'a.js' }]),
      assistantTurn(null, [{ toolName: 'Read', targetPath: 'a.js' }]),
    ]);

    const turnIndexes = state.recentToolCalls.map((call) => call.turnIndex);
    assert.deepEqual(turnIndexes, [1, 2, 3]);
  });

  // Mirrors OpenCode's tool.execute.before / Codex's response_item pattern:
  // a tool call arrives on its own entry, chronologically before the entry
  // that reports that turn's usage — see harnesses/opencode/plugin.js
  // recordToolCall. Both calls belong to the turn currently executing, so
  // both must land on the same turnIndex even though neither is attached to
  // the assistant entry itself.
  test('tool calls on their own pre-usage entries within one turn share a turnIndex', async () => {
    const toolCallEntry = (targetPath) => ({
      type: null,
      timestamp: null,
      usage: null,
      isCompactionBoundary: false,
      toolCalls: [{ toolName: 'read', targetPath }],
    });

    const state = await reduceTranscriptEntries([
      toolCallEntry('a.js'),
      toolCallEntry('b.js'),
      assistantTurn({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, undefined),
    ]);

    assert.deepEqual(state.recentToolCalls, [
      { toolName: 'read', targetPath: 'a.js', turnIndex: 0 },
      { toolName: 'read', targetPath: 'b.js', turnIndex: 0 },
    ]);
  });
});

// TOOL_CALL_WINDOW was call-bounded, so one tool-heavy turn could flush the
// entire cross-turn history in a single fold — a session with a quiet turn
// (1 call) followed by a busy turn (more calls than TOOL_CALL_WINDOW) went
// blind to the quiet turn immediately, even though only two turns have
// happened. Bounding by distinct turnIndex values instead means one busy
// turn can't erase turns before it.
describe('recentToolCalls window bounded by turns, not raw call count', () => {
  test('a tool-heavy turn does not evict a call from the turn before it', async () => {
    const busyTurnCalls = [];
    for (let i = 0; i < TOOL_CALL_WINDOW + 5; i += 1) {
      busyTurnCalls.push({ toolName: 'Read', targetPath: `busy${i}.js` });
    }

    const state = await reduceTranscriptEntries([
      assistantTurn(null, [{ toolName: 'Read', targetPath: 'quiet.js' }]),
      assistantTurn(null, busyTurnCalls),
    ]);

    assert.ok(
      state.recentToolCalls.some((call) => call.targetPath === 'quiet.js'),
      'only two turns have happened — the first one must still be visible',
    );
    assert.equal(state.recentToolCalls.filter((call) => call.targetPath === 'quiet.js').length, 1);
  });

  test('eviction still happens once more than TOOL_CALL_WINDOW distinct turns have occurred', async () => {
    const entries = [];
    for (let i = 0; i < TOOL_CALL_WINDOW + 3; i += 1) {
      entries.push(assistantTurn(null, [{ toolName: 'Read', targetPath: `f${i}.js` }]));
    }
    const state = await reduceTranscriptEntries(entries);

    const distinctTurns = new Set(state.recentToolCalls.map((call) => call.turnIndex));
    assert.equal(distinctTurns.size, TOOL_CALL_WINDOW);
    assert.ok(!state.recentToolCalls.some((call) => call.targetPath === 'f0.js'));
  });
});
