'use strict';

// pi.on('tool_call') was already wired for the STOP block — now it
// also records tool-call identity into the tracker's trailing window.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionTracker, WardenPiExtension } = require('../../harnesses/pi/extension');
const { TOOL_CALL_WINDOW } = require('../../core/resourceStateCore');

describe('createSessionTracker.recordToolCall', () => {
  test('shows up in the state returned by onTurnEnd', () => {
    const tracker = createSessionTracker();
    tracker.recordToolCall('read', 'a.js');
    const state = tracker.onTurnEnd({ contextWindow: 1000000, tokens: 100 });
    assert.deepEqual(state.recentToolCalls, [{ toolName: 'read', targetPath: 'a.js' }]);
  });

  test('window is bounded to TOOL_CALL_WINDOW', () => {
    const tracker = createSessionTracker();
    for (let i = 0; i < TOOL_CALL_WINDOW + 5; i += 1) {
      tracker.recordToolCall('read', `f${i}.js`);
    }
    const state = tracker.onTurnEnd({ contextWindow: 1000000, tokens: 100 });
    assert.equal(state.recentToolCalls.length, TOOL_CALL_WINDOW);
    assert.equal(state.recentToolCalls[0].targetPath, 'f5.js');
  });
});

describe('WardenPiExtension tool_call records identity', () => {
  test('read/edit/write tool calls with a path do not throw and are recorded', () => {
    let toolCallHandler;
    const pi = {
      on(event, handler) {
        if (event === 'tool_call') toolCallHandler = handler;
      },
    };
    WardenPiExtension(pi, {});
    assert.doesNotThrow(() =>
      toolCallHandler({
        type: 'tool_call',
        toolCallId: '1',
        toolName: 'edit',
        input: { path: 'b.js' },
      }),
    );
  });
});
