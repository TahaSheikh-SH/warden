'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { notifyHuman } = require('../../actuators/notify');

// process.platform is read directly inside notifyHuman rather than injected,
// so these stub it via defineProperty (configurable, unlike a plain
// assignment) to exercise branches the real CI platform doesn't hit.
function withStubbedPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('notifyHuman cross-platform command selection', () => {
  test('uses notify-send on linux', () => {
    withStubbedPlatform('linux', () => {
      const calls = [];
      notifyHuman('linux message', {
        execFileFn: (cmd, args, cb) => {
          calls.push({ cmd, args });
          cb(null);
        },
      });
      assert.equal(calls[0].cmd, 'notify-send');
      assert.deepEqual(calls[0].args, ['warden', 'linux message']);
    });
  });

  test('uses msg on win32, targeting the running user rather than every session', () => {
    withStubbedPlatform('win32', () => {
      const originalUsername = process.env.USERNAME;
      process.env.USERNAME = 'alice';
      try {
        const calls = [];
        notifyHuman('windows message', {
          execFileFn: (cmd, args, cb) => {
            calls.push({ cmd, args });
            cb(null);
          },
        });
        assert.equal(calls[0].cmd, 'msg');
        assert.deepEqual(calls[0].args, ['alice', 'warden: windows message']);
      } finally {
        if (originalUsername === undefined) delete process.env.USERNAME;
        else process.env.USERNAME = originalUsername;
      }
    });
  });

  // Regression: 'msg *' broadcasts to every logged-in session on the host,
  // not just the one running warden.
  test('falls back to * only when USERNAME is unset', () => {
    withStubbedPlatform('win32', () => {
      const originalUsername = process.env.USERNAME;
      delete process.env.USERNAME;
      try {
        const calls = [];
        notifyHuman('windows message', {
          execFileFn: (cmd, args, cb) => {
            calls.push({ cmd, args });
            cb(null);
          },
        });
        assert.deepEqual(calls[0].args, ['*', 'warden: windows message']);
      } finally {
        if (originalUsername === undefined) delete process.env.USERNAME;
        else process.env.USERNAME = originalUsername;
      }
    });
  });

  test('falls back to stderr+bell on an unrecognized platform', () => {
    withStubbedPlatform('sunos', () => {
      let called = false;
      const originalWrite = process.stderr.write;
      process.stderr.write = (chunk) => {
        called = true;
        assert.ok(String(chunk).includes('fallback message'));
        return true;
      };
      try {
        notifyHuman('fallback message', {
          execFileFn: () => {
            throw new Error('should never be called: no cmd selected for this platform');
          },
        });
      } finally {
        process.stderr.write = originalWrite;
      }
      assert.equal(called, true);
    });
  });

  test('falls back to stderr+bell when the platform command errors via callback', () => {
    withStubbedPlatform('linux', () => {
      let called = false;
      const originalWrite = process.stderr.write;
      process.stderr.write = (chunk) => {
        called = true;
        assert.ok(String(chunk).includes('errored message'));
        return true;
      };
      try {
        notifyHuman('errored message', {
          execFileFn: (cmd, args, cb) => cb(new Error('notify-send not found')),
        });
      } finally {
        process.stderr.write = originalWrite;
      }
      assert.equal(called, true);
    });
  });
});
