'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  withWardenHookRegistered,
  withWardenArrayEntryRegistered,
  withWardenStatusLineRegistered,
} = require('../../scripts/setup');

describe('withWardenHookRegistered', () => {
  test('adds a hook entry to an empty settings object', () => {
    const { settings, changed } = withWardenHookRegistered({}, '/path/to/actuator.js');
    assert.equal(changed, true);
    assert.deepEqual(settings.hooks.UserPromptSubmit, [
      { hooks: [{ type: 'command', command: 'node /path/to/actuator.js' }] },
    ]);
  });

  test('is idempotent when the adapter is already registered', () => {
    const first = withWardenHookRegistered({}, '/path/to/actuator.js').settings;
    const { settings, changed } = withWardenHookRegistered(first, '/path/to/actuator.js');
    assert.equal(changed, false);
    assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  });

  test('preserves existing unrelated hook entries', () => {
    const existing = {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other' }] }] },
    };
    const { settings, changed } = withWardenHookRegistered(existing, '/path/to/actuator.js');
    assert.equal(changed, true);
    assert.equal(settings.hooks.UserPromptSubmit.length, 2);
  });
});

describe('withWardenArrayEntryRegistered', () => {
  test('adds an entry to a missing array', () => {
    const { settings, changed } = withWardenArrayEntryRegistered(
      {},
      'packages',
      '/warden/extension.js',
      '/home/.pi',
    );
    assert.equal(changed, true);
    assert.deepEqual(settings.packages, ['/warden/extension.js']);
  });

  test('is idempotent for an absolute duplicate entry', () => {
    const existing = { packages: ['/warden/extension.js'] };
    const { settings, changed } = withWardenArrayEntryRegistered(
      existing,
      'packages',
      '/warden/extension.js',
      '/home/.pi',
    );
    assert.equal(changed, false);
    assert.deepEqual(settings.packages, ['/warden/extension.js']);
  });

  test('dedupes a relative entry against the resolved absolute path', () => {
    const existing = { packages: ['../../warden/extension.js'] };
    const { settings, changed } = withWardenArrayEntryRegistered(
      existing,
      'packages',
      '/home/warden/extension.js',
      '/home/.pi/agent',
    );
    assert.equal(changed, false);
    assert.deepEqual(settings.packages, ['../../warden/extension.js']);
  });

  test('preserves other keys on the settings object', () => {
    const existing = { theme: 'dark', plugin: ['other.js'] };
    const { settings } = withWardenArrayEntryRegistered(
      existing,
      'plugin',
      '/warden/plugin.js',
      '/home',
    );
    assert.equal(settings.theme, 'dark');
    assert.deepEqual(settings.plugin, ['other.js', '/warden/plugin.js']);
  });
});

describe('withWardenStatusLineRegistered', () => {
  test('sets statusLine when none is configured', () => {
    const { settings, changed, warning } = withWardenStatusLineRegistered(
      {},
      '/path/to/statusline.js',
    );
    assert.equal(changed, true);
    assert.equal(warning, null);
    assert.deepEqual(settings.statusLine, {
      type: 'command',
      command: 'node /path/to/statusline.js',
    });
  });

  test('is idempotent when warden is already the configured statusLine', () => {
    const first = withWardenStatusLineRegistered({}, '/path/to/statusline.js').settings;
    const { settings, changed, warning } = withWardenStatusLineRegistered(
      first,
      '/path/to/statusline.js',
    );
    assert.equal(changed, false);
    assert.equal(warning, null);
    assert.deepEqual(settings.statusLine, first.statusLine);
  });

  test('does not clobber an existing unrelated statusLine, and returns a warning instead', () => {
    const existing = { statusLine: { type: 'command', command: 'bash ~/.claude/my-status.sh' } };
    const { settings, changed, warning } = withWardenStatusLineRegistered(
      existing,
      '/path/to/statusline.js',
    );
    assert.equal(changed, false);
    assert.deepEqual(settings.statusLine, existing.statusLine);
    assert.match(warning, /statusline\.js/);
  });

  test('preserves other keys on the settings object', () => {
    const existing = { theme: 'dark' };
    const { settings } = withWardenStatusLineRegistered(existing, '/path/to/statusline.js');
    assert.equal(settings.theme, 'dark');
  });
});
