'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { notifyHuman, maybeNotifyHuman } = require('../../actuators/notify');
const { ACTIONS } = require('../../decide');

function withTempLogFile(entries) {
  const logFilePath = path.join(os.tmpdir(), `warden-notify-test-${process.hrtime.bigint()}.jsonl`);
  const lines = entries.map((entry) => JSON.stringify(entry)).join('\n');
  if (lines) fs.writeFileSync(logFilePath, lines + '\n');
  return logFilePath;
}

describe('notifyHuman', () => {
  test('invokes execFileFn with a platform-appropriate command and does not throw', () => {
    const calls = [];
    notifyHuman('test message', {
      execFileFn: (cmd, args, cb) => {
        calls.push({ cmd, args });
        cb(null);
      },
    });
    assert.equal(calls.length, 1);
    assert.ok(typeof calls[0].cmd === 'string' && calls[0].cmd.length > 0);
  });

  test('never throws when execFileFn itself throws synchronously (best-effort: swallowed, no fallback call)', () => {
    assert.doesNotThrow(() => {
      notifyHuman('test message', {
        execFileFn: () => {
          throw new Error('no such binary');
        },
      });
    });
  });

  test('never throws when execFileFn reports an error via callback', () => {
    assert.doesNotThrow(() => {
      notifyHuman('test message', {
        execFileFn: (cmd, args, cb) => cb(new Error('ENOENT')),
      });
    });
  });

  test('escapes AppleScript-significant characters in the message on darwin', (t) => {
    if (process.platform !== 'darwin') t.skip('darwin-only branch');
    const calls = [];
    notifyHuman('reason with "quotes" and \\ backslash', {
      execFileFn: (cmd, args) => {
        calls.push(args);
      },
    });
    const script = calls[0][1];
    // must not contain an unescaped quote that would close the AppleScript string early
    assert.ok(!/[^\\]"[^"]*"[^"]*"/.test(script) || script.includes('\\"'));
  });
});

describe('maybeNotifyHuman', () => {
  test('does nothing when WARDEN_NOTIFY is not set', () => {
    delete process.env.WARDEN_NOTIFY;
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
    ]);
    let called = false;
    maybeNotifyHuman({ action: ACTIONS.HANDOFF, reasons: ['test'] }, 'session-a', logFilePath, {
      execFileFn: () => {
        called = true;
      },
    });
    assert.equal(called, false);
  });

  test('notifies when WARDEN_NOTIFY=1 and trailing count hits NOTIFY_TURN_LIMIT', () => {
    process.env.WARDEN_NOTIFY = '1';
    try {
      const logFilePath = withTempLogFile([
        { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
        { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
        { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      ]);
      let called = false;
      maybeNotifyHuman({ action: ACTIONS.HANDOFF, reasons: ['test'] }, 'session-a', logFilePath, {
        execFileFn: (cmd, args, cb) => {
          called = true;
          cb(null);
        },
      });
      assert.equal(called, true);
    } finally {
      delete process.env.WARDEN_NOTIFY;
    }
  });

  test('does not notify for CONTINUE even when WARDEN_NOTIFY=1', () => {
    process.env.WARDEN_NOTIFY = '1';
    try {
      const logFilePath = withTempLogFile([{ sessionKey: 'session-a', action: ACTIONS.CONTINUE }]);
      let called = false;
      maybeNotifyHuman({ action: ACTIONS.CONTINUE, reasons: [] }, 'session-a', logFilePath, {
        execFileFn: () => {
          called = true;
        },
      });
      assert.equal(called, false);
    } finally {
      delete process.env.WARDEN_NOTIFY;
    }
  });

  test('notification body is a plain-language message, not the raw action/reason', () => {
    process.env.WARDEN_NOTIFY = '1';
    try {
      const logFilePath = withTempLogFile([
        { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
        { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
        { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      ]);
      let message = null;
      maybeNotifyHuman(
        {
          action: ACTIONS.HANDOFF,
          reasons: ['context used 190,000 tokens >= 180,000-token floor'],
        },
        'session-a',
        logFilePath,
        {
          execFileFn: (cmd, args) => {
            message = args.join(' ');
          },
        },
      );
      assert.ok(!message.includes('HANDOFF'));
      assert.ok(!message.includes('190,000'));
      assert.ok(message.includes('fresh'));
    } finally {
      delete process.env.WARDEN_NOTIFY;
    }
  });
});
