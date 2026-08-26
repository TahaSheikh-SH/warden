'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  escalateHandoffToStop,
  shouldNotifyHuman,
  GRACE_TURN_LIMIT,
  STOP_NOTIFY_MILESTONES,
  notifyMarkerFile,
  markMilestoneNotified,
} = require('../../actuators/escalationPolicy');
const { ACTIONS } = require('../../decide');

function withTempLogFile(entries) {
  const logFilePath = path.join(
    os.tmpdir(),
    `warden-escalation-test-${process.hrtime.bigint()}.jsonl`,
  );
  const lines = entries.map((entry) => JSON.stringify(entry)).join('\n');
  if (lines) fs.writeFileSync(logFilePath, lines + '\n');
  return logFilePath;
}

function streakEntries(action, count, sessionKey = 'session-a') {
  return Array.from({ length: count }, () => ({ sessionKey, action }));
}

describe('GRACE_TURN_LIMIT', () => {
  test('is 5', () => {
    assert.equal(GRACE_TURN_LIMIT, 5);
  });
});

describe('escalateHandoffToStop', () => {
  test('returns non-HANDOFF decisions unchanged', () => {
    const logFilePath = withTempLogFile([]);
    const decision = { action: ACTIONS.COMPACT, reasons: ['context high'] };
    assert.deepEqual(escalateHandoffToStop(decision, 'session-a', logFilePath), decision);
  });

  test('returns HANDOFF unchanged below GRACE_TURN_LIMIT', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
    ]);
    const decision = { action: ACTIONS.HANDOFF, reasons: ['handoff reason'] };
    assert.deepEqual(escalateHandoffToStop(decision, 'session-a', logFilePath), decision);
  });

  test('escalates to STOP once GRACE_TURN_LIMIT consecutive HANDOFF entries are logged', () => {
    const logFilePath = withTempLogFile(streakEntries(ACTIONS.HANDOFF, GRACE_TURN_LIMIT));
    const decision = { action: ACTIONS.HANDOFF, reasons: ['handoff reason'] };
    const result = escalateHandoffToStop(decision, 'session-a', logFilePath);
    assert.equal(result.action, ACTIONS.STOP);
    assert.ok(result.reasons.includes('handoff reason'));
    assert.ok(result.reasons.some((reason) => /ignored/i.test(reason)));
  });

  test('is sticky: re-escalates to STOP immediately even with 0 trailing HANDOFF entries once STOP was logged for this session', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.STOP }, // trailing HANDOFF count is now 0
    ]);
    const decision = { action: ACTIONS.HANDOFF, reasons: ['handoff reason'] };
    const result = escalateHandoffToStop(decision, 'session-a', logFilePath);
    assert.equal(result.action, ACTIONS.STOP);
  });

  test('does not escalate a different session that happens to share a log file with a STOP session', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.STOP },
      { sessionKey: 'session-b', action: ACTIONS.HANDOFF },
    ]);
    const decision = { action: ACTIONS.HANDOFF, reasons: ['handoff reason'] };
    const result = escalateHandoffToStop(decision, 'session-b', logFilePath);
    assert.equal(result.action, ACTIONS.HANDOFF);
  });

  // Regression test for finding #5: sticky-STOP used to rely on
  // getLastNudgedAction (last entry only), so a single intervening
  // CONTINUE entry logged after STOP (e.g. native/codex log every turn)
  // would clear stickiness AND reset the trailing-HANDOFF count, re-arming
  // a fresh 5-turn grace window. A later HANDOFF must still escalate to
  // STOP immediately.
  test('sticky-STOP survives an intervening CONTINUE entry: STOP, then CONTINUE, then HANDOFF must still escalate immediately', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.STOP },
      { sessionKey: 'session-a', action: ACTIONS.CONTINUE },
    ]);
    const decision = { action: ACTIONS.HANDOFF, reasons: ['handoff reason'] };
    const result = escalateHandoffToStop(decision, 'session-a', logFilePath);
    assert.equal(result.action, ACTIONS.STOP);
  });
});

