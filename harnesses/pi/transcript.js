'use strict';

const fs = require('fs');
const readline = require('readline');

// Maps a raw Pi session entry to NormalizedTranscriptEntry. Shapes confirmed
// against pi-coding-agent's session-manager.d.ts and real session files:
// usage is `{input, output, cacheRead, cacheWrite}`, and compaction is its own
// entry type rather than a field on a message.
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

// I/O only: header entry, entries by id, insertion order, and the last id
// seen (the current leaf). No branch-walking or normalization.
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

// Walks parentId from the leaf to the root, chronologically. Sibling branches
// (from a rewind/fork) never produced the current state, so they're excluded.
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

// Pi sessions are trees, not flat logs, so this yields only the active
// branch — the chain from the current leaf back to the root.
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
