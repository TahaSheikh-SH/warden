'use strict';

const fs = require('fs');
const readline = require('readline');

/**
 * Maps a single raw Pi coding-agent session entry to the harness-agnostic
 * NormalizedTranscriptEntry shape. Confirmed against
 * @earendil-works/pi-coding-agent's session-manager.d.ts and real session
 * files on disk (~/.pi/agent/sessions/**\/*.jsonl): the header line is
 * `{type: "session", id, timestamp, cwd}` (no parentId); turn entries are
 * `{type: "message", id, parentId, timestamp, message: {role, usage}}`,
 * where usage is `{input, output, cacheRead, cacheWrite}`; compaction is
 * its own entry type, `{type: "compaction", id, parentId, timestamp,
 * summary, firstKeptEntryId, tokensBefore}` — not a field on a message.
 */
function normalizeEntry(entry) {
  const isMessage = entry.type === 'message';
  const message = isMessage ? entry.message : null;
  const isAssistant = isMessage && message && message.role === 'assistant';
  const isUser = isMessage && message && message.role === 'user';
  const usage = isAssistant ? message.usage : null;

  return {
    type: isAssistant ? 'assistant' : isUser ? 'user' : null,
    timestamp: entry.timestamp || null,
    usage: usage
      ? {
          inputTokens: usage.input || 0,
          outputTokens: usage.output || 0,
          cacheReadTokens: usage.cacheRead || 0,
          cacheCreationTokens: usage.cacheWrite || 0,
        }
      : null,
    isCompactionBoundary: entry.type === 'compaction',
    sessionId: null,
    cwd: null,
    gitBranch: null,
  };
}

/**
 * Reads a Pi session .jsonl into its raw parts: the `session` header entry
 * (if present), a byId map of every entry keyed by id, the insertion order
 * of those ids, and the id of the last entry seen (the current leaf). I/O
 * only — no branch-walking or normalization.
 */
async function readSessionEntries(sessionFilePath) {
  const stream = readline.createInterface({
    input: fs.createReadStream(sessionFilePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let header = null;
  const byId = new Map();
  const order = [];
  let leafId = null;

  for await (const line of stream) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    if (entry.type === 'session') {
      header = entry;
      continue;
    }

    if (!entry.id) continue;
    byId.set(entry.id, entry);
    order.push(entry.id);
    leafId = entry.id; // last entry seen is the current leaf
  }

  return { header, byId, order, leafId };
}

/**
 * Walks parentId back from `leafId` to the root and returns the resulting
 * chain of ids in chronological order. Sibling branches (e.g. from a
 * rewind/fork) are excluded, since they were never part of the turn
 * sequence that produced the session's current state. Pure — no I/O.
 */
function findActiveChain(byId, order, leafId) {
  const activeIds = new Set();
  let cursor = leafId;
  while (cursor) {
    activeIds.add(cursor);
    const entry = byId.get(cursor);
    cursor = entry ? entry.parentId : null;
  }

  return order.filter((id) => activeIds.has(id));
}

/**
 * Reads a Pi session .jsonl (tree-structured: each entry has `id` and
 * `parentId`, branching rather than flat) and yields
 * NormalizedTranscriptEntry objects for only the active branch — walking
 * parentId back from the last entry in the file (the current leaf) to the
 * root, then replaying that chain in chronological order.
 */
async function* streamNormalizedEntries(sessionFilePath) {
  const { header, byId, order, leafId } = await readSessionEntries(sessionFilePath);
  const activeChain = findActiveChain(byId, order, leafId);

  const sessionId = (header && header.id) || null;
  const cwd = (header && header.cwd) || null;

  let first = true;
  for (const id of activeChain) {
    const normalized = normalizeEntry(byId.get(id));
    if (first) {
      normalized.sessionId = sessionId;
      normalized.cwd = cwd;
      first = false;
    }
    yield normalized;
  }
}

module.exports = { normalizeEntry, readSessionEntries, findActiveChain, streamNormalizedEntries };
