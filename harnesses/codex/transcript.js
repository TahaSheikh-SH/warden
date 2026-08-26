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
  // Normalizes alongside claude-code's
  // system.version into the shared harnessVersion field.
  base.harnessVersion = entry.payload.cli_version || null;
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
    // Codex reports no cache-write analog. Explicitly unknown, not zero — a
    // cost rule reading a real 0 here would price compaction as free on this
    // harness. See core/resourceStateCore.js applyAssistantUsage.
    cacheCreationTokens: null,
  };
  base.detectedContextWindowTokens = info.model_context_window || null;
  return base;
}

function handleTurnContext(base, entry) {
  if (entry.payload) base.cwd = entry.payload.cwd || null;
  return base;
}

// apply_patch's `input` is a patch body, not JSON — the only structured
// place a path lives is the "*** Update/Add/Delete File: <path>" header
// line. See reference/harness-capability-matrix.md verification evidence.
function pathFromPatchInput(input) {
  if (typeof input !== 'string') return null;
  const match = input.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m);
  return match ? match[1].trim() : null;
}

// Task 12/13: response_item was previously unhandled, so every Codex tool
// call was discarded (reference/harness-capability-matrix.md). function_call
// carries a JSON `arguments` string whose shape is tool-specific — only
// pull a path out when one of the common argument names is present, else
// null (e.g. exec_command has none). custom_tool_call (apply_patch) carries
// no such field; its path lives in the patch header instead.
function handleResponseItem(base, entry) {
  const payload = entry.payload;
  if (!payload || typeof payload.name !== 'string') return base;

  if (payload.type === 'function_call') {
    let targetPath = null;
    if (typeof payload.arguments === 'string') {
      try {
        const args = JSON.parse(payload.arguments);
        targetPath = args.file_path || args.path || args.file || null;
      } catch {
        targetPath = null; // arguments isn't JSON, or has no path-shaped field
      }
    }
    base.toolCalls = [{ toolName: payload.name, targetPath }];
  } else if (payload.type === 'custom_tool_call') {
    base.toolCalls = [{ toolName: payload.name, targetPath: pathFromPatchInput(payload.input) }];
  }
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
  response_item: handleResponseItem,
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
    harnessVersion: null,
    toolCalls: [],
  };

  const handler = HANDLERS[entry.type];
  return handler ? handler(base, entry) : base;
}

// opts.progress is mutated with {lineCount}, same contract as
// claude-code/transcript.js, so a caller can compute the format-drift
// canary's driftDetected without a second pass over the file.
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
    if (opts.progress) opts.progress.lineCount = lineCount;

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
