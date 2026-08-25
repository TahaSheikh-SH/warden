'use strict';

// Pct-of-window thresholds alone don't scale — 0.8*200k and 0.8*1M aren't
// the same context rot. Absolute-token floors below enforce the Chroma
// Context Rot (trychroma.com/research/context-rot) and Augment Code
// agent-loop-cost (augmentcode.com/guides/ai-agent-loop-token-cost-context-constraints)
// findings regardless of window size; whichever bound (pct or absolute)
// hits first wins.
const THRESHOLDS = {
  handoffContextPct: 0.92,
  compactContextPct: 0.8,
  checkpointContextPct: 0.6,
  // 60/80% bands per Zylos Research session-lifecycle guidance
  // (zylos.ai/research/2026-03-31-context-window-management-session-lifecycle-long-running-agents/).
  compactContextTokens: 100000,
  handoffContextTokens: 200000,
  checkpointCompactionCount: 2,
  checkpointSessionAgeMinutes: 240,
  // Idle sessions aren't "aging" in the resource sense, so age only
  // applies while someone's actively working in it.
  activeSessionMaxIdleMinutes: 30,
  // Fires COMPACT if trailing growth rate projects overflow within this
  // many turns, even below compactContextPct. Floored by
  // minPctForBurnRateTrigger so one volatile early turn can't trigger it.
  burnRateMinTurnsUntilOverflow: 3,
  minPctForBurnRateTrigger: 0.5,
};

const ACTIONS = Object.freeze({
  CONTINUE: 'CONTINUE',
  COMPACT: 'COMPACT',
  CHECKPOINT: 'CHECKPOINT',
  HANDOFF: 'HANDOFF',
  STOP: 'STOP',
});

function exceedsHandoffThreshold(state) {
  const overPct = state.contextUsedPct >= THRESHOLDS.handoffContextPct;
  const overAbsolute = state.contextUsedTokens >= THRESHOLDS.handoffContextTokens;
  if (!overPct && !overAbsolute) return null;
  return {
    action: ACTIONS.HANDOFF,
    reason: overAbsolute
      ? `context used ${state.contextUsedTokens.toLocaleString()} tokens >= ` +
        `${THRESHOLDS.handoffContextTokens.toLocaleString()}-token handoff floor ` +
        `(Augment Code, 2026 — severe planning drift/impatience loops past this point)`
      : `context used ${(state.contextUsedPct * 100).toFixed(1)}% >= ` +
        `${(THRESHOLDS.handoffContextPct * 100).toFixed(0)}% handoff threshold`,
  };
}

// CAVEAT: compacting rewrites the prompt prefix, invalidating the cache, so
// the next turn pays a full cache write — COMPACT can raise cost even as the
// token count drops. Measured over 84 transcripts / 79 real compactions:
// that costs ~1.4% of spend, too little to move THRESHOLDS on its own. The
// unmodelled costs that do matter are latency (~153s median per compaction)
// and firing early — the absolute floor below trips near 0.6x the context
// where compaction actually happened (median ~168k). Changing it needs the
// false-positive rate hardened first, per AGENTS.md.
function exceedsCompactThreshold(state) {
  const overPct = state.contextUsedPct >= THRESHOLDS.compactContextPct;
  const overAbsolute = state.contextUsedTokens >= THRESHOLDS.compactContextTokens;
  if (!overPct && !overAbsolute) return null;
  return {
    action: ACTIONS.COMPACT,
    reason: overAbsolute
      ? `context used ${state.contextUsedTokens.toLocaleString()} tokens >= ` +
        `${THRESHOLDS.compactContextTokens.toLocaleString()}-token compact floor ` +
        `(Chroma Context Rot, 2026 — accuracy holds only up to ~50k-60k tokens)`
      : `context used ${(state.contextUsedPct * 100).toFixed(1)}% >= ` +
        `${(THRESHOLDS.compactContextPct * 100).toFixed(0)}% compact threshold ` +
        `(Zylos Research, 2026 — rotate before 80% capacity)`,
  };
}

