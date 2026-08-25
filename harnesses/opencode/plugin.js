'use strict';

// OpenCode plugin — in-process, not a spawned hook script like Claude
// Code/Codex. Factory signature: `(input: PluginInput, options?) =>
// Promise<Hooks>`, input = {client, project, directory, worktree, $,
// serverUrl}. No on-disk transcript, so this keeps an in-memory
// NormalizedTranscriptEntry accumulator per session, fed via the `event`
// hook, re-reduced through the shared core each time.
//
// Nudge path: `experimental.chat.system.transform`'s `output.system:
// string[]` appends to the next turn's system prompt — this harness's
// equivalent of Claude Code's hookSpecificOutput.additionalContext.

const {
  reduceTranscriptEntries,
  isContextUsageTrustworthy,
} = require('../../core/resourceStateCore');
const { normalizeEvent } = require('./transcript');
const { decide, ACTIONS } = require('../../decide');
const {
  nudgeMessageFor,
  appendLogEntry,
  escalateHandoffToStop,
  maybeNotifyHuman,
} = require('../../actuators/shared');

function logDecision(decision, state, sessionKey, logFilePath) {
  appendLogEntry(
    {
      timestamp: new Date().toISOString(),
      harness: 'opencode',
      sessionKey,
      action: decision.action,
      reasons: decision.reasons,
      contextUsedPct: state.contextUsedPct,
      compactionCount: state.compactionCount,
      sessionAgeMinutes: state.sessionAgeMinutes,
    },
    logFilePath,
  );
}

// Real per-model window via client.config.providers() -> { providers:
// [{id, models: {[modelID]: {limit: {context, output}}}}] }. Cached per
// providerID/modelID pair since it won't change mid-session.
function createContextWindowResolver(client) {
  const cache = new Map();

  return async function resolveContextWindowTokens(providerID, modelID) {
    if (!client || !providerID || !modelID) return null;
    const key = `${providerID}/${modelID}`;
    if (cache.has(key)) return cache.get(key);

    let contextWindowTokens = null;
    try {
      const result = await client.config.providers();
      const providers = (result && result.data && result.data.providers) || [];
      const provider = providers.find((candidate) => candidate.id === providerID);
      const model = provider && provider.models && provider.models[modelID];
      contextWindowTokens = (model && model.limit && model.limit.context) || null;
    } catch {
      // client unavailable (e.g. in tests) — window stays unknown
    }

    cache.set(key, contextWindowTokens);
    return contextWindowTokens;
  };
}

// Exported separately from WardenPlugin so it's testable without a real
// OpenCode client/project context.
function createSessionEvaluator({ contextWindowTokens, client, logFilePath } = {}) {
  const entries = [];
  const resolveContextWindowTokens = createContextWindowResolver(client);
  // Sticky across events — a compaction event carries no providerID/modelID,
  // so this holds the last resolved value instead of losing the window
  // whenever the latest event isn't a message.
  let lastKnownContextWindowTokens = null;

  return {
    logFilePath,
    async ingest(event) {
      const normalized = normalizeEvent(event);
      if (!normalized) return null;
      entries.push(normalized);

      if (normalized.providerID && normalized.modelID) {
        const resolved = await resolveContextWindowTokens(
          normalized.providerID,
          normalized.modelID,
        );
        if (resolved) lastKnownContextWindowTokens = resolved;
      }

      const state = await reduceTranscriptEntries(entries, {
        contextWindowTokens: contextWindowTokens || lastKnownContextWindowTokens,
      });
      // Unknown or too-small window — refuse to act, same as native.js/cli.js.
      if (!isContextUsageTrustworthy(state)) return { state, decision: null };
      const decision = decide(state);
      return { state, decision };
    },
  };
}

const respondFor = nudgeMessageFor;

// Best-effort toast so the nudge is visible immediately, not just via
// system-prompt injection. Fails open — older builds may lack tui.showToast.
async function showToastForAction(client, action, message) {
  if (!client || !client.tui || typeof client.tui.showToast !== 'function') return;
  try {
    await client.tui.showToast({
      body: { message, variant: action === ACTIONS.STOP ? 'error' : 'warning' },
    });
  } catch {
    // convenience layer; system-prompt injection still delivers the nudge
  }
}

async function WardenPlugin(input, { logFilePath, notifyOpts = {}, contextWindowTokens } = {}) {
  const client = input && input.client;
  const evaluator = createSessionEvaluator({ client, logFilePath, contextWindowTokens });
  // Handed off between the `event` and `experimental.chat.system.transform`
  // hooks, which fire separately; cleared once delivered.
  let pendingMessage = null;
  // Fallback for normalizeEvent's null sessionId, so such sessions don't
  // collapse into one shared escalation/dedup bucket.
  const fallbackSessionKey = `opencode-${process.pid}-${Date.now()}`;
  // message.updated fires repeatedly while one assistant message streams
  // (same info.id each time) — dedup so GRACE_TURN_LIMIT can't exhaust
  // within a single turn.
  let lastProcessedMessageId = null;
  // Unlike pendingMessage, never cleared by system-prompt-transform —
  // tool.execute.before needs to keep blocking every tool call for as long
  // as the session stays STOP'd.
  let stopBlockMessage = null;

  return {
    event: async ({ event }) => {
      const result = await evaluator.ingest(event);
      if (!result || !result.decision) return;
      if (result.decision.action === ACTIONS.CONTINUE) return;

      const info =
        event && event.type === 'message.updated' && event.properties && event.properties.info;
      const messageId = info && info.id;
      if (messageId && messageId === lastProcessedMessageId) return;
      if (messageId) lastProcessedMessageId = messageId;

      const sessionKey = result.state.sessionId || fallbackSessionKey;
      const effectiveDecision = escalateHandoffToStop(
        result.decision,
        sessionKey,
        evaluator.logFilePath,
      );

      logDecision(effectiveDecision, result.state, sessionKey, evaluator.logFilePath);
      maybeNotifyHuman(effectiveDecision, sessionKey, evaluator.logFilePath, notifyOpts);
      // No turn-abort hook exists in the OpenCode SDK (anomalyco/opencode#16626,
      // unresolved) — but tool.execute.before can throw to reject a tool
      // call, so STOP uses that instead of relying on the toast alone.
      pendingMessage = respondFor(
        effectiveDecision.action,
        effectiveDecision.reasons,
        result.state,
      );
      stopBlockMessage = effectiveDecision.action === ACTIONS.STOP ? pendingMessage : null;
      await showToastForAction(client, effectiveDecision.action, pendingMessage);
    },
    'experimental.chat.system.transform': async (_input, output) => {
      if (!pendingMessage) return;
      output.system.push(pendingMessage);
      pendingMessage = null;
    },
    'tool.execute.before': async () => {
      if (stopBlockMessage) throw new Error(stopBlockMessage);
    },
  };
}

module.exports = { WardenPlugin, createSessionEvaluator, respondFor, showToastForAction };
