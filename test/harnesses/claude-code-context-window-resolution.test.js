'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  parseAutoCompactWindow,
  resolveContextWindow,
} = require('../../harnesses/claude-code/contextWindow');

describe('parseAutoCompactWindow', () => {
  test('plain count', () => {
    assert.equal(parseAutoCompactWindow(300000), 300000);
    assert.equal(parseAutoCompactWindow('300000'), 300000);
  });

  test('k suffix', () => {
    assert.equal(parseAutoCompactWindow('300k'), 300000);
    assert.equal(parseAutoCompactWindow('300K'), 300000);
  });

  test('M suffix', () => {
    assert.equal(parseAutoCompactWindow('1M'), 1000000);
    assert.equal(parseAutoCompactWindow('0.5M'), 500000);
  });

  test('bare 100-1000 means thousands', () => {
    assert.equal(parseAutoCompactWindow(300), 300000);
    assert.equal(parseAutoCompactWindow(1000), 1000000);
  });

  test('clamps to documented 100K-1M range', () => {
    assert.equal(parseAutoCompactWindow('50000'), 100000);
    assert.equal(parseAutoCompactWindow('5M'), 1000000);
  });

  test('invalid input returns null', () => {
    assert.equal(parseAutoCompactWindow('not-a-number'), null);
    assert.equal(parseAutoCompactWindow(undefined), null);
    assert.equal(parseAutoCompactWindow(null), null);
  });
});

describe('resolveContextWindow', () => {
  test('explicit override wins over everything', () => {
    const result = resolveContextWindow({
      overrideTokens: 42000,
      model: 'claude-sonnet-5',
      settingsAutoCompactWindow: '300k',
      env: {},
    });
    assert.deepEqual(result, { tokens: 42000, source: 'override' });
  });

  test('settings autoCompactWindow takes precedence over model table, and min() applies', () => {
    const result = resolveContextWindow({
      model: 'claude-sonnet-5', // model table: 1,000,000
      settingsAutoCompactWindow: '300000',
      env: {},
    });
    assert.deepEqual(result, { tokens: 300000, source: 'settings.autoCompactWindow' });
  });

  test('env CLAUDE_CODE_AUTO_COMPACT_WINDOW overrides settings', () => {
    const result = resolveContextWindow({
      model: 'claude-sonnet-5',
      settingsAutoCompactWindow: '300000',
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' },
    });
    assert.deepEqual(result, { tokens: 250000, source: 'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW' });
  });

  test('CLAUDE_CODE_DISABLE_1M_CONTEXT=1 clamps a native-1M model to 200K', () => {
    const result = resolveContextWindow({
      model: 'claude-sonnet-5',
      env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' },
    });
    assert.deepEqual(result, { tokens: 200000, source: 'model-table+disable-1m' });
  });

  test('falls back to model table when nothing else resolves', () => {
    const result = resolveContextWindow({ model: 'claude-sonnet-5', env: {} });
    assert.deepEqual(result, { tokens: 1000000, source: 'model-table' });
  });

  test('unknown model and no other signal reports unknown, not a guess', () => {
    const result = resolveContextWindow({ model: '<synthetic>', env: {} });
    assert.deepEqual(result, { tokens: null, source: 'unknown' });
  });

  test('CLAUDE_CODE_MAX_CONTEXT_TOKENS caps the resolved window', () => {
    const result = resolveContextWindow({
      model: 'claude-sonnet-5',
      env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '150000' },
    });
    assert.deepEqual(result, { tokens: 150000, source: 'env.CLAUDE_CODE_MAX_CONTEXT_TOKENS' });
  });
});
