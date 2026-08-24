'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionEvaluator } = require('../../harnesses/opencode/plugin');
const { ACTIONS } = require('../../decide');

describe('opencode createSessionEvaluator', () => {
  test('accumulates events across ingest calls and decides CONTINUE when usage is low', async () => {
    const evaluator = createSessionEvaluator();
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
});
