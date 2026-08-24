'use strict';

/**
 * Maps a single OpenCode plugin event to the harness-agnostic
 * NormalizedTranscriptEntry shape, or null if the event carries no
 * reducer-relevant signal. OpenCode is not a spawned-hook-script harness —
 * there is no on-disk transcript to stream; the plugin (harnesses/opencode/
 * plugin.js) receives these events live, in-process, and feeds them here
 * one at a time. Field names confirmed against opencode's generated SDK
 * types (packages/sdk/js/src/gen/types.gen.ts): an AssistantMessage's
 * token usage lives at `tokens: {input, output, reasoning, cache: {read,
 * write}}`. Compaction is its own event, `session.compacted` (via
 * `EventSessionCompacted`), not a transcript marker.
 */
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
    // providerID/modelID identify which real context window applies (see
    // resolveContextWindowTokens in plugin.js) — not part of the shared
    // NormalizedTranscriptEntry shape since resolving it needs the
    // OpenCode client (I/O), which this pure mapping function doesn't have.
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

/**
 * Maps a single OpenCode plugin event to the harness-agnostic
 * NormalizedTranscriptEntry shape, or null if the event carries no
 * reducer-relevant signal. OpenCode is not a spawned-hook-script harness —
 * there is no on-disk transcript to stream; the plugin (harnesses/opencode/
 * plugin.js) receives these events live, in-process, and feeds them here
 * one at a time. Field names confirmed against opencode's generated SDK
 * types (packages/sdk/js/src/gen/types.gen.ts): an AssistantMessage's
 * token usage lives at `tokens: {input, output, reasoning, cache: {read,
 * write}}`. Compaction is its own event, `session.compacted` (via
 * `EventSessionCompacted`), not a transcript marker.
 */
function normalizeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const handler = HANDLERS[event.type];
  return handler ? handler(event) : null;
}

module.exports = { normalizeEvent };
