'use strict';

// Pi coding-agent in-process extension (@earendil-works/pi-coding-agent
// ExtensionAPI). Not a spawned-hook-script harness — extensions load
// directly into the running agent, registering handlers on a `pi` object.
// `ctx.getContextUsage()` gives the live {tokens, contextWindow, percent},
// `ctx.ui.notify(message, "warning")` is the nudge mechanism.
// harnesses/pi/transcript.js still exists for offline backtesting against
// saved session .jsonl files — this file is the live path.

const { decide, ACTIONS } = require('../../decide');
const { computeGrowthProjection, GROWTH_WINDOW_TURNS } = require('../../core/resourceStateCore');
const {
  nudgeMessageFor,
  appendLogEntry,
  getLastNudgedAction,
  escalateHandoffToStop,
  maybeNotifyHuman,
} = require('../../actuators/shared');

function logDecision(decision, state, sessionKey, logFilePath) {
  appendLogEntry(
    {
      timestamp: new Date().toISOString(),
      harness: 'pi',
      sessionKey,
      action: decision.action,
      reasons: decision.reasons,
      contextUsedPct: state.contextUsedPct,
      compactionCount: state.compactionCount,
      sessionAgeMinutes: state.sessionAgeMinutes,
    },
    logFilePath,
  );
}

// Tracks session state decide() needs (compaction count, burn-rate window,
// session age) beyond what ctx.getContextUsage() carries, and turns a live
// usage snapshot into a decide()-shaped ResourceState. Exported separately
// so it's testable without a real ExtensionContext.
function createSessionTracker({ logFilePath } = {}) {
  const startedAt = Date.now();
  // process.pid guards against two pi processes starting in the same ms.
  const sessionKey = `pi-${startedAt}-${process.pid}`;
  let compactionCount = 0;
  let recentTurnTokens = [];

  return {
    sessionKey,
    logFilePath,
    onCompact() {
      compactionCount += 1;
      recentTurnTokens = []; // pre-compaction growth isn't representative anymore
    },
    onTurnEnd(usage) {
      const contextWindowTokens = usage.contextWindow;
      const contextUsedTokens = usage.tokens || 0;

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
        // Evaluated live right as the turn ended — no idle gap to measure.
        lastActivityAgeMinutes: 0,
      };
    },
  };
}

const respondFor = nudgeMessageFor;

// Install by adding this file's path to `packages` in
// ~/.pi/agent/settings.json (or `pi install <path>`). `options.logFilePath`
// overrides the default ~/.warden/log.jsonl — used by tests.
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

    // Dedup like native.js's alreadyNudgedThisAction, or ctx.ui.notify
    // spams the same nudge every turn the action stays non-CONTINUE.
    // Read BEFORE logDecision appends this turn's own entry.
    const alreadyNudgedThisAction =
      getLastNudgedAction(tracker.sessionKey, tracker.logFilePath) === decision.action;

    const effectiveDecision = escalateHandoffToStop(
      decision,
      tracker.sessionKey,
      tracker.logFilePath,
    );

    logDecision(effectiveDecision, state, tracker.sessionKey, tracker.logFilePath);
    maybeNotifyHuman(effectiveDecision, tracker.sessionKey, tracker.logFilePath, notifyOpts);

    const message = respondFor(effectiveDecision.action, effectiveDecision.reasons);
    // Armed here for the NEXT tool call — turn_end fires after the turn
    // already completed, so the block goes through tool_call, not dedup.
    stopBlockMessage = effectiveDecision.action === ACTIONS.STOP ? message : null;

    if ((effectiveDecision.action !== ACTIONS.STOP && alreadyNudgedThisAction) || !message) return;
    if (!ctx.hasUI) return;

    ctx.ui.notify(message, effectiveDecision.action === ACTIONS.STOP ? 'error' : 'warning');
  });
}

module.exports = { WardenPiExtension, createSessionTracker, respondFor };
module.exports.default = WardenPiExtension;
