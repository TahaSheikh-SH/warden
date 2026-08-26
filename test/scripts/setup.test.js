'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  withWardenHookRegistered,
  withWardenHookUnregistered,
  withWardenArrayEntryRegistered,
  withWardenArrayEntryUnregistered,
  withWardenStatusLineRegistered,
  withWardenStatusLineUnregistered,
  wrapperScriptContents,
  parsePreviousCommandFromWrapper,
  statusLineDriftMessage,
  registerHook,
  unregisterHook,
  registerArrayEntry,
  unregisterArrayEntry,
} = require('../../scripts/setup');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'warden-setup-test-'));
}

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

describe('withWardenHookUnregistered', () => {
  test('removes the entry it registered, restoring settings byte-identical to pre-install', () => {
    const before = { theme: 'dark' };
    const installed = withWardenHookRegistered(before, '/path/to/actuator.js').settings;
    const { settings, changed } = withWardenHookUnregistered(installed, '/path/to/actuator.js');
    assert.equal(changed, true);
    assert.deepEqual(settings, before);
  });

  test('is idempotent — uninstalling twice does nothing the second time', () => {
    const installed = withWardenHookRegistered({}, '/path/to/actuator.js').settings;
    const once = withWardenHookUnregistered(installed, '/path/to/actuator.js').settings;
    const { settings, changed } = withWardenHookUnregistered(once, '/path/to/actuator.js');
    assert.equal(changed, false);
    assert.deepEqual(settings, once);
  });

  test('preserves other UserPromptSubmit hook entries instead of dropping the whole array', () => {
    const existing = {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other' }] }] },
    };
    const installed = withWardenHookRegistered(existing, '/path/to/actuator.js').settings;
    const { settings } = withWardenHookUnregistered(installed, '/path/to/actuator.js');
    assert.deepEqual(settings.hooks.UserPromptSubmit, [
      { hooks: [{ type: 'command', command: 'other' }] },
    ]);
  });

  test('does nothing when warden was never registered', () => {
    const existing = { theme: 'dark' };
    const { settings, changed } = withWardenHookUnregistered(existing, '/path/to/actuator.js');
    assert.equal(changed, false);
    assert.deepEqual(settings, existing);
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

describe('withWardenArrayEntryUnregistered', () => {
  test('removes the entry it registered, restoring settings byte-identical to pre-install', () => {
    const before = { theme: 'dark' };
    const installed = withWardenArrayEntryRegistered(
      before,
      'packages',
      '/warden/extension.js',
      '/home/.pi',
    ).settings;
    const { settings, changed } = withWardenArrayEntryUnregistered(
      installed,
      'packages',
      '/warden/extension.js',
      '/home/.pi',
    );
    assert.equal(changed, true);
    assert.deepEqual(settings, before);
  });

  test('is idempotent — uninstalling twice does nothing the second time', () => {
    const installed = withWardenArrayEntryRegistered(
      {},
      'packages',
      '/warden/extension.js',
      '/home/.pi',
    ).settings;
    const once = withWardenArrayEntryUnregistered(
      installed,
      'packages',
      '/warden/extension.js',
      '/home/.pi',
    ).settings;
    const { settings, changed } = withWardenArrayEntryUnregistered(
      once,
      'packages',
      '/warden/extension.js',
      '/home/.pi',
    );
    assert.equal(changed, false);
    assert.deepEqual(settings, once);
  });

  test('preserves other entries instead of dropping the whole array', () => {
    const existing = { plugin: ['other.js'] };
    const installed = withWardenArrayEntryRegistered(
      existing,
      'plugin',
      '/warden/plugin.js',
      '/home',
    ).settings;
    const { settings } = withWardenArrayEntryUnregistered(
      installed,
      'plugin',
      '/warden/plugin.js',
      '/home',
    );
    assert.deepEqual(settings.plugin, ['other.js']);
  });

  test('dedupes a relative entry against the resolved absolute path, same as the registered check', () => {
    const existing = { packages: ['../../warden/extension.js'] };
    const { settings, changed } = withWardenArrayEntryUnregistered(
      existing,
      'packages',
      '/home/warden/extension.js',
      '/home/.pi/agent',
    );
    assert.equal(changed, true);
    assert.equal('packages' in settings, false);
  });
});

describe('withWardenStatusLineRegistered', () => {
  const STATUSLINE = '/path/to/statusline.js';
  const WRAPPER = `${os.homedir()}/.warden/claude-statusline.sh`;

  test('sets statusLine directly when none is configured', () => {
    const { settings, changed, wrapper } = withWardenStatusLineRegistered({}, STATUSLINE, WRAPPER);
    assert.equal(changed, true);
    assert.equal(wrapper, null);
    assert.deepEqual(settings.statusLine, {
      type: 'command',
      command: `node '${STATUSLINE}'`,
    });
  });

  test('sets statusLine directly when a statusLine object carries no command', () => {
    const { changed, wrapper } = withWardenStatusLineRegistered(
      { statusLine: { type: 'command' } },
      STATUSLINE,
      WRAPPER,
    );
    assert.equal(changed, true);
    assert.equal(wrapper, null);
  });

  test('quotes paths so a space in the checkout path still runs', () => {
    const { settings } = withWardenStatusLineRegistered({}, '/my repo/statusline.js', WRAPPER);
    assert.equal(settings.statusLine.command, `node '/my repo/statusline.js'`);
  });

  test('is idempotent when warden is already the configured statusLine', () => {
    const first = withWardenStatusLineRegistered({}, STATUSLINE, WRAPPER).settings;
    const { changed, wrapper } = withWardenStatusLineRegistered(first, STATUSLINE, WRAPPER);
    assert.equal(changed, false);
    assert.equal(wrapper, null);
  });

  test('wraps an existing unrelated statusLine instead of clobbering it', () => {
    const existing = { statusLine: { type: 'command', command: 'bash ~/.claude/my-status.sh' } };
    const { settings, changed, wrapper } = withWardenStatusLineRegistered(
      existing,
      STATUSLINE,
      WRAPPER,
    );
    assert.equal(changed, true);
    assert.deepEqual(settings.statusLine, { type: 'command', command: `bash '${WRAPPER}'` });
    assert.deepEqual(wrapper, { path: WRAPPER, previousCommand: 'bash ~/.claude/my-status.sh' });
    assert.equal(existing.statusLine.command, 'bash ~/.claude/my-status.sh');
  });

  test('is idempotent once the wrapper is installed, so it never wraps itself', () => {
    const wrapped = withWardenStatusLineRegistered(
      { statusLine: { type: 'command', command: 'bash ~/.claude/my-status.sh' } },
      STATUSLINE,
      WRAPPER,
    ).settings;
    const { changed, wrapper, wrapperInUse } = withWardenStatusLineRegistered(
      wrapped,
      STATUSLINE,
      WRAPPER,
    );
    assert.equal(changed, false);
    assert.equal(wrapper, null);
    assert.equal(wrapperInUse, true);
  });

  // A tilde spelling of the wrapper is the same file. Matched by raw
  // substring it would be missed, and the wrapper would then run itself.
  test('recognizes the wrapper written as a ~ path, so it cannot recurse', () => {
    const { changed, wrapper, wrapperInUse } = withWardenStatusLineRegistered(
      { statusLine: { type: 'command', command: 'bash ~/.warden/claude-statusline.sh' } },
      STATUSLINE,
      WRAPPER,
    );
    assert.equal(changed, false);
    assert.equal(wrapper, null);
    assert.equal(wrapperInUse, true);
  });

  test('a path merely quoted inside another command does not count as registered', () => {
    const { changed, wrapper } = withWardenStatusLineRegistered(
      { statusLine: { type: 'command', command: `echo "see ${STATUSLINE} for details"` } },
      STATUSLINE,
      WRAPPER,
    );
    assert.equal(changed, true);
    assert.equal(wrapper.previousCommand, `echo "see ${STATUSLINE} for details"`);
  });

  test('preserves other keys on the settings object', () => {
    const existing = { theme: 'dark' };
    const { settings } = withWardenStatusLineRegistered(existing, STATUSLINE, WRAPPER);
    assert.equal(settings.theme, 'dark');
  });
});

describe('withWardenStatusLineUnregistered', () => {
  const STATUSLINE = '/path/to/statusline.js';
  const WRAPPER = `${os.homedir()}/.warden/claude-statusline.sh`;

  test('directly-registered statusLine: removes the key, restoring settings byte-identical to pre-install', () => {
    const before = { theme: 'dark' };
    const installed = withWardenStatusLineRegistered(before, STATUSLINE, WRAPPER).settings;
    const { settings, changed } = withWardenStatusLineUnregistered(installed, STATUSLINE, WRAPPER);
    assert.equal(changed, true);
    assert.deepEqual(settings, before);
  });

  test('wrapper-registered statusLine: restores the wrapped previous command', () => {
    const existing = { statusLine: { type: 'command', command: 'bash ~/.claude/my-status.sh' } };
    const { settings: installed, wrapper } = withWardenStatusLineRegistered(
      existing,
      STATUSLINE,
      WRAPPER,
    );
    const wrapperContents = wrapperScriptContents(wrapper.previousCommand, STATUSLINE);
    const { settings, changed } = withWardenStatusLineUnregistered(
      installed,
      STATUSLINE,
      WRAPPER,
      wrapperContents,
    );
    assert.equal(changed, true);
    assert.deepEqual(settings.statusLine, {
      type: 'command',
      command: 'bash ~/.claude/my-status.sh',
    });
  });

  test('does nothing when statusLine points at neither warden nor its wrapper', () => {
    const existing = { statusLine: { type: 'command', command: 'bash ~/other.sh' } };
    const { settings, changed } = withWardenStatusLineUnregistered(existing, STATUSLINE, WRAPPER);
    assert.equal(changed, false);
    assert.deepEqual(settings, existing);
  });

  test('does nothing when no statusLine is configured', () => {
    const { settings, changed } = withWardenStatusLineUnregistered({}, STATUSLINE, WRAPPER);
    assert.equal(changed, false);
    assert.deepEqual(settings, {});
  });

  test('is idempotent — uninstalling twice does nothing the second time', () => {
    const first = withWardenStatusLineRegistered({}, STATUSLINE, WRAPPER).settings;
    const once = withWardenStatusLineUnregistered(first, STATUSLINE, WRAPPER).settings;
    const { settings, changed } = withWardenStatusLineUnregistered(once, STATUSLINE, WRAPPER);
    assert.equal(changed, false);
    assert.deepEqual(settings, once);
  });
});

describe('parsePreviousCommandFromWrapper', () => {
  test('recovers the exact previous command the wrapper chains, including special characters', () => {
    const previousCommand = "echo 'hi'\nsecond line";
    const contents = wrapperScriptContents(previousCommand, '/w/statusline.js');
    assert.equal(parsePreviousCommandFromWrapper(contents), previousCommand);
  });

  test('returns null for a wrapper file with no recognizable marker', () => {
    assert.equal(parsePreviousCommandFromWrapper('#!/bin/bash\necho hi\n'), null);
  });
});

describe('wrapperScriptContents', () => {
  test('reads stdin once and replays it to both commands', () => {
    const script = wrapperScriptContents('bash ~/.claude/my-status.sh', '/w/statusline.js');
    assert.match(script, /^#!\/bin\/bash\n/);
    assert.match(script, /^input=\$\(cat\)$/m);
    assert.ok(script.includes(`printf '%s' "$input" | bash -c 'bash ~/.claude/my-status.sh'`));
    assert.ok(script.includes(`printf '%s' "$input" | node '/w/statusline.js'`));
  });

  test("runs the previous command first, so warden's line is appended below it", () => {
    const script = wrapperScriptContents('previous-cmd', '/w/statusline.js');
    assert.ok(script.indexOf('previous-cmd') < script.indexOf('/w/statusline.js'));
  });

  test('does not set -e, so one failing command cannot suppress the other', () => {
    assert.doesNotMatch(wrapperScriptContents('previous-cmd', '/w/s.js'), /set -e/);
  });

  test('guards against re-entry, so an unseen chain cannot recurse forever', () => {
    assert.match(wrapperScriptContents('cmd', '/w/s.js'), /WARDEN_STATUSLINE_ACTIVE/);
  });

  // Interpolated raw, a newline would split the command across wrapper lines
  // and only its first part would receive stdin.
  test('keeps a multi-line previous command intact as one shell input', () => {
    const script = wrapperScriptContents('echo a\necho b', '/w/s.js');
    assert.ok(script.includes(`bash -c 'echo a\necho b'`));
  });

  test('escapes a single quote in the previous command', () => {
    const script = wrapperScriptContents("echo 'hi'", '/w/s.js');
    assert.ok(script.includes(`bash -c 'echo '\\''hi'\\'''`));
  });
});

describe('statusLineDriftMessage', () => {
  const STATUSLINE = '/w/statusline.js';
  const WRAPPER = '/home/.warden/claude-statusline.sh';

  test('returns null when statusLine is absent', () => {
    assert.equal(statusLineDriftMessage({}, STATUSLINE, WRAPPER), null);
  });

  test('returns null when statusLine runs warden directly', () => {
    const settings = { statusLine: { command: `node ${STATUSLINE}` } };
    assert.equal(statusLineDriftMessage(settings, STATUSLINE, WRAPPER), null);
  });

  test('returns null when statusLine runs the wrapper', () => {
    const settings = { statusLine: { command: `bash ${WRAPPER}` } };
    assert.equal(statusLineDriftMessage(settings, STATUSLINE, WRAPPER), null);
  });

  test('returns a message when statusLine runs neither', () => {
    const settings = { statusLine: { command: 'node ~/.claude/other-status.js' } };
    const message = statusLineDriftMessage(settings, STATUSLINE, WRAPPER);
    assert.match(message, /other-status\.js/);
    assert.match(message, /warden/i);
  });
});

describe('registerHook / unregisterHook round trip', () => {
  test('settings file is byte-identical to pre-install after uninstall', () => {
    const dir = makeTmpDir();
    const settingsPath = path.join(dir, 'settings.json');
    const before = { otherKey: 'unrelated', hooks: { SessionStart: [{ hooks: [] }] } };
    fs.writeFileSync(settingsPath, JSON.stringify(before, null, 2) + '\n');
    const beforeContents = fs.readFileSync(settingsPath, 'utf8');

    registerHook(settingsPath, '/path/to/adapter.js', 'Test Harness');
    assert.notEqual(fs.readFileSync(settingsPath, 'utf8'), beforeContents);

    unregisterHook(settingsPath, '/path/to/adapter.js', 'Test Harness');
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), beforeContents);
  });

  test('unregisterHook is idempotent', () => {
    const dir = makeTmpDir();
    const settingsPath = path.join(dir, 'settings.json');
    registerHook(settingsPath, '/path/to/adapter.js', 'Test Harness');
    unregisterHook(settingsPath, '/path/to/adapter.js', 'Test Harness');
    const once = fs.readFileSync(settingsPath, 'utf8');
    unregisterHook(settingsPath, '/path/to/adapter.js', 'Test Harness');
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), once);
  });

  test('repeated install/uninstall keeps only the newest 5 backups', () => {
    const dir = makeTmpDir();
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsPath, '{}\n');
    for (let i = 0; i < 8; i++) {
      registerHook(settingsPath, '/path/to/adapter.js', 'Test Harness');
      unregisterHook(settingsPath, '/path/to/adapter.js', 'Test Harness');
    }
    const backups = fs.readdirSync(dir).filter((name) => name.includes('.bak.'));
    assert.ok(backups.length <= 5, `expected at most 5 backups, got ${backups.length}`);
  });
});

describe('registerArrayEntry / unregisterArrayEntry round trip', () => {
  test('config file is byte-identical to pre-install after uninstall', () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, 'config.json');
    const before = { otherKey: 'unrelated' };
    fs.writeFileSync(filePath, JSON.stringify(before, null, 2) + '\n');
    const beforeContents = fs.readFileSync(filePath, 'utf8');

    registerArrayEntry(filePath, 'packages', '/path/to/entry.js', 'Test Harness');
    assert.notEqual(fs.readFileSync(filePath, 'utf8'), beforeContents);

    unregisterArrayEntry(filePath, 'packages', '/path/to/entry.js', 'Test Harness');
    assert.equal(fs.readFileSync(filePath, 'utf8'), beforeContents);
  });

  test('unregisterArrayEntry is idempotent', () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, 'config.json');
    registerArrayEntry(filePath, 'packages', '/path/to/entry.js', 'Test Harness');
    unregisterArrayEntry(filePath, 'packages', '/path/to/entry.js', 'Test Harness');
    const once = fs.readFileSync(filePath, 'utf8');
    unregisterArrayEntry(filePath, 'packages', '/path/to/entry.js', 'Test Harness');
    assert.equal(fs.readFileSync(filePath, 'utf8'), once);
  });
});
