'use strict';

const fs = require('fs');
const readline = require('readline');

/**
 * Maps a single raw Codex CLI rollout line to the harness-agnostic
 * NormalizedTranscriptEntry shape. Confirmed against real rollout files
 * under ~/.codex/sessions/**\/*.jsonl (not just the published hooks docs,
 * which don't document the transcript format): each line is
 * {timestamp, type, payload}. Per-turn usage arrives as a top-level
 * type "event_msg" whose payload.type is "token_count" and payload.info
 * (null on the session's very first token_count line, populated after)
 * holds `last_token_usage` — the delta for that turn, not a running total
 * — plus the real `model_context_window`. Compaction is its own top-level
 * entry type, "compacted" (also seen as "compaction"/"context_compacted"
 * in older rollouts) — not nested under event_msg.
 */
function handleSessionMeta(base, entry) {
  if (!entry.payload) return base;
  base.sessionId = entry.payload.id || null;
  base.cwd = entry.payload.cwd || null;
  base.gitBranch = (entry.payload.git && entry.payload.git.branch) || null;
  return base;
}

function handleCompaction(base) {
  base.isCompactionBoundary = true;
  return base;
}

function handleEventMsg(base, entry) {
  if (!entry.payload || entry.payload.type !== 'token_count') return base;
  const info = entry.payload.info;
  if (!info || !info.last_token_usage) return base;

  const usage = info.last_token_usage;
  base.type = 'assistant';
  base.usage = {
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: usage.cached_input_tokens || 0,
    cacheCreationTokens: 0, // Codex reports no cache-write analog
  };
  base.detectedContextWindowTokens = info.model_context_window || null;
  return base;
}

function handleTurnContext(base, entry) {
  if (entry.payload) base.cwd = entry.payload.cwd || null;
  return base;
}

// Keyed by raw rollout entry.type. compacted/compaction/context_compacted
// are three names seen for the same event across Codex rollout versions.
const HANDLERS = {
  session_meta: handleSessionMeta,
  compacted: handleCompaction,
  compaction: handleCompaction,
  context_compacted: handleCompaction,
  event_msg: handleEventMsg,
  turn_context: handleTurnContext,
};

function normalizeEntry(entry) {
  const base = {
    type: null,
    timestamp: entry.timestamp || null,
    usage: null,
    isCompactionBoundary: false,
    sessionId: null,
    cwd: null,
    gitBranch: null,
    detectedContextWindowTokens: null,
  };

  const handler = HANDLERS[entry.type];
  return handler ? handler(base, entry) : base;
}

async function* streamNormalizedEntries(sessionFilePath, opts = {}) {
  const maxLines = opts.maxLines || Infinity;
  let lineCount = 0;

  const stream = readline.createInterface({
    input: fs.createReadStream(sessionFilePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of stream) {
    if (lineCount >= maxLines) {
      stream.close();
      break;
    }
    if (!line.trim()) continue;
    lineCount += 1;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    yield normalizeEntry(entry);
  }
}

module.exports = { normalizeEntry, streamNormalizedEntries };