function isBurstingBurnRate(state) {
  const withinBurnRateFloor = state.contextUsedPct >= THRESHOLDS.minPctForBurnRateTrigger;
  const projectsOverflowSoon =
    state.projectedTurnsUntilOverflow !== null &&
    state.projectedTurnsUntilOverflow <= THRESHOLDS.burnRateMinTurnsUntilOverflow;
  if (!withinBurnRateFloor || !projectsOverflowSoon) return null;
  return {
    action: ACTIONS.COMPACT,
    reason:
      `context growing ~${Math.round(state.contextGrowthPerTurn).toLocaleString()} tokens/turn — ` +
      `projected to overflow in ${state.projectedTurnsUntilOverflow.toFixed(1)} turns, ` +
      `ahead of the ${(THRESHOLDS.compactContextPct * 100).toFixed(0)}% static threshold`,
  };
}

function isRepeatedCompactionDegrading(state) {
  const compactedEnoughTimes = state.compactionCount >= THRESHOLDS.checkpointCompactionCount;
  const backUpToCheckpointPct = state.contextUsedPct >= THRESHOLDS.checkpointContextPct;
  if (!compactedEnoughTimes || !backUpToCheckpointPct) return null;
  return {
    action: ACTIONS.CHECKPOINT,
    reason:
      `${state.compactionCount} compactions already happened and context is ` +
      `back up to ${(state.contextUsedPct * 100).toFixed(1)}% — repeated ` +
      `compaction is degrading, not fixing, this session (Codex itself warns ` +
      `multiple compactions reduce accuracy — github.com/openai/codex#14589; ` +
      `${(THRESHOLDS.checkpointContextPct * 100).toFixed(0)}% checkpoint band ` +
      `per Zylos Research, 2026 early-warning guidance)`,
  };
}

function isAgingActiveSession(state) {
  const isActive =
    state.lastActivityAgeMinutes !== null &&
    state.lastActivityAgeMinutes <= THRESHOLDS.activeSessionMaxIdleMinutes;
  if (!isActive || state.sessionAgeMinutes < THRESHOLDS.checkpointSessionAgeMinutes) return null;
  return {
    action: ACTIONS.CHECKPOINT,
    reason:
      `session age ${state.sessionAgeMinutes.toFixed(0)}m >= ` +
      `${THRESHOLDS.checkpointSessionAgeMinutes}m checkpoint threshold`,
  };
}

function withinAllThresholds(state) {
  return {
    action: ACTIONS.CONTINUE,
    reason:
      `context used ${(state.contextUsedPct * 100).toFixed(1)}%, ` +
      `${state.compactionCount} compactions, ` +
      `${state.sessionAgeMinutes.toFixed(0)}m old — within thresholds`,
  };
}

// Priority order, first match wins; withinAllThresholds is the fallback.
// isRepeatedCompactionDegrading must run before exceedsCompactThreshold/
// isBurstingBurnRate — otherwise COMPACT would mask the repeated-compaction
// failure mode forever once pct>=0.8.
const RULES = [
  exceedsHandoffThreshold,
  isRepeatedCompactionDegrading,
  exceedsCompactThreshold,
  isBurstingBurnRate,
  isAgingActiveSession,
];

/**
 * Pure decision function: ResourceState in, {action, reasons} out. No I/O,
 * no side effects. decide() never emits STOP; that action exists in the
 * enum for the actuator layer, which escalates ignored HANDOFFs into it.
 *
 * Implemented as a composed pipeline of named predicates (one per rule),
 * each independently testable, rather than one long if/else chain.
 */
function decide(state) {
  for (const rule of RULES) {
    const match = rule(state);
    if (match) return { action: match.action, reasons: [match.reason] };
  }

  const fallback = withinAllThresholds(state);
  return { action: fallback.action, reasons: [fallback.reason] };
}

module.exports = { decide, ACTIONS, THRESHOLDS };
