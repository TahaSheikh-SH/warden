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
    firstTimestamp: null,
    lastTimestamp: null,
    messageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    compactionCount: 0,
    lastTurnContextTokens: 0,
    lastTurnCacheReadTokens: 0,
    // null until an assistant turn actually reports a number — see
    // applyAssistantUsage for why unknown must not collapse into 0.
    lastTurnCacheCreationTokens: null,
    recentTurnTokens: [],
  };
}

// First-wins: whichever entry reports a session-level field first sets it.
function applyMetadata(accumulator, entry) {
  accumulator.sessionId = accumulator.sessionId || entry.sessionId || null;
  accumulator.cwd = accumulator.cwd || entry.cwd || null;
  accumulator.gitBranch = accumulator.gitBranch || entry.gitBranch || null;
  accumulator.detectedContextWindowTokens =
    accumulator.detectedContextWindowTokens || entry.detectedContextWindowTokens || null;
}

function applyTimestamp(accumulator, entry) {
  if (!entry.timestamp) return;
  accumulator.firstTimestamp = accumulator.firstTimestamp || entry.timestamp;
  accumulator.lastTimestamp = entry.timestamp;
}

// Compaction resets the growth window: token counts before a compaction
// don't predict growth after one, since the context was just rewritten.
function applyCompactionBoundary(accumulator, entry) {
  if (!entry.isCompactionBoundary) return;
  accumulator.compactionCount += 1;
  accumulator.recentTurnTokens = [];
}

function applyAssistantUsage(accumulator, entry) {
  if (entry.type !== 'assistant') return;
  accumulator.messageCount += 1;

  const usage = entry.usage;
  if (!usage) return;

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

// Pure aside from Date.now() for lastActivityAgeMinutes.
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

  const lastActivityAgeMinutes = accumulator.lastTimestamp
    ? (Date.now() - new Date(accumulator.lastTimestamp).getTime()) / 60000
    : null;

  return {
    sessionId: accumulator.sessionId,
    cwd: accumulator.cwd,
    gitBranch: accumulator.gitBranch,
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
    sessionAgeMinutes,
    lastActivityAgeMinutes,
    messageCount: accumulator.messageCount,
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
  GROWTH_WINDOW_TURNS,
};
