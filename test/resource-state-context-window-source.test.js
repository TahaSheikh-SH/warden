'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildResourceState } = require('../resourceState');

let counter = 0;

// Unique path per call so each case gets its own on-disk accumulator cache
// instead of inheriting a previous case's.
function writeSession(model, inputTokens) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'warden-window-')),
    `session-${(counter += 1)}.jsonl`,
  );
  const line = {
    type: 'assistant',
    timestamp: '2026-08-25T12:00:00.000Z',
    message: { model, usage: { input_tokens: inputTokens, output_tokens: 10 } },
  };
  fs.writeFileSync(file, JSON.stringify(line) + '\n');
  return file;
}

describe('buildResourceState context window resolution', () => {
  // The regression: buildResourceState used to pre-apply the default before
  // calling finalizeAccumulator, which made opts.contextWindowTokens always
  // truthy there — so the window detected from message.model was discarded and
  // the fix only ever worked in tests that called the core reducer directly.
  test('uses the window detected from message.model, not the default', async () => {
    const state = await buildResourceState(writeSession('claude-sonnet-4-5-20250929', 190000));

    assert.equal(state.contextWindowTokens, 200000);
    assert.equal(state.contextWindowSource, 'detected');
    assert.ok(state.contextUsedPct > 0.9, `expected >0.9, got ${state.contextUsedPct}`);
  });

  test('an explicit override still wins over the detected window', async () => {
    const state = await buildResourceState(writeSession('claude-sonnet-4-5-20250929', 190000), {
      contextWindowTokens: 500000,
    });

    assert.equal(state.contextWindowTokens, 500000);
    assert.equal(state.contextWindowSource, 'override');
  });

  test('an unlisted model reports an unknown window instead of assuming one', async () => {
    const state = await buildResourceState(writeSession('some-other-provider/model', 1000));

    assert.equal(state.contextWindowTokens, null);
    assert.equal(state.contextWindowSource, 'unknown');
  });
});
