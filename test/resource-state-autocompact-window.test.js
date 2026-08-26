'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildResourceState } = require('../resourceState');

let counter = 0;

function writeSession(model, inputTokens) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warden-autocompact-'));
  const file = path.join(dir, `session-${(counter += 1)}.jsonl`);
  const line = {
    type: 'assistant',
    timestamp: '2026-08-25T12:00:00.000Z',
    message: { model, usage: { input_tokens: inputTokens, output_tokens: 10 } },
  };
  fs.writeFileSync(file, JSON.stringify(line) + '\n');
  return { file, dir };
}

// Isolates a case from the developer machine's own ~/.claude/settings.json
// (which may set a real autoCompactWindow) by pointing homeDir at an empty
// temp dir unless the case writes its own settings into it.
function emptyHomeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'warden-autocompact-home-'));
}

function writeProjectSettings(dir, autoCompactWindow) {
  const settingsDir = path.join(dir, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({ autoCompactWindow }));
}

describe('buildResourceState autoCompactWindow precedence', () => {
  // The gating regression this task fixes: a 300,000 autoCompactWindow must
  // cap a 1,000,000-token model window, not be silently ignored in favor of
  // the model table.
  test('a project settings.json autoCompactWindow caps a larger detected model window', async () => {
    const { file, dir } = writeSession('claude-sonnet-5', 250000);
    writeProjectSettings(dir, 300000);

    const state = await buildResourceState(file, {
      settingsCwd: dir,
      homeDir: emptyHomeDir(),
      env: {},
    });

    assert.equal(state.contextWindowTokens, 300000);
    assert.equal(state.contextWindowSource, 'settings.autoCompactWindow');
  });

  test('CLAUDE_CODE_AUTO_COMPACT_WINDOW env overrides settings.json', async () => {
    const { file, dir } = writeSession('claude-sonnet-5', 250000);
    writeProjectSettings(dir, 300000);

    const state = await buildResourceState(file, {
      settingsCwd: dir,
      homeDir: emptyHomeDir(),
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' },
    });

    assert.equal(state.contextWindowTokens, 250000);
    assert.equal(state.contextWindowSource, 'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  });

  test('no settings file and no env leaves the plain model-detected window as "detected"', async () => {
    const { file, dir } = writeSession('claude-sonnet-5', 250000);

    const state = await buildResourceState(file, {
      settingsCwd: dir,
      homeDir: emptyHomeDir(),
      env: {},
    });

    assert.equal(state.contextWindowTokens, 1000000);
    assert.equal(state.contextWindowSource, 'detected');
  });

  test('an explicit --context-window override still wins over settings.json', async () => {
    const { file, dir } = writeSession('claude-sonnet-5', 250000);
    writeProjectSettings(dir, 300000);

    const state = await buildResourceState(file, {
      settingsCwd: dir,
      homeDir: emptyHomeDir(),
      env: {},
      contextWindowTokens: 500000,
    });

    assert.equal(state.contextWindowTokens, 500000);
    assert.equal(state.contextWindowSource, 'override');
  });
});
