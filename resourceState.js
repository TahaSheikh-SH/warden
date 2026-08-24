'use strict';

// Facade kept at the repo root for backward compatibility — this file used
// to own both the Claude Code transcript parsing and the harness-agnostic
// reduction. Those are now split: harnesses/claude-code/transcript.js does
// the parsing/normalization, core/resourceStateCore.js does the reduction
// (identically for every harness). See AGENTS.md "HarnessAdapter pattern".

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  foldEntry,
  finalizeAccumulator,
  initialAccumulator,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
} = require('./core/resourceStateCore');
const {
  validateTranscriptEntry,
  streamNormalizedEntries,
} = require('./harnesses/claude-code/transcript');
const { decide } = require('./decide');

// native.js/codex spawns a fresh process per turn, so this persists
// {lineCount, fileSize, acc} to disk between invocations — otherwise every
// turn re-streams and re-folds from line 1 (O(n^2) over a session).
const CACHE_DIR = path.join(os.homedir(), '.warden', 'cache');

function cacheFileFor(sessionFilePath) {
  const safeKey = String(sessionFilePath).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CACHE_DIR, `${safeKey}.json`);
}

function readAccumulatorCache(sessionFilePath) {
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFileFor(sessionFilePath), 'utf8'));
    // Transcript is append-only; a smaller file means it was reset/reused
    // (e.g. a reused sessionKey) — the cached accumulator no longer matches
    // a prefix of it, so start over.
    if (fs.statSync(sessionFilePath).size < cache.fileSize) return null;
    return cache;
  } catch {
    return null;
  }
}

function writeAccumulatorCache(sessionFilePath, cache) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFileFor(sessionFilePath), JSON.stringify(cache));
  } catch {
    // caching is a perf optimization only, never blocks the decision
  }
}

/**
 * Streams a Claude Code session .jsonl into a ResourceState snapshot,
 * reading real per-turn `usage` blocks (see README.md "Design notes").
 * Incrementally folds onto the cache above, unless `opts.maxLines` is set
 * — a partial-replay backtest must not read/write the real cache since it
 * evaluates an out-of-order prefix.
 */
async function buildResourceState(sessionFilePath, opts = {}) {
  const contextWindowTokens = opts.contextWindowTokens || DEFAULT_CONTEXT_WINDOW_TOKENS;
  const useCache = !opts.maxLines;
  const cached = useCache ? readAccumulatorCache(sessionFilePath) : null;
  const acc = cached ? cached.acc : initialAccumulator();
  const progress = { lineCount: cached ? cached.lineCount : 0 };

  const entries = streamNormalizedEntries(sessionFilePath, {
    maxLines: opts.maxLines,
    startLine: progress.lineCount,
    progress,
  });
  for await (const entry of entries) {
    foldEntry(acc, entry);
  }

  if (useCache) {
    writeAccumulatorCache(sessionFilePath, {
      lineCount: progress.lineCount,
      fileSize: fs.statSync(sessionFilePath).size,
      acc,
    });
  }

  const state = finalizeAccumulator(acc, { contextWindowTokens });
  return { ...state, sessionFilePath };
}

// Over 100% means the assumed context window is wrong, not that the
// session overflowed.
function isContextPctTrustworthy(state) {
  return state.contextUsedPct <= 1;
}

// Returns null decision when usage can't be trusted — caller decides how
// to surface that (printed UNKNOWN line vs. fail-open hook exit).
async function evaluateSession(sessionFilePath, { contextWindowTokens } = {}) {
  const state = await buildResourceState(sessionFilePath, { contextWindowTokens });
  if (!isContextPctTrustworthy(state)) {
    return { state, decision: null };
  }
  return { state, decision: decide(state) };
}

module.exports = {
  buildResourceState,
  evaluateSession,
  isContextPctTrustworthy,
  validateTranscriptEntry,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
};
