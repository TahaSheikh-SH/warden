'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionEvaluator } = require('../../harnesses/opencode/plugin');
const { ACTIONS } = require('../../decide');

describe('opencode createSessionEvaluator', () => {
  test('accumulates events across ingest calls and decides CONTINUE when usage is low', async () => {
    const evaluator = createSessionEvaluator({ contextWindowTokens: 1000000 });
    const result = await evaluator.ingest({
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          sessionID: 'ses_1',
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    });
    assert.ok(result.decision);
    assert.equal(result.decision.action, ACTIONS.CONTINUE);
    assert.equal(result.state.sessionId, 'ses_1');
  });

  test('ignores events with no reducer-relevant signal', async () => {
    const evaluator = createSessionEvaluator();
    const result = await evaluator.ingest({ type: 'shell.env' });
    assert.equal(result, null);
  });

  test('resolves the real per-model context window via client.config.providers()', async () => {
    // 40k used against a hardcoded 200k default would be a very different
    // pct than against the real 1,000,000-token window from the stub
    // client — kept under decide.js's absolute-token floors (100k/200k)
    // too, so this test isolates the pct-of-window math it's checking.
    const client = {
      config: {
        providers: async () => ({
          data: {
            providers: [
              { id: 'anthropic', models: { 'claude-sonnet-5': { limit: { context: 1000000 } } } },
            ],
          },
        }),
      },
    };
    const evaluator = createSessionEvaluator({ client });
    const result = await evaluator.ingest({
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          sessionID: 'ses_4',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-5',
          tokens: { input: 40000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    });
    assert.equal(result.state.contextWindowTokens, 1000000);
    assert.equal(result.decision.action, ACTIONS.CONTINUE);
  });

  test('two sessions on one evaluator accumulate independently, not into a shared transcript', async () => {
    const evaluator = createSessionEvaluator({ contextWindowTokens: 1000000 });
    const eventFor = (sessionID, inputTokens) => ({
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          sessionID,
          tokens: { input: inputTokens, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    });

    await evaluator.ingest(eventFor('ses_a', 300000));
    const resultB = await evaluator.ingest(eventFor('ses_b', 100));

    assert.equal(resultB.sessionKey, 'ses_b');
    assert.ok(
      resultB.state.contextUsedTokens < 300000,
      "session B's token accounting must not include session A's usage",
    );
    assert.equal(resultB.decision.action, ACTIONS.CONTINUE);
  });

  test('streaming frames of one message collapse into a single assistant entry, last frame wins', async () => {
    // opencode re-fires message.updated once per stream frame, same id, each
    // with that message's cumulative usage. All the frames of one message are
    // a single real turn — they must count once, and the final frame's usage
    // must be the one kept.
    const evaluator = createSessionEvaluator({ contextWindowTokens: 1000000 });
    const frame = (messageId, inputTokens) => ({
      type: 'message.updated',
      properties: {
        info: {
          id: messageId,
          role: 'assistant',
          sessionID: 'ses_stream',
          tokens: { input: inputTokens, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    });

    let lastFrame;
    for (const tokens of [10000, 15000, 20000]) {
      lastFrame = await evaluator.ingest(frame('msg_a', tokens), 'fallback');
    }
    const nextMessage = await evaluator.ingest(frame('msg_b', 30000), 'fallback');

    assert.equal(lastFrame.state.messageCount, 1, 'one message must count as one turn');
    assert.equal(lastFrame.state.turnsSinceLastCompaction, 1);
    assert.equal(lastFrame.state.contextUsedTokens, 20000, 'final frame usage wins');
    assert.equal(nextMessage.state.messageCount, 2);
    assert.equal(nextMessage.state.contextUsedTokens, 30000);
    assert.equal(nextMessage.state.contextGrowthPerTurn, 10000);
  });
});
