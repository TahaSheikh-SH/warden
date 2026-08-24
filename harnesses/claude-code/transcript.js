'use strict';

const fs = require('fs');
const readline = require('readline');

function isNumberOrUndefined(value) {
  return value === undefined || typeof value === 'number';
}

/**
 * Validates a `message.usage` block's token fields. Pure. Returns a list of
 * error strings (empty when valid) rather than throwing.
 */
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

/**
 * Validates the shape of a single raw Claude Code transcript line before
 * its fields are trusted for normalization. Pure, no I/O — returns
 * {valid, errors} rather than throwing, so a malformed-but-parseable line
 * (e.g. a `usage` block with a string field where a number is expected)
 * gets skipped explicitly instead of silently corrupting a running total
 * via implicit coercion.
 */
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

/**
 * Maps a single raw (already-validated) Claude Code transcript entry to the
 * harness-agnostic NormalizedTranscriptEntry shape core/resourceStateCore.js
 * consumes. Returns null for entries that carry no reducer-relevant signal
 * (still fine to yield through — the core reducer treats null as a no-op).
 */
function normalizeEntry(entry) {
  const usage = entry.message && entry.message.usage;
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
  };
}

/**
 * Streams a Claude Code session .jsonl and yields NormalizedTranscriptEntry
 * objects. `opts.maxLines` lets a backtest replay a session as it looked
 * partway through, instead of only at its final state. `opts.startLine`
 * skips the first N non-blank lines without parsing them — used by callers
 * that already folded those lines into a cached accumulator on a prior
 * call, so re-parsing/re-reducing the whole transcript every turn doesn't
 * become O(n^2) over a session. `opts.progress`, if given, is mutated with
 * `{ lineCount }` as lines are counted, so the caller can read the final
 * total line count after iteration to persist alongside its cache.
 */
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

module.exports = { validateTranscriptEntry, normalizeEntry, streamNormalizedEntries };
