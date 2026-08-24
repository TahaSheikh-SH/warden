'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createSessionTracker,
  respondFor,
  WardenPiExtension,
} = require('../../harnesses/pi/extension');
const { ACTIONS } = require('../../decide');

describe('pi extension respondFor', () => {
  test('CONTINUE produces no message', () => {
    assert.equal(respondFor(ACTIONS.CONTINUE, []), null);
  });

  test('COMPACT produces a message naming the action', () => {
    assert.match(respondFor(ACTIONS.COMPACT, ['context high']), /Run \/compact/);
  });
});

describe('pi extension createSessionTracker', () => {
  test('turns a live getContextUsage() snapshot into a decide()-shaped state', () => {
    const logFilePath = path.join(os.tmpdir(), `warden-pi-test-${process.hrtime.bigint()}.jsonl`);
    const tracker = createSessionTracker({ logFilePath });
    const state = tracker.onTurnEnd({ tokens: 1000, contextWindow: 200000, percent: 0.5 });
    assert.equal(state.contextUsedTokens, 1000);
    assert.equal(state.contextWindowTokens, 200000);
    assert.equal(state.compactionCount, 0);
  });

  test('onCompact increments compactionCount and resets the burn-rate window', () => {
    const logFilePath = path.join(os.tmpdir(), `warden-pi-test-${process.hrtime.bigint()}.jsonl`);
    const tracker = createSessionTracker({ logFilePath });
    tracker.onTurnEnd({ tokens: 1000, contextWindow: 200000, percent: 0.5 });
    tracker.onTurnEnd({ tokens: 2000, contextWindow: 200000, percent: 1 });
    tracker.onCompact();
    const state = tracker.onTurnEnd({ tokens: 100, contextWindow: 200000, percent: 0.05 });
    assert.equal(state.compactionCount, 1);
    assert.equal(state.contextGrowthPerTurn, null); // only one sample since the reset
  });

  test('missing usage.contextWindow does not propagate NaN into projectedTurnsUntilOverflow', () => {
    const logFilePath = path.join(os.tmpdir(), `warden-pi-test-${process.hrtime.bigint()}.jsonl`);
    const tracker = createSessionTracker({ logFilePath });
    tracker.onTurnEnd({ tokens: 1000, percent: 0.5 }); // no contextWindow field
    const state = tracker.onTurnEnd({ tokens: 2000, percent: 1 });
    assert.equal(state.contextWindowTokens, undefined);
    assert.equal(state.projectedTurnsUntilOverflow, null);
  });
});

describe('WardenPiExtension', () => {
  test('registers session_compact, turn_end, and tool_call handlers, does not throw on a low-usage turn', () => {
    const logFilePath = path.join(os.tmpdir(), `warden-pi-test-${process.hrtime.bigint()}.jsonl`);
    const handlers = {};
    const pi = {
      on(event, handler) {
        handlers[event] = handler;
      },
    };
    WardenPiExtension(pi, { logFilePath });
    assert.equal(typeof handlers.session_compact, 'function');
    assert.equal(typeof handlers.turn_end, 'function');
    assert.equal(typeof handlers.tool_call, 'function');

    const ctx = {
      hasUI: true,
      getContextUsage: () => ({ tokens: 500, contextWindow: 200000, percent: 0.25 }),
      ui: { notify: () => {} },
    };
    assert.doesNotThrow(() => handlers.turn_end({ type: 'turn_end' }, ctx));
  });

  test('tool_call does not block while no STOP has been reached', () => {
    const logFilePath = path.join(os.tmpdir(), `warden-pi-test-${process.hrtime.bigint()}.jsonl`);
    const handlers = {};
    const pi = {
      on(event, handler) {
        handlers[event] = handler;
      },
    };
    WardenPiExtension(pi, { logFilePath });
    assert.equal(handlers.tool_call(), undefined);
  });
});

describe('pi extension createSessionTracker sessionKey', () => {
  test('exposes a stable sessionKey', () => {
    const logFilePath = path.join(os.tmpdir(), `warden-pi-test-${process.hrtime.bigint()}.jsonl`);
    const tracker = createSessionTracker({ logFilePath });
    assert.equal(typeof tracker.sessionKey, 'string');
    assert.ok(tracker.sessionKey.length > 0);
  });

  test('accepts an injectable logFilePath instead of always using the real default', () => {
    const logFilePath = path.join(os.tmpdir(), `warden-pi-test-${process.hrtime.bigint()}.jsonl`);
    const tracker = createSessionTracker({ logFilePath });
    assert.equal(tracker.logFilePath, logFilePath);
  });
});

