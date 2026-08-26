'use strict';

// Harness-agnostic reducer. Every harness adapter normalizes its own
// transcript format into the shape below and hands entries here — this
// file must never import anything harness-specific (no fs, no per-harness
// field names). See AGENTS.md "Keep harness-specific behavior out of the
// shared core".
//
// NormalizedTranscriptEntry:
//   {
//     type: string | null,            // 'assistant' | 'user' | 'system' | ...
//     timestamp: string | null,       // ISO-ish, anything `new Date()` parses
//     usage: {
//       inputTokens, outputTokens, cacheReadTokens,
//       cacheCreationTokens: number | null,  // null = harness cannot report
//         // cache writes at all (Codex), which is not a measured zero
//     } | null,
//     isCompactionBoundary: boolean,
//     compaction: {trigger, preTokens, postTokens, durationMs} | null
//       (optional — rich compaction telemetry, Claude Code only today;
//       other harnesses leave it null. `trigger`/`preTokens`/`durationMs`
//       are diagnostics only — decide.js must never read them, since a rule
//       gated on them would decide differently by harness for a reason
//       unrelated to session state. `postTokens` may seed the post-compaction
//       token count below.)
//     sessionId, cwd, gitBranch: string | null (optional, first-wins)
//     detectedContextWindowTokens: number | null (optional, first-wins —
//       some harnesses report their real window size in-transcript, e.g.
//       Codex's per-turn model_context_window; used when the caller doesn't
//       override)
//   }

const GROWTH_WINDOW_TURNS = 5;

// Shared with harnesses/pi/extension.js, which tracks growth live instead of
// replaying a transcript — same slope math, one implementation.
function computeGrowthProjection(recentTurnTokens, contextWindowTokens, contextUsedTokens) {
  const contextGrowthPerTurn =
    recentTurnTokens.length >= 2
      ? (recentTurnTokens[recentTurnTokens.length - 1] - recentTurnTokens[0]) /
        (recentTurnTokens.length - 1)
      : null;

  const projectedTurnsUntilOverflow =
    contextGrowthPerTurn && contextGrowthPerTurn > 0 && Number.isFinite(contextWindowTokens)
      ? (contextWindowTokens - contextUsedTokens) / contextGrowthPerTurn
      : null;

  return { contextGrowthPerTurn, projectedTurnsUntilOverflow };
}

function initialAccumulator() {
  return {
    detectedContextWindowTokens: null,
    sessionId: null,
    cwd: null,
    gitBranch: null,
    // First-wins, like sessionId/cwd — format-drift diagnostic context (never
    // a gate; not every harness reports one).
    harnessVersion: null,
    firstTimestamp: null,
    lastTimestamp: null,
    messageCount: 0,
    // How many assistant entries actually carried a parsed usage object, vs.
    // messageCount below which counts assistant entries regardless. See
    // isFormatDriftDetected below.
    assistantUsageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    compactionCount: 0,
    // Auto triggers are warden being late (the harness compacted before
    // warden's own COMPACT nudge landed) — a distinct signal from a manual
    // compaction, diagnostic only.
    autoCompactionCount: 0,
    lastTurnContextTokens: 0,
    lastTurnCacheReadTokens: 0,
    // null until an assistant turn actually reports a number — see
    // applyAssistantUsage for why unknown must not collapse into 0.
    lastTurnCacheCreationTokens: null,
    recentTurnTokens: [],
    turnsSinceLastCompaction: 0,
  };
}

// First-wins: whichever entry reports a session-level field first sets it.
function applyMetadata(accumulator, entry) {
  accumulator.sessionId = accumulator.sessionId || entry.sessionId || null;
  accumulator.cwd = accumulator.cwd || entry.cwd || null;
  accumulator.gitBranch = accumulator.gitBranch || entry.gitBranch || null;
  accumulator.detectedContextWindowTokens =
    accumulator.detectedContextWindowTokens || entry.detectedContextWindowTokens || null;
  accumulator.harnessVersion = accumulator.harnessVersion || entry.harnessVersion || null;
}

function applyTimestamp(accumulator, entry) {
  if (!entry.timestamp) return;
  accumulator.firstTimestamp = accumulator.firstTimestamp || entry.timestamp;
  accumulator.lastTimestamp = entry.timestamp;
}

// Compaction resets the growth window and last-turn usage: token counts from
// before a compaction don't predict growth after one, and leaving
// lastTurnContextTokens at its pre-compaction value would make contextUsedTokens
// falsely report the old (larger) size until the next assistant turn's real
// usage lands.
function applyCompactionBoundary(accumulator, entry) {
  if (!entry.isCompactionBoundary) return;
  accumulator.compactionCount += 1;
  accumulator.recentTurnTokens = [];
  // postTokens (Claude Code only) is strictly better than assuming zero —
  // see commit 0064601 for why zeroing was needed as the fallback.
  accumulator.lastTurnContextTokens =
    entry.compaction && typeof entry.compaction.postTokens === 'number'
      ? entry.compaction.postTokens
      : 0;
  accumulator.turnsSinceLastCompaction = 0;
  if (entry.compaction && entry.compaction.trigger === 'auto') {
    accumulator.autoCompactionCount += 1;
  }
}

