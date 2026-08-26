'use strict';

const fs = require('fs');
const readline = require('readline');

function isNumberOrUndefined(value) {
  return value === undefined || typeof value === 'number';
}

// Returns error strings (empty when valid) rather than throwing.
function validateUsageShape(usage) {
  const errors = [];

  if (typeof usage !== 'object' || usage === null) {
    return ['message.usage must be an object when present'];
  }

  if (
    !isNumberOrUndefined(usage.input_tokens) ||
    !isNumberOrUndefined(usage.output_tokens) ||
    !isNumberOrUndefined(usage.cache_read_input_tokens) ||
    !isNumberOrUndefined(usage.cache_creation_input_tokens)
  ) {
    errors.push('message.usage token fields must be numbers when present');
  }

  return errors;
}

// Checked before any field is trusted, so a parseable-but-malformed line (a
// `usage` string where a number belongs) is skipped rather than coerced into
// a running total.
function validateTranscriptEntry(entry) {
  const errors = [];

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { valid: false, errors: ['entry must be a non-null object'] };
  }

  if (entry.type !== undefined && typeof entry.type !== 'string') {
    errors.push('type must be a string when present');
  }

  if (entry.message !== undefined) {
    if (typeof entry.message !== 'object' || entry.message === null) {
      errors.push('message must be an object when present');
    } else if (entry.message.usage !== undefined) {
      errors.push(...validateUsageShape(entry.message.usage));
    }
  }

  return { valid: errors.length === 0, errors };
}

// Model table and autoCompactWindow/env precedence live in contextWindow.js
// (AGENTS.md: harness-specific resolution logic, not the shared core).
// Re-exported below for existing importers of this module.
const { MODEL_CONTEXT_WINDOWS, contextWindowForModel } = require('./contextWindow');

// Format-drift canary: 'system' entries carry a version field (e.g.
// "2.1.239") — diagnostic context only, never a gate.
function harnessVersionOf(entry) {
  if (entry.type !== 'system' || !entry.version) return null;
  return entry.version;
}

// Maps a validated entry to NormalizedTranscriptEntry.
function normalizeEntry(entry) {
  const { usage, model = null } = entry.message || {};
  return {
    type: entry.type || null,
    timestamp: entry.timestamp || null,
    usage:
      entry.type === 'assistant' && usage
        ? {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || 0,
            cacheCreationTokens: usage.cache_creation_input_tokens || 0,
          }
        : null,
    isCompactionBoundary: entry.type === 'system' && entry.subtype === 'compact_boundary',
    sessionId: entry.sessionId || null,
    cwd: entry.cwd || null,
    gitBranch: entry.gitBranch || null,
    harnessVersion: harnessVersionOf(entry),
    // First-wins in the core reducer, so a mid-session /model switch keeps the
    // first model's window — same as Codex's per-turn model_context_window.
    detectedContextWindowTokens: contextWindowForModel(model),
  };
}

// Yields NormalizedTranscriptEntry objects. `opts.maxLines` replays a session
// as it looked partway through, for backtests. `opts.startLine` skips lines a
// caller already folded into a cached accumulator, without parsing them.
// `opts.progress` is mutated with `{lineCount}` so that caller can persist the
// count alongside its cache.
async function* streamNormalizedEntries(sessionFilePath, opts = {}) {
  const maxLines = opts.maxLines || Infinity;
  const startLine = opts.startLine || 0;
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
    if (lineCount <= startLine) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // tolerate partial/corrupt trailing line from an in-progress write
    }

    if (!validateTranscriptEntry(entry).valid) {
      continue;
    }

    yield normalizeEntry(entry);
  }
}

module.exports = {
  validateTranscriptEntry,
  normalizeEntry,
  streamNormalizedEntries,
  contextWindowForModel,
  MODEL_CONTEXT_WINDOWS,
};
