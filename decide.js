'use strict';

// Pct-of-window thresholds alone don't scale — 0.8*200k and 0.8*1M aren't
// the same context rot. compactContextTokens below enforces that regardless
// of window size; whichever bound (pct or absolute) hits first wins.
//
// Premise of the whole project — agents cannot judge their own token budget:
// Bai et al. (arXiv:2604.22750) measured self-prediction correlations up to
// only 0.39, with systematic underestimation, and proposes external "budget
// alerts" as the remedy. That's warden's reason to exist.
const THRESHOLDS = {
  handoffContextPct: 0.92,
  // 70%: MindStudio (mindstudio.ai/blog/context-rot-ai-agents-auto-compact-fix,
  // 2026) — "degradation zone starting around 70-80% context capacity" for
  // long-range reasoning coherence; recommends triggering auto-compact at 0.7
  // to fire before that zone. Blog-grade, not peer-reviewed or vendor —
  // engineering guidance, like the Zylos citation below, not a measurement.
  compactContextPct: 0.7,
  checkpointContextPct: 0.6,
  // 60% band is Zylos Research session-lifecycle engineering guidance
  // (zylos.ai/research/2026-03-31-context-window-management-session-lifecycle-long-running-agents/),
  // not a peer-reviewed or vendor measurement — adequate for a pct band,
  // not load-bearing on its own for a blocking action.
  //
  // compactContextTokens: Anthropic's own clear_tool_uses_20250919 default
  // `trigger` is 100,000 input tokens (vendor, primary — see
  // reference/claude-code-telemetry.md § 6). Corroborated by the Gemini 2.5
  // technical report (arXiv:2507.06261): past ~100k tokens agents favor
  // "repeating actions from its vast history rather than synthesizing novel
  // plans"; and by LOCA-bench (arXiv:2602.07962): Claude-4.5-Opus accuracy
  // 45.3 @ 96K / 34.0 @ 128K vs. 96.0 @ 8K baseline. Chroma Context Rot
  // (trychroma.com/research/context-rot) supports only the general claim —
  // long context degrades quality, non-uniformly — not this specific number.
  compactContextTokens: 100000,
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

// No absolute-token floor here: the prior 200,000 value had no valid
// citation (reference/source-verification.md) and, per LOCA-bench, would
// have fired *after* Claude's measured accuracy was already down to a third
// of baseline — late, not conservative. Pct-of-window is what's left; a
// future absolute floor needs its own committed backtest, not a guess.
function exceedsHandoffThreshold(state) {
  const overPct = state.contextUsedPct >= THRESHOLDS.handoffContextPct;
  if (!overPct) return null;
  return {
    action: ACTIONS.HANDOFF,
    reason:
      `context used ${(state.contextUsedPct * 100).toFixed(1)}% >= ` +
      `${(THRESHOLDS.handoffContextPct * 100).toFixed(0)}% handoff threshold`,
  };
}

// CAVEAT: compacting invalidates the prompt cache, so COMPACT can raise cost
// even as the token count drops. Measured at ~1.4% of spend over 84
// transcripts — too little to move THRESHOLDS. What does matter is firing
// early: this floor trips near 0.6x the context where compaction actually
// happened (median ~168k).
function exceedsCompactThreshold(state) {
  const overPct = state.contextUsedPct >= THRESHOLDS.compactContextPct;
  const overAbsolute = state.contextUsedTokens >= THRESHOLDS.compactContextTokens;
  if (!overPct && !overAbsolute) return null;
  return {
    action: ACTIONS.COMPACT,
    reason: overAbsolute
      ? `context used ${state.contextUsedTokens.toLocaleString()} tokens >= ` +
        `${THRESHOLDS.compactContextTokens.toLocaleString()}-token compact floor ` +
        `(Anthropic clear_tool_uses_20250919 default trigger; corroborated by ` +
        `Gemini 2.5 tech report and LOCA-bench, 2026)`
      : `context used ${(state.contextUsedPct * 100).toFixed(1)}% >= ` +
        `${(THRESHOLDS.compactContextPct * 100).toFixed(0)}% compact threshold ` +
        `(MindStudio, 2026 — engineering guidance, compact before the 70-80% ` +
        `degradation zone)`,
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
      `per Zylos Research, 2026 engineering guidance, not a measurement)`,
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

// Pure: ResourceState in, {action, reasons} out. Never emits STOP — that
// action exists for the actuator layer, which escalates ignored HANDOFFs.
function decide(state) {
  for (const rule of RULES) {
    const match = rule(state);
    if (match) return { action: match.action, reasons: [match.reason] };
  }

  const fallback = withinAllThresholds(state);
  return { action: fallback.action, reasons: [fallback.reason] };
}

module.exports = { decide, ACTIONS, THRESHOLDS };
