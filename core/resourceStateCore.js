'use strict';

// Harness-agnostic reducer. Every harness adapter normalizes its own
// transcript format into the shape below and hands entries here — this
// file must never import anything harness-specific (no fs, no per-harness
// field names). See AGENTS.md "HarnessAdapter pattern".
//
// NormalizedTranscriptEntry:
//   {
//     type: string | null,            // 'assistant' | 'user' | 'system' | ...
//     timestamp: string | null,       // ISO-ish, anything `new Date()` parses
//     usage: {
//       inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
//     } | null,
//     isCompactionBoundary: boolean,
//     sessionId, cwd, gitBranch: string | null (optional, first-wins)
//     detectedContextWindowTokens: number | null (optional, first-wins —
//       some harnesses report their real window size in-transcript, e.g.
//       Codex's per-turn model_context_window; takes priority over
//       DEFAULT_CONTEXT_WINDOW_TOKENS when the caller doesn't override)
//   }

// 1M is the default, no-beta-header context window for Sonnet 5, Opus 5+,
// and Sonnet/Opus 4.6+ — the models most sessions run on now. Anyone still
// pinned to a 200k model (Sonnet 4.5, Haiku 4.5, older) sets
// WARDEN_CONTEXT_WINDOW to override. See AGENTS.md "Context window".
const DEFAULT_CONTEXT_WINDOW_TOKENS = 1000000;
const GROWTH_WINDOW_TURNS = 5;

// Shared by both the transcript reducer below and harnesses/pi/extension.js
// (which tracks growth live off ctx.getContextUsage() instead of replaying
// a transcript) — same slope-over-window math, one implementation.
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
    recentTurnTokens: [],
  };
}

// First-wins session-level fields (sessionId/cwd/gitBranch/context window)
// carried by whichever entry happens to report them first.
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
  const cacheCreation = usage.cacheCreationTokens || 0;

  accumulator.totalInputTokens += input;
  accumulator.totalOutputTokens += output;
  accumulator.totalCacheReadTokens += cacheRead;
  accumulator.totalCacheCreationTokens += cacheCreation;

  accumulator.lastTurnContextTokens = input + cacheRead + cacheCreation;
  accumulator.recentTurnTokens.push(accumulator.lastTurnContextTokens);
  if (accumulator.recentTurnTokens.length > GROWTH_WINDOW_TURNS) {
    accumulator.recentTurnTokens.shift();
  }
}

// Mutates and returns accumulator. Split out from reduceTranscriptEntries so a
// caller with a persistent accumulator can fold only new entries instead
// of replaying the whole transcript each turn (was O(n^2) over a session).
function foldEntry(accumulator, entry) {
  if (!entry) return accumulator;
  applyMetadata(accumulator, entry);
  applyTimestamp(accumulator, entry);
  applyCompactionBoundary(accumulator, entry);
  applyAssistantUsage(accumulator, entry);
  return accumulator;
}

// Pure aside from Date.now() for lastActivityAgeMinutes.
function finalizeAccumulator(accumulator, opts = {}) {
  const contextWindowTokens =
    opts.contextWindowTokens ||
    accumulator.detectedContextWindowTokens ||
    DEFAULT_CONTEXT_WINDOW_TOKENS;

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
    compactionCount: accumulator.compactionCount,
    sessionAgeMinutes,
    lastActivityAgeMinutes,
    messageCount: accumulator.messageCount,
  };
}

/**
 * Reduces an (async or sync) iterable of NormalizedTranscriptEntry into a
 * ResourceState (minus sessionFilePath, which is harness-specific and
 * attached by the caller). Full from-scratch reduction — callers that can
 * keep an accumulator across calls should use foldEntry/finalizeAccumulator
 * directly instead, to avoid re-folding entries already folded earlier.
 */
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
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  GROWTH_WINDOW_TURNS,
};
