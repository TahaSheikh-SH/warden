'use strict';

// Claude Code entry point: harnesses/claude-code/transcript.js normalizes,
// core/resourceStateCore.js reduces. Nothing harness-specific belongs in the
// core (AGENTS.md).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  foldEntry,
  finalizeAccumulator,
  initialAccumulator,
  isContextUsageTrustworthy,
} = require('./core/resourceStateCore');
const {
  validateTranscriptEntry,
  streamNormalizedEntries,
} = require('./harnesses/claude-code/transcript');
const { decide } = require('./decide');

// Hook adapters spawn a fresh process per turn, so the accumulator is
// persisted between invocations — otherwise every turn re-folds from line 1.
const CACHE_DIR = path.join(os.homedir(), '.warden', 'cache');

// A short hash of the raw key is appended because sanitizing unsafe
// characters alone is lossy (e.g. "/a/b" and "a-b" both collapse to "a_b"),
// which would otherwise let two different sessions share one cache file.
function cacheFileFor(sessionFilePath) {
  const raw = String(sessionFilePath);
  const safeKey = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return path.join(CACHE_DIR, `${safeKey}-${hash}.json`);
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

// Streams a session .jsonl into a ResourceState, folding onto the cache
// above. `opts.maxLines` bypasses the cache: a partial-replay backtest
// evaluates an out-of-order prefix that must not poison it.
async function buildResourceState(sessionFilePath, opts = {}) {
  const useCache = !opts.maxLines;
  const cached = useCache ? readAccumulatorCache(sessionFilePath) : null;
  const accumulator = cached ? cached.accumulator : initialAccumulator();
  const progress = { lineCount: cached ? cached.lineCount : 0 };

  const entries = streamNormalizedEntries(sessionFilePath, {
    maxLines: opts.maxLines,
    startLine: progress.lineCount,
    progress,
  });
  for await (const entry of entries) {
    foldEntry(accumulator, entry);
  }

  if (useCache) {
    writeAccumulatorCache(sessionFilePath, {
      lineCount: progress.lineCount,
      fileSize: fs.statSync(sessionFilePath).size,
      accumulator,
    });
  }

  // Pass the override through unset: pre-resolving a default here made
  // opts.contextWindowTokens always truthy in finalizeAccumulator, so the
  // window detected from message.model was never consulted.
  const state = finalizeAccumulator(accumulator, {
    contextWindowTokens: opts.contextWindowTokens,
  });

  // Logged so an 'unknown' window is visible rather than silent.
  const contextWindowSource = opts.contextWindowTokens
    ? 'override'
    : accumulator.detectedContextWindowTokens
      ? 'detected'
      : 'unknown';

  return { ...state, sessionFilePath, contextWindowSource };
}

// Returns null decision when usage can't be trusted — caller decides how
// to surface that (printed UNKNOWN line vs. fail-open hook exit).
async function evaluateSession(sessionFilePath, { contextWindowTokens } = {}) {
  const state = await buildResourceState(sessionFilePath, { contextWindowTokens });
  if (!isContextUsageTrustworthy(state)) {
    return { state, decision: null };
  }
  return { state, decision: decide(state) };
}

module.exports = {
  buildResourceState,
  evaluateSession,
  isContextUsageTrustworthy,
  validateTranscriptEntry,
};
