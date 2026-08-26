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
  // engineering guidance, not a measurement.
  compactContextPct: 0.7,
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
  // Local backtest, 94 completed compaction epochs across 45 real sessions:
  // turns/epoch p50 104, p75 195, p90 289, max 596. Set above p90 so this
  // catches genuine outliers — a session running long on small per-turn
  // deltas, the case token-based rules can't see — without firing on the
  // ordinary long tail.
  checkpointTurnsSinceCompaction: 300,
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

// reference/compaction-backtest.md: the original premise — repeated
// compaction degrades a session — was tested against 86 real epochs across 21
// sessions and did not hold on any of four measures (H1-H3, cross-boundary
// re-reads). There is no N at which a fresh session measurably beats another
// compaction. The rule is kept and re-derived on a different, measured basis:
// every compaction costs ~43-46k tokens of cache re-write (n = 86), ~55k
// token-equivalents at the 5-minute cache-write multiplier of 1.25x, paid
// before any new work happens. That cost is real regardless of decay, so the
// rule fires on compactionCount alone — no pct corroboration required.
function isRepeatedCompactionDegrading(state) {
  const compactedEnoughTimes = state.compactionCount >= THRESHOLDS.checkpointCompactionCount;
  if (!compactedEnoughTimes) return null;
  return {
    action: ACTIONS.CHECKPOINT,
    reason:
      `${state.compactionCount} compactions already happened, each costing ` +
      `~55k token-equivalents of cache re-write (measured, ` +
      `reference/compaction-backtest.md, n=86) — that cost, not session ` +
      `decay, is why repeated compaction stops paying for itself here ` +
      `(the decay hypothesis itself failed backtest against 86 real epochs)`,
  };
}

// Wall-clock session age (sessionAgeMinutes) with an idle guard was the prior
// version of this rule — the idle guard was Date.now() vs. the transcript's
// last timestamp, evaluated in a hook that only fires because the user just
// typed, so it always read ~0 and never actually gated anything. Turns since
// the last compaction is derivable purely from the transcript (no clock),
// and catches the case token thresholds miss: a session running long on
// small per-turn deltas that never crosses compactContextPct/Tokens.
function isLongUncompactedSession(state) {
  if (state.turnsSinceLastCompaction < THRESHOLDS.checkpointTurnsSinceCompaction) return null;
  return {
    action: ACTIONS.CHECKPOINT,
    reason:
      `${state.turnsSinceLastCompaction} turns since last compaction >= ` +
      `${THRESHOLDS.checkpointTurnsSinceCompaction}-turn checkpoint threshold ` +
      `(local backtest, n=94 epochs/45 sessions, p90=289)`,
  };
}

// Repeated file view/edit detection. Bai et al. 2026 Fig. 4 and the Gemini
// 2.5 tech report both converge on the same signature, but they're a
// correlation and a behavioral observation, not a magnitude any backtest
// here can pin. So this stays observation-only: it
// strengthens the reason string on an already-firing CHECKPOINT/HANDOFF, it
// never fires an action or a threshold of its own, and 2 is the definition
// of "repeated" (not a tuned constant) — the lowest count the word can mean.
const REPEATED_ACCESS_MIN_COUNT = 2;

function repeatedFileAccessObservation(state) {
  const recentToolCalls = state.recentToolCalls || [];
  const countsByPath = new Map();
  for (const call of recentToolCalls) {
    if (!call || !call.targetPath) continue;
    countsByPath.set(call.targetPath, (countsByPath.get(call.targetPath) || 0) + 1);
  }

  let topPath = null;
  let topCount = 0;
  for (const [path, count] of countsByPath) {
    if (count > topCount) {
      topPath = path;
      topCount = count;
    }
  }

  if (topCount < REPEATED_ACCESS_MIN_COUNT) return null;
  return (
    `observation: ${topPath} accessed ${topCount} times in the last ` +
    `${recentToolCalls.length} tool calls (Bai et al. 2026 / Gemini 2.5 tech ` +
    `report — repeated file access correlates with cost/failure; not a ` +
    `diagnosis of why)`
  );
}

// Cyclic tool-call detection. Lee et al. 2026 (arXiv:2602.14798)
// measure up to 142x token amplification from cyclic tool-call trajectories
// where "individually trivial or plausible tool calls compose into cyclic
// trajectories" with "no single step looking abnormal" — invisible to every
// token-based rule above. Warden's current response makes it worse: smooth
// growth reads as COMPACT, which discards the loop's evidence and refills the
// budget it's consuming. So this rule runs before exceedsCompactThreshold/
// isBurstingBurnRate in RULES and turns what would be COMPACT into CHECKPOINT
// instead — suppression, not diagnosis: benign overthinking produces the same
// observable as the paper's malicious-tool threat model, so this reports the
// signature only, never "attack" or "loop bug".
//
// Cycle length/repeat count are definitional floors, not backtested
// magnitudes — same bar as REPEATED_ACCESS_MIN_COUNT above.
// Length 1 is excluded: a single call repeating is the file-re-access signal
// above, not an actual cycle; the shortest real cycle alternates between
// >=2 distinct calls, and "cyclic" requires that pattern to repeat >=2 times.
const CYCLE_MIN_LENGTH = 2;
const CYCLE_MIN_REPEATS = 2;

