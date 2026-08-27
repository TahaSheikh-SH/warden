'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEvent } = require('../../harnesses/opencode/transcript');

// Field names confirmed against opencode's generated SDK types
// (packages/sdk/js/src/gen/types.gen.ts): AssistantMessage.tokens =
// {input, output, reasoning, cache: {read, write}}; session compaction
// surfaces as an EventSessionCompacted event, not a transcript line (there
// is no on-disk transcript format documented for this harness — it's an
// in-process plugin, not a spawned-hook-script model).
describe('opencode normalizeEvent', () => {
  test('maps a message.updated assistant event to a usage entry', () => {
    const event = {
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          sessionID: 'ses_1',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-5',
          time: { created: 1700000000000 },
          tokens: { input: 300, output: 40, reasoning: 0, cache: { read: 50, write: 10 } },
        },
      },
    };
    const normalized = normalizeEvent(event);
    assert.equal(normalized.type, 'assistant');
    assert.deepEqual(normalized.usage, {
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
    });
    assert.equal(normalized.sessionId, 'ses_1');
    assert.equal(normalized.providerID, 'anthropic');
    assert.equal(normalized.modelID, 'claude-sonnet-5');
    assert.equal(normalized.messageId, null); // no id in this fixture
  });

  test('ignores a message.updated user event (no usage on user turns)', () => {
    const event = {
      type: 'message.updated',
      properties: { info: { role: 'user', sessionID: 'ses_1' } },
    };
    const normalized = normalizeEvent(event);
    assert.equal(normalized.usage, null);
  });

  test('maps a session.compacted event to a compaction boundary', () => {
    const event = { type: 'session.compacted', properties: { sessionID: 'ses_1' } };
    const normalized = normalizeEvent(event);
    assert.equal(normalized.isCompactionBoundary, true);
  });

  test('returns null for unrelated event types', () => {
    assert.equal(normalizeEvent({ type: 'shell.env' }), null);
  });
});