describe('WardenPiExtension nudge dedup', () => {
  // Regression test for finding #4: pi's turn_end handler used to call
  // ctx.ui.notify unconditionally whenever action !== CONTINUE, spamming a
  // fresh toast every turn the session stayed e.g. above the compact
  // threshold. Ported native.js's alreadyNudgedThisAction dedup.
  test('does not re-notify on consecutive turns with the same non-CONTINUE action', () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-pi-test-dedup-${process.hrtime.bigint()}.jsonl`,
    );
    const handlers = {};
    const pi = {
      on(event, handler) {
        handlers[event] = handler;
      },
    };
    WardenPiExtension(pi, { logFilePath });

    const notifications = [];
    const ctx = {
      hasUI: true,
      // Small window so the pct-based compact threshold fires without also
      // crossing the absolute-token floors (which would escalate to
      // HANDOFF regardless of pct). Fixed usage -> same COMPACT action
      // repeated, well short of GRACE_TURN_LIMIT/STOP.
      getContextUsage: () => ({ tokens: 73000, contextWindow: 90000, percent: 81 }),
      ui: { notify: (message, severity) => notifications.push({ message, severity }) },
    };

    for (let i = 0; i < 4; i++) {
      handlers.turn_end({ type: 'turn_end' }, ctx);
    }

    assert.equal(
      notifications.length,
      1,
      'only the first occurrence of a repeated action should notify',
    );
  });

  test('re-notifies once the action changes after being deduped', () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-pi-test-dedup-change-${process.hrtime.bigint()}.jsonl`,
    );
    const handlers = {};
    const pi = {
      on(event, handler) {
        handlers[event] = handler;
      },
    };
    WardenPiExtension(pi, { logFilePath });

    const notifications = [];
    const ctx = {
      hasUI: true,
      ui: { notify: (message, severity) => notifications.push({ message, severity }) },
    };

    ctx.getContextUsage = () => ({ tokens: 73000, contextWindow: 90000, percent: 81 }); // COMPACT
    handlers.turn_end({ type: 'turn_end' }, ctx);
    handlers.turn_end({ type: 'turn_end' }, ctx); // deduped

    ctx.getContextUsage = () => ({ tokens: 85500, contextWindow: 90000, percent: 95 }); // HANDOFF
    handlers.turn_end({ type: 'turn_end' }, ctx); // new action -> notifies again

    assert.equal(notifications.length, 2);
  });
});

describe('WardenPiExtension human notify wiring', () => {
  test('calls maybeNotifyHuman via an injected execFileFn once NOTIFY_TURN_LIMIT is reached', () => {
    process.env.WARDEN_NOTIFY = '1';
    try {
      const logFilePath = path.join(
        os.tmpdir(),
        `warden-pi-test-notify-${process.hrtime.bigint()}.jsonl`,
      );
      const handlers = {};
      const pi = {
        on(event, handler) {
          handlers[event] = handler;
        },
      };
      const calls = [];
      const execFileFn = (cmd, args, cb) => {
        calls.push({ cmd, args });
        cb(null);
      };
      WardenPiExtension(pi, { logFilePath, notifyOpts: { execFileFn } });

      const ctx = {
        hasUI: true,
        // Fixed high usage every turn so decide() returns HANDOFF each call.
        getContextUsage: () => ({ tokens: 990000, contextWindow: 1000000, percent: 99 }),
        ui: { notify: () => {} },
      };

      for (let i = 0; i < 3; i++) {
        handlers.turn_end({ type: 'turn_end' }, ctx);
      }

      assert.ok(calls.length >= 1, 'maybeNotifyHuman must reach execFileFn via notifyHuman');
    } finally {
      delete process.env.WARDEN_NOTIFY;
    }
  });
});

describe('WardenPiExtension STOP escalation', () => {
  test('notifies with severity "error" (not "warning") once HANDOFF has been ignored GRACE_TURN_LIMIT times, using an injected temp log file', () => {
    const logFilePath = path.join(
      os.tmpdir(),
      `warden-pi-test-escalate-${process.hrtime.bigint()}.jsonl`,
    );
    const handlers = {};
    const pi = {
      on(event, handler) {
        handlers[event] = handler;
      },
    };
    WardenPiExtension(pi, { logFilePath });

    const notifications = [];
    const ctx = {
      hasUI: true,
      // Fixed high usage every turn so decide() returns HANDOFF each call.
      getContextUsage: () => ({ tokens: 990000, contextWindow: 1000000, percent: 99 }),
      ui: { notify: (message, severity) => notifications.push({ message, severity }) },
    };

    for (let i = 0; i < 6; i++) {
      handlers.turn_end({ type: 'turn_end' }, ctx);
    }

    const last = notifications[notifications.length - 1];
    assert.equal(last.severity, 'error');
    assert.match(last.message, /\[warden\]/);
    assert.ok(
      fs.existsSync(logFilePath),
      'escalation must log to the injected path, not the real default',
    );

    // Regression test for finding #5: pi's tool_call hook supports a real
    // {block, terminate} abort, unlike turn_end's notify-only ctx.ui.notify.
    // Once STOP is the effective decision, the next tool call must be
    // blocked and the agent terminated, not just notified.
    const blockResult = handlers.tool_call();
    assert.equal(blockResult.block, true);
    assert.equal(blockResult.terminate, true);
    assert.match(blockResult.reason, /\[warden\]/);
  });
});