function toolCallKey(call) {
  if (!call || !call.toolName) return null;
  return `${call.toolName}:${call.targetPath || ''}`;
}

// Smallest-first: checks whether the trailing `cycleLength` calls exactly
// repeat the `cycleLength` calls immediately before them, for the tightest
// cycle length first. Calls with no toolName break the key sequence (treated
// as non-matching) rather than aborting detection entirely.
function detectToolCallCycle(recentToolCalls) {
  const keys = recentToolCalls.map(toolCallKey);
  const n = keys.length;
  const maxCycleLength = Math.floor(n / CYCLE_MIN_REPEATS);
  for (let cycleLength = CYCLE_MIN_LENGTH; cycleLength <= maxCycleLength; cycleLength += 1) {
    const tail = keys.slice(n - cycleLength);
    const priorBlock = keys.slice(n - 2 * cycleLength, n - cycleLength);
    const matches = tail.every((key, i) => key !== null && key === priorBlock[i]);
    // A degenerate pattern (every slot the same key) is the same call
    // repeating — that's the file-re-access signal above, not an actual
    // alternating cycle, even though it trivially satisfies "block equals
    // prior block" at every even cycleLength.
    if (matches && new Set(tail).size >= 2) {
      return { cycleLength, pattern: tail };
    }
  }
  return null;
}

function isCyclicToolCallLoop(state) {
  const recentToolCalls = state.recentToolCalls || [];
  const cycle = detectToolCallCycle(recentToolCalls);
  if (!cycle) return null;
  return {
    action: ACTIONS.CHECKPOINT,
    reason:
      `observation: tool-call cycle detected — [${cycle.pattern.join(', ')}] ` +
      `repeating in the last ${recentToolCalls.length} tool calls (Lee et al. ` +
      `2026, arXiv:2602.14798 — cyclic tool-call trajectories can inflate ` +
      `tokens up to 142x with no single step looking abnormal; this is the ` +
      `signature, not a diagnosis — benign overthinking produces the same ` +
      `observable). COMPACT suppressed here: compacting would discard the ` +
      `loop's evidence and refill the budget it's consuming.`,
  };
}

// Cache-thrash advisory. Repeated full-price cache writes with no
// cache read at all means the 5-minute TTL keeps expiring between turns,
// re-paying ~1.25x base input for a full prefix rewrite every turn (Bai et
// al. 2026 — input tokens dominate agentic cost even with caching enabled;
// Manus reports a 10x cost reduction from KV-cache discipline). Gate B
// degrades to 3/4: Codex has no cache-write analog
// (lastTurnCacheCreationTokens stays null there), so the streak never forms
// and this rule silently never fires — the same stand-down-on-null pattern as
// every other degraded signal, not a special case.
//
// No sixth action: this rides alongside whatever action the RULES pipeline
// already picked (unlike the observations above, which are restricted to
// CHECKPOINT/HANDOFF) — cache thrash is a cost problem independent of
// context-window state, so it can be worth surfacing even under CONTINUE.
const CACHE_THRASH_MIN_STREAK = 2;

function cacheThrashObservation(state) {
  const streak = state.consecutiveCacheThrashTurns || 0;
  if (streak < CACHE_THRASH_MIN_STREAK) return null;
  return (
    `observation: prompt cache written but not read for ${streak} consecutive ` +
    `turns — the 5-minute TTL may be expiring between turns, repaying ~1.25x ` +
    `base input as a full prefix rewrite each time (Bai et al. 2026; Manus ` +
    `reports a 10x cost reduction from KV-cache discipline). Not measurable on ` +
    `harnesses that report no cache-write figure at all (e.g. Codex).`
  );
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
  isCyclicToolCallLoop,
  exceedsCompactThreshold,
  isBurstingBurnRate,
  isLongUncompactedSession,
];

// Actions an observation is allowed to strengthen: a reason that
// strengthens CHECKPOINT/HANDOFF, not a new action — the existing
// vocabulary already covers "checkpoint and start fresh".
const OBSERVATION_ELIGIBLE_ACTIONS = new Set([ACTIONS.CHECKPOINT, ACTIONS.HANDOFF]);

// Pure: ResourceState in, {action, reasons} out. Never emits STOP — that
// action exists for the actuator layer, which escalates ignored HANDOFFs.
function decide(state) {
  for (const rule of RULES) {
    const match = rule(state);
    if (match) return finalizeDecision(state, match.action, match.reason);
  }

  const fallback = withinAllThresholds(state);
  return finalizeDecision(state, fallback.action, fallback.reason);
}

function finalizeDecision(state, action, reason) {
  const reasons = [reason];
  if (OBSERVATION_ELIGIBLE_ACTIONS.has(action)) {
    const observation = repeatedFileAccessObservation(state);
    if (observation) reasons.push(observation);
  }
  const cacheThrash = cacheThrashObservation(state);
  if (cacheThrash) reasons.push(cacheThrash);
  return { action, reasons };
}

module.exports = { decide, ACTIONS, THRESHOLDS };
