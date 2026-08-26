'use strict';

// Maps OpenCode plugin events to NormalizedTranscriptEntry. There is no
// on-disk transcript: plugin.js feeds these in live, one at a time. Field
// names are from opencode's generated SDK types — token usage is
// `tokens: {input, output, reasoning, cache: {read, write}}`, and compaction
// is its own `session.compacted` event rather than a transcript marker.

function usageFromTokens(tokens) {
  if (!tokens) return null;
  return {
    inputTokens: tokens.input || 0,
    outputTokens: tokens.output || 0,
    cacheReadTokens: (tokens.cache && tokens.cache.read) || 0,
    cacheCreationTokens: (tokens.cache && tokens.cache.write) || 0,
  };
}

function normalizeMessageUpdated(event) {
  const info = event.properties && event.properties.info;
  if (!info) return null;

  const isAssistant = info.role === 'assistant';

  return {
    type: isAssistant ? 'assistant' : info.role === 'user' ? 'user' : null,
    timestamp: info.time && info.time.created ? new Date(info.time.created).toISOString() : null,
    usage: isAssistant ? usageFromTokens(info.tokens) : null,
    isCompactionBoundary: false,
    sessionId: info.sessionID || null,
    cwd: null,
    gitBranch: null,
    // Which real context window applies. Not part of the shared entry shape:
    // resolving it needs the OpenCode client, which this pure mapping lacks.
    providerID: isAssistant ? info.providerID || null : null,
    modelID: isAssistant ? info.modelID || null : null,
  };
}

function normalizeSessionCompacted(event) {
  return {
    type: null,
    timestamp: null,
    usage: null,
    isCompactionBoundary: true,
    sessionId: (event.properties && event.properties.sessionID) || null,
    cwd: null,
    gitBranch: null,
  };
}

const HANDLERS = {
  'message.updated': normalizeMessageUpdated,
  'session.compacted': normalizeSessionCompacted,
};

function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const handler = HANDLERS[event.type];
  return handler ? handler(event) : null;
}

module.exports = { normalizeEvent };
