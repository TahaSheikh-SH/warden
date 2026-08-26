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
  isFormatDriftDetected,
} = require('./core/resourceStateCore');
const {
  validateTranscriptEntry,
  streamNormalizedEntries,
} = require('./harnesses/claude-code/transcript');
const {
  resolveContextWindow,
  readAutoCompactWindowFromSettings,
} = require('./harnesses/claude-code/contextWindow');
const { decide } = require('./decide');
const { sweepDirectory } = require('./actuators/retention');

// Hook adapters spawn a fresh process per turn, so the accumulator is
// persisted between invocations — otherwise every turn re-folds from line 1.
const CACHE_DIR = path.join(os.homedir(), '.warden', 'cache');

// One file per session accumulates in the cache forever otherwise.
// Age-based, same rationale as actuators/logStore.js's SESSIONS_MAX_AGE_MS.
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// A cache written by an older warden build can be missing a field the
// current fold logic assumes exists (e.g. recentToolCalls), which threw
// `Cannot read properties of undefined (reading 'push')` on the very next
// fold — and since writeAccumulatorCache never runs downstream of a throw,
// the poisoned cache was never replaced, so warden stayed dead for that
// session until the 30-day sweep. Bump this whenever the accumulator shape
// in core/resourceStateCore.js's initialAccumulator changes.
// 3: applyToolCalls now stamps each recentToolCalls entry with a turnIndex
// (core/resourceStateCore.js). A v2 cache's recentToolCalls entries lack the
// field entirely — not wrong-shaped enough to throw on the next fold, just
// silently un-stamped, which would let un-stamped calls fold into the same
// window as newly-stamped ones. That's exactly the failure this version
// field exists to catch, so it must bump even though nothing here throws.
const CACHE_SCHEMA_VERSION = 3;

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
    // Absent (pre-versioning build) or mismatched (accumulator shape changed
    // since this cache was written) — never fold onto it. Absence is not
    // schema version 0: an explicit `=== CACHE_SCHEMA_VERSION` check treats
    // "no field at all" the same as "wrong version", both invalidate.
    if (cache.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
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
    fs.writeFileSync(
      cacheFileFor(sessionFilePath),
      JSON.stringify({ ...cache, schemaVersion: CACHE_SCHEMA_VERSION }),
    );
    sweepDirectory(CACHE_DIR, { maxAgeMs: CACHE_MAX_AGE_MS });
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
  const progress = {
    lineCount: cached ? cached.lineCount : 0,
    // Absent on a cache written before this field existed — falls back to
    // a full re-stream from byte 0 that self-upgrades the cache for next time.
    byteOffset: cached ? cached.byteOffset || 0 : 0,
  };

  const entries = streamNormalizedEntries(sessionFilePath, {
    maxLines: opts.maxLines,
    startLine: progress.lineCount,
    startByteOffset: progress.byteOffset,
    progress,
  });
  for await (const entry of entries) {
    foldEntry(accumulator, entry);
  }

  if (useCache) {
    writeAccumulatorCache(sessionFilePath, {
      lineCount: progress.lineCount,
      byteOffset: progress.byteOffset,
      fileSize: fs.statSync(sessionFilePath).size,
      accumulator,
    });
  }

  // autoCompactWindow (settings/env) can cap the model-table window lower: a
  // window guessed too large from the model name alone is silent, since
  // isContextUsageTrustworthy can only catch one that's too small.
  const { tokens: resolvedWindow, source: resolvedSource } = resolveContextWindow({
    overrideTokens: opts.contextWindowTokens,
    baseTokens: accumulator.detectedContextWindowTokens,
    baseSource: 'detected',
    settingsAutoCompactWindow: readAutoCompactWindowFromSettings(opts.settingsCwd, opts.homeDir),
    env: opts.env || process.env,
  });

  // Pass the resolved window through unset when null: pre-resolving a
  // default here made opts.contextWindowTokens always truthy in
  // finalizeAccumulator, so a detected-but-uncapped window was never
  // consulted.
  const state = finalizeAccumulator(accumulator, {
    contextWindowTokens: resolvedWindow || undefined,
  });

  const driftDetected = isFormatDriftDetected({
    messageCount: state.messageCount,
    assistantUsageCount: state.assistantUsageCount,
  });

  return { ...state, sessionFilePath, contextWindowSource: resolvedSource, driftDetected };
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
