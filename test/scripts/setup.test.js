'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const {
  withWardenHookRegistered,
  withWardenArrayEntryRegistered,
  withWardenStatusLineRegistered,
  wrapperScriptContents,
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