describe('shouldNotifyHuman', () => {
  test('false when trailing count is below NOTIFY_TURN_LIMIT', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
    ]);
    assert.equal(shouldNotifyHuman(ACTIONS.HANDOFF, 'session-a', logFilePath), false);
  });

  test('true when trailing count equals NOTIFY_TURN_LIMIT', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
    ]);
    assert.equal(shouldNotifyHuman(ACTIONS.HANDOFF, 'session-a', logFilePath), true);
  });

  test('true again at GRACE_TURN_LIMIT (second and final re-fire, matches the STOP escalation point)', () => {
    const logFilePath = withTempLogFile(streakEntries(ACTIONS.HANDOFF, GRACE_TURN_LIMIT));
    assert.equal(shouldNotifyHuman(ACTIONS.HANDOFF, 'session-a', logFilePath), true);
  });

  // Regression test for finding #7: shouldNotifyHuman used to fire ONLY on
  // an exact count match, so a concurrent/retried write that skipped a
  // trailing count past a milestone (e.g. 2 -> 4, never hitting exactly 3)
  // silently dropped that notification for the rest of the streak. It's now
  // "count has reached a milestone not yet marked notified" — still true at
  // 4 (milestone 3 was reached and never notified) and past the last
  // milestone (milestone 5 reached and never notified), but false once the
  // marker records that milestone as already notified.
  test('true once a count has passed an unnotified milestone, even without hitting it exactly', () => {
    const between = withTempLogFile(streakEntries(ACTIONS.HANDOFF, 4));
    assert.equal(shouldNotifyHuman(ACTIONS.HANDOFF, 'session-a', between), true);

    const past = withTempLogFile(streakEntries(ACTIONS.HANDOFF, GRACE_TURN_LIMIT + 1));
    assert.equal(shouldNotifyHuman(ACTIONS.HANDOFF, 'session-a', past), true);
  });

  test('false once the reached milestone has already been marked notified', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
    ]);
    markMilestoneNotified(notifyMarkerFile(logFilePath, ACTIONS.HANDOFF), 3);
    assert.equal(shouldNotifyHuman(ACTIONS.HANDOFF, 'session-a', logFilePath), false);
  });

  test('works for COMPACT the same way as HANDOFF', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.COMPACT },
      { sessionKey: 'session-a', action: ACTIONS.COMPACT },
      { sessionKey: 'session-a', action: ACTIONS.COMPACT },
    ]);
    assert.equal(shouldNotifyHuman(ACTIONS.COMPACT, 'session-a', logFilePath), true);
  });

  test('false for CONTINUE regardless of trailing count', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.CONTINUE },
      { sessionKey: 'session-a', action: ACTIONS.CONTINUE },
      { sessionKey: 'session-a', action: ACTIONS.CONTINUE },
    ]);
    assert.equal(shouldNotifyHuman(ACTIONS.CONTINUE, 'session-a', logFilePath), false);
  });

  test('a COMPACT streak marking a high milestone does not suppress a later HANDOFF streak in the same session', () => {
    const logFilePath = withTempLogFile([
      { sessionKey: 'session-a', action: ACTIONS.COMPACT },
      { sessionKey: 'session-a', action: ACTIONS.COMPACT },
      { sessionKey: 'session-a', action: ACTIONS.COMPACT },
      { sessionKey: 'session-a', action: ACTIONS.COMPACT },
      { sessionKey: 'session-a', action: ACTIONS.COMPACT },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
      { sessionKey: 'session-a', action: ACTIONS.HANDOFF },
    ]);
    markMilestoneNotified(notifyMarkerFile(logFilePath, ACTIONS.COMPACT), 5);

    assert.equal(shouldNotifyHuman(ACTIONS.HANDOFF, 'session-a', logFilePath), true);
  });

  // Regression: the marker is a monotonic high-water mark, so a streak that
  // reached milestone 5 used to permanently block re-notifying a later
  // streak of the same action that only climbs back to 3.
  test('re-notifies a later streak of the same action after an intervening break, even below the old high-water mark', () => {
    const logFilePath = withTempLogFile([
      ...streakEntries(ACTIONS.COMPACT, 5),
      { sessionKey: 'session-a', action: ACTIONS.CONTINUE },
      ...streakEntries(ACTIONS.COMPACT, 3),
    ]);
    markMilestoneNotified(notifyMarkerFile(logFilePath, ACTIONS.COMPACT), 5);

    assert.equal(shouldNotifyHuman(ACTIONS.COMPACT, 'session-a', logFilePath), true);
  });

  // The stale-marker path must not outrank the milestone check: a re-formed
  // streak still has to reach a milestone before it notifies.
  test('a re-formed streak below the first milestone stays silent', () => {
    const logFilePath = withTempLogFile([
      ...streakEntries(ACTIONS.COMPACT, 5),
      { sessionKey: 'session-a', action: ACTIONS.CONTINUE },
      { sessionKey: 'session-a', action: ACTIONS.COMPACT },
    ]);
    markMilestoneNotified(notifyMarkerFile(logFilePath, ACTIONS.COMPACT), 5);

    assert.equal(shouldNotifyHuman(ACTIONS.COMPACT, 'session-a', logFilePath), false);
  });
});

describe('STOP notification milestones', () => {
  test('STOP_NOTIFY_MILESTONES is [1, GRACE_TURN_LIMIT]', () => {
    assert.deepEqual(STOP_NOTIFY_MILESTONES, [1, GRACE_TURN_LIMIT]);
  });

  // Fix 3: STOP's trailing count resets on escalation, so the un-gated
  // NOTIFY_MILESTONES (3, 5) left the human unnotified for two turns after
  // the first STOP — the only enforcement channel on a harness that can't block.
  test('the first STOP entry for a session notifies immediately', () => {
    const logFilePath = withTempLogFile([{ sessionKey: 'session-a', action: ACTIONS.STOP }]);
    assert.equal(shouldNotifyHuman(ACTIONS.STOP, 'session-a', logFilePath), true);
  });

  test('milestone 1 is STOP-only: a first HANDOFF still stays silent', () => {
    const logFilePath = withTempLogFile([{ sessionKey: 'session-a', action: ACTIONS.HANDOFF }]);
    assert.equal(shouldNotifyHuman(ACTIONS.HANDOFF, 'session-a', logFilePath), false);
  });
});