function applyAssistantUsage(accumulator, entry) {
  if (entry.type !== 'assistant') return;
  accumulator.messageCount += 1;

  const usage = entry.usage;
  if (!usage) return;
  accumulator.assistantUsageCount += 1;
  accumulator.turnsSinceLastCompaction += 1;

  const input = usage.inputTokens || 0;
  const output = usage.outputTokens || 0;
  const cacheRead = usage.cacheReadTokens || 0;
  // null means the harness cannot report cache writes at all, which is not a
  // measured zero. Totals fold unknown as 0 to stay additive, so a consumer
  // that needs the distinction must read the last-turn field below.
  const cacheCreation =
    typeof usage.cacheCreationTokens === 'number' ? usage.cacheCreationTokens : null;

  accumulator.totalInputTokens += input;
  accumulator.totalOutputTokens += output;
  accumulator.totalCacheReadTokens += cacheRead;
  accumulator.totalCacheCreationTokens += cacheCreation || 0;

  accumulator.lastTurnCacheReadTokens = cacheRead;
  accumulator.lastTurnCacheCreationTokens = cacheCreation;
  accumulator.lastTurnContextTokens = input + cacheRead + (cacheCreation || 0);
  accumulator.recentTurnTokens.push(accumulator.lastTurnContextTokens);
  if (accumulator.recentTurnTokens.length > GROWTH_WINDOW_TURNS) {
    accumulator.recentTurnTokens.shift();
  }
}

// Mutates and returns accumulator, so a caller holding one across turns can
// fold only new entries instead of replaying the transcript (was O(n^2)).
function foldEntry(accumulator, entry) {
  if (!entry) return accumulator;
  applyMetadata(accumulator, entry);
  applyTimestamp(accumulator, entry);
  applyCompactionBoundary(accumulator, entry);
  applyAssistantUsage(accumulator, entry);
  return accumulator;
}

// Percentage rules need a real window. >1 means the window is too small;
// null means no harness knew it. Both make contextUsedPct meaningless.
function isContextUsageTrustworthy(state) {
  return state.contextWindowTokens > 0 && state.contextUsedPct <= 1;
}

// Format-drift canary: if a harness renames the field usage lives under,
// every parsed line still validates (usage is optional) but zero assistant
// entries ever fold a usage object, so contextUsedTokens stays 0 and the
// decision pipeline silently reads CONTINUE forever. One shared rule, so
// every file-streaming adapter applies the identical threshold instead of
// each keeping its own copy. A handful of lines with no usage yet is normal
// session startup, not drift — this floor is well above that. Diagnostic
// only; nothing may gate a decide() action on it.
const FORMAT_DRIFT_LINE_THRESHOLD = 20;

function isFormatDriftDetected({ lineCount, assistantUsageCount }) {
  return lineCount > FORMAT_DRIFT_LINE_THRESHOLD && assistantUsageCount === 0;
}

function finalizeAccumulator(accumulator, opts = {}) {
  // null, not an assumed default: guessing a window is Anthropic-specific
  // knowledge the core shouldn't hold, and guessing too large silently
  // disables every percentage rule. Callers gate on the predicate below.
  const contextWindowTokens =
    opts.contextWindowTokens || accumulator.detectedContextWindowTokens || null;

  const contextUsedTokens = accumulator.lastTurnContextTokens;
  const contextUsedPct = contextWindowTokens > 0 ? contextUsedTokens / contextWindowTokens : 0;

  const { contextGrowthPerTurn, projectedTurnsUntilOverflow } = computeGrowthProjection(
    accumulator.recentTurnTokens,
    contextWindowTokens,
    contextUsedTokens,
  );

  const sessionAgeMinutes =
    accumulator.firstTimestamp && accumulator.lastTimestamp
      ? (new Date(accumulator.lastTimestamp) - new Date(accumulator.firstTimestamp)) / 60000
      : 0;

  return {
    sessionId: accumulator.sessionId,
    cwd: accumulator.cwd,
    gitBranch: accumulator.gitBranch,
    harnessVersion: accumulator.harnessVersion,
    contextWindowTokens,
    contextUsedTokens,
    contextUsedPct,
    contextGrowthPerTurn,
    projectedTurnsUntilOverflow,
    totalInputTokens: accumulator.totalInputTokens,
    totalOutputTokens: accumulator.totalOutputTokens,
    totalCacheReadTokens: accumulator.totalCacheReadTokens,
    totalCacheCreationTokens: accumulator.totalCacheCreationTokens,
    // Last-turn split, for a rule that needs cache traffic rather than size.
    lastTurnCacheReadTokens: accumulator.lastTurnCacheReadTokens,
    lastTurnCacheCreationTokens: accumulator.lastTurnCacheCreationTokens,
    compactionCount: accumulator.compactionCount,
    autoCompactionCount: accumulator.autoCompactionCount,
    sessionAgeMinutes,
    turnsSinceLastCompaction: accumulator.turnsSinceLastCompaction,
    messageCount: accumulator.messageCount,
    assistantUsageCount: accumulator.assistantUsageCount,
  };
}

// Reduces an iterable of NormalizedTranscriptEntry into a ResourceState, from
// scratch. sessionFilePath is harness-specific and attached by the caller.
async function reduceTranscriptEntries(entries, opts = {}) {
  const accumulator = initialAccumulator();
  for await (const entry of entries) {
    foldEntry(accumulator, entry);
  }
  return finalizeAccumulator(accumulator, opts);
}

module.exports = {
  reduceTranscriptEntries,
  foldEntry,
  finalizeAccumulator,
  initialAccumulator,
  computeGrowthProjection,
  isContextUsageTrustworthy,
  isFormatDriftDetected,
  GROWTH_WINDOW_TURNS,
};
