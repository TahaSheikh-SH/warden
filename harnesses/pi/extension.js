'use strict';

// Pi in-process extension (@earendil-works/pi-coding-agent ExtensionAPI):
// handlers register on a `pi` object, `ctx.getContextUsage()` gives live usage,
// `ctx.ui.notify` delivers the nudge. This is the live path;
// harnesses/pi/transcript.js is for offline backtests.

const { decide, ACTIONS } = require('../../decide');
const { computeGrowthProjection, GROWTH_WINDOW_TURNS } = require('../../core/resourceStateCore');
const { nudgeMessageFor } = require('../../actuators/messages');
const { logDecision } = require('../../actuators/logStore');
const { getLastNudgedAction, escalateHandoffToStop } = require('../../actuators/escalationPolicy');
const { maybeNotifyHuman } = require('../../actuators/notify');

// Tracks what decide() needs beyond ctx.getContextUsage() — compaction count,
// burn-rate window, session age. Exported separately so it's testable without
// a real ExtensionContext.
function createSessionTracker({ logFilePath } = {}) {
  const startedAt = Date.now();
  // process.pid guards against two pi processes starting in the same ms.
  const sessionKey = `pi-${startedAt}-${process.pid}`;
  let compactionCount = 0;
  let recentTurnTokens = [];
  let turnsSinceLastCompaction = 0;

  return {
    sessionKey,
    logFilePath,
    onCompact() {
      compactionCount += 1;
      recentTurnTokens = []; // pre-compaction growth isn't representative anymore
      turnsSinceLastCompaction = 0;
    },
    onTurnEnd(usage) {
      const contextWindowTokens = usage.contextWindow;
      const contextUsedTokens = usage.tokens || 0;
      turnsSinceLastCompaction += 1;

      recentTurnTokens.push(contextUsedTokens);
      if (recentTurnTokens.length > GROWTH_WINDOW_TURNS) recentTurnTokens.shift();

      const { contextGrowthPerTurn, projectedTurnsUntilOverflow } = computeGrowthProjection(
        recentTurnTokens,
        contextWindowTokens,
        contextUsedTokens,
      );

      return {
        contextWindowTokens,
        contextUsedTokens,
        contextUsedPct:
          usage.percent != null
            ? usage.percent / 100
            : contextWindowTokens > 0
              ? contextUsedTokens / contextWindowTokens
              : 0,
        contextGrowthPerTurn,
        projectedTurnsUntilOverflow,
        compactionCount,
        sessionAgeMinutes: (Date.now() - startedAt) / 60000,
        turnsSinceLastCompaction,
      };
    },
  };
}

const respondFor = nudgeMessageFor;

// Install by adding this file's path to `packages` in
// ~/.pi/agent/settings.json, or run `npm run setup`.
function WardenPiExtension(pi, { logFilePath, notifyOpts = {} } = {}) {
  const tracker = createSessionTracker({ logFilePath });
  // Sticky once STOP is the effective decision — tool_call fires on every
  // subsequent tool call, independent of turn_end.
  let stopBlockMessage = null;

  pi.on('session_compact', () => {
    tracker.onCompact();
  });

  // tool_call fires BEFORE a tool executes and supports {block, terminate}
  // — terminate:true aborts the agent, not just the next call.
  pi.on('tool_call', () => {
    if (!stopBlockMessage) return undefined;
    return { block: true, terminate: true, reason: stopBlockMessage };
  });

  pi.on('turn_end', (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens == null) return;

    const state = tracker.onTurnEnd(usage);
    const decision = decide(state);
    if (decision.action === ACTIONS.CONTINUE) return;

    // Without this, ctx.ui.notify repeats the same nudge every turn the action
    // stays non-CONTINUE. Read BEFORE logDecision appends this turn's entry.
    const alreadyNudgedThisAction =
      getLastNudgedAction(tracker.sessionKey, tracker.logFilePath) === decision.action;

    const effectiveDecision = escalateHandoffToStop(
      decision,
      tracker.sessionKey,
      tracker.logFilePath,
    );

    logDecision({
      harness: 'pi',
      decision: effectiveDecision,
      state,
      sessionKey: tracker.sessionKey,
      logFilePath: tracker.logFilePath,
    });
    maybeNotifyHuman(effectiveDecision, tracker.sessionKey, tracker.logFilePath, notifyOpts);

    const message = respondFor(effectiveDecision.action, effectiveDecision.reasons);
    // Armed for the NEXT tool call: turn_end fires after the turn completed,
    // so the block has to go through tool_call.
    stopBlockMessage = effectiveDecision.action === ACTIONS.STOP ? message : null;

    if ((effectiveDecision.action !== ACTIONS.STOP && alreadyNudgedThisAction) || !message) return;
    if (!ctx.hasUI) return;

    ctx.ui.notify(message, effectiveDecision.action === ACTIONS.STOP ? 'error' : 'warning');
  });
}

module.exports = WardenPiExtension;
module.exports.WardenPiExtension = WardenPiExtension;
module.exports.createSessionTracker = createSessionTracker;
module.exports.respondFor = respondFor;
module.exports.default = WardenPiExtension;
