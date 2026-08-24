'use strict';

// Decides when an ignored HANDOFF becomes a hard STOP, and when to notify
// the human. Pure decision logic; log I/O and notification delivery live
// in notify.js.

const fs = require('fs');
const { ACTIONS } = require('../decide');
const { sessionLogFile, readLogLines } = require('./logStore');

// Backtest (scripts/cost-curve.js, 4 real transcripts): 5-turn grace past
// HANDOFF costs $0.26-$0.66; riding out an ignored HANDOFF to session end
// costs 46-97% of total spend. Grace is cheap, unbounded continuation isn't.
const GRACE_TURN_LIMIT = 5;

// Fixed 2-turn lead before HANDOFF hard-escalates to STOP, giving a human
// a chance to react before severity increases. Not independently
// cost-optimized — see projects/2026-08-23-stress-test-findings/reference/
// 08-notify-limit-backtest-data.md for why turn 3 isn't uniquely justified
// over 2 or 4.
const NOTIFY_TURN_LIMIT = GRACE_TURN_LIMIT - 2;

// Re-fire at GRACE_TURN_LIMIT so a human who missed the first notification
// gets a second chance right before STOP fires.
const NOTIFY_MILESTONES = [NOTIFY_TURN_LIMIT, GRACE_TURN_LIMIT];

// Fails open (null) on a missing/unreadable log — a broken log must never
// block a turn.
function getLastNudgedAction(sessionKey, logFilePath = sessionLogFile(sessionKey)) {
  try {
    const lines = readLogLines(logFilePath);
    for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
      if (!lines[lineIndex]) continue;
      let entry;
      try {
        entry = JSON.parse(lines[lineIndex]);
      } catch {
        continue;
      }
      if (entry.sessionKey === sessionKey) return entry.action;
    }
    return null;
  } catch {
    return null;
  }
}

// Full-log scan so an intervening CONTINUE after a STOP doesn't re-arm
// grace — sticky-STOP must survive a harness that logs every turn.
function hasEverStopped(sessionKey, logFilePath = sessionLogFile(sessionKey), lines = null) {
  try {
    for (const line of lines ?? readLogLines(logFilePath)) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.sessionKey === sessionKey && entry.action === ACTIONS.STOP) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Consecutive most-recent entries for this sessionKey matching `action`;
// other sessions' entries are skipped, not treated as breaks.
function countTrailingAction(
  action,
  sessionKey,
  logFilePath = sessionLogFile(sessionKey),
  lines = null,
) {
  try {
    const allLines = lines ?? readLogLines(logFilePath);
    let count = 0;
    for (let lineIndex = allLines.length - 1; lineIndex >= 0; lineIndex--) {
      if (!allLines[lineIndex]) continue;
      let entry;
      try {
        entry = JSON.parse(allLines[lineIndex]);
      } catch {
        continue;
      }
      if (entry.sessionKey !== sessionKey) continue;
      if (entry.action !== action) break;
      count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

// Sidecar recording the highest milestone already notified, so a count
// that jumps past a milestone (e.g. 2 -> 4) still gets one notification
// instead of going silent. Best-effort: a failed read/write risks a
// duplicate/missed notify, never a blocked turn.
function notifyMarkerFile(logFilePath) {
  return `${logFilePath}.notified`;
}

function readNotifiedMilestone(markerFilePath) {
  try {
    if (!fs.existsSync(markerFilePath)) return 0;
    const parsedMilestone = Number(fs.readFileSync(markerFilePath, 'utf8').trim());
    return Number.isFinite(parsedMilestone) ? parsedMilestone : 0;
  } catch {
    return 0;
  }
}

function markMilestoneNotified(markerFilePath, milestone) {
  try {
    fs.writeFileSync(markerFilePath, String(milestone));
  } catch {
    // best-effort
  }
}

// Highest milestone at or below `count`, or null if none reached yet.
function highestReachedMilestone(count) {
  let reached = null;
  for (const milestone of NOTIFY_MILESTONES) {
    if (count >= milestone) reached = milestone;
  }
  return reached;
}

// Fires once per milestone (tracked via the persisted marker above), not
// every turn past the first, so an ignored streak gets a few chances to
// reach the human instead of spamming a notification each turn.
function shouldNotifyHuman(
  action,
  sessionKey,
  logFilePath = sessionLogFile(sessionKey),
  markerFilePath = notifyMarkerFile(logFilePath),
) {
  if (action === ACTIONS.CONTINUE) return false;
  const count = countTrailingAction(action, sessionKey, logFilePath);
  const reached = highestReachedMilestone(count);
  if (reached === null) return false;
  return reached > readNotifiedMilestone(markerFilePath);
}

// Escalates HANDOFF to STOP once GRACE_TURN_LIMIT consecutive HANDOFFs are
// logged for this session. Sticky: once STOP has ever fired for this
// session, every later HANDOFF re-escalates immediately instead of
// re-arming a fresh grace window.
function escalateHandoffToStop(decision, sessionKey, logFilePath = sessionLogFile(sessionKey)) {
  if (decision.action !== ACTIONS.HANDOFF) return decision;

  const lines = readLogLines(logFilePath);

  if (hasEverStopped(sessionKey, logFilePath, lines)) {
    return {
      action: ACTIONS.STOP,
      reasons: [...decision.reasons, 'HANDOFF already escalated to STOP earlier this session'],
    };
  }

  const ignoredCount = countTrailingAction(ACTIONS.HANDOFF, sessionKey, logFilePath, lines);
  if (ignoredCount >= GRACE_TURN_LIMIT) {
    return {
      action: ACTIONS.STOP,
      reasons: [...decision.reasons, `HANDOFF ignored ${ignoredCount} times in a row`],
    };
  }

  return decision;
}

module.exports = {
  GRACE_TURN_LIMIT,
  NOTIFY_TURN_LIMIT,
  NOTIFY_MILESTONES,
  getLastNudgedAction,
  countTrailingAction,
  hasEverStopped,
  escalateHandoffToStop,
  shouldNotifyHuman,
  notifyMarkerFile,
  highestReachedMilestone,
  markMilestoneNotified,
};
