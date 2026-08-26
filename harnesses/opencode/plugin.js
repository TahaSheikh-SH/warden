'use strict';

// OpenCode plugin — in-process, not a spawned hook script. No on-disk
// transcript, so entries accumulate in memory and re-reduce through the shared
// core on each `event`. The nudge reaches the model through
// `experimental.chat.system.transform`, this harness's equivalent of Claude
// Code's additionalContext.

const {
  reduceTranscriptEntries,
  isContextUsageTrustworthy,
} = require('../../core/resourceStateCore');
const { normalizeEvent } = require('./transcript');
const { decide, ACTIONS } = require('../../decide');
const {
  nudgeMessageFor,
  appendLogEntry,
  getLastNudgedAction,
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

// Real per-model window via client.config.providers(), cached per
// providerID/modelID pair since it can't change mid-session.
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

// Exported separately so it's testable without a real OpenCode client.
function createSessionEvaluator({ contextWindowTokens, client, logFilePath } = {}) {
  const entries = [];
  const resolveContextWindowTokens = createContextWindowResolver(client);
  // Sticky: a compaction event carries no providerID/modelID, and the window
  // must not be lost whenever the latest event isn't a message.
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

// Best-effort, so the nudge is visible now and not only to the next turn's
// model. Fails open — older builds may lack tui.showToast.
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

// message.updated fires repeatedly while one message streams, same id each
// time. Null for any other event shape.
function streamingMessageId(event) {
  const info =
    event && event.type === 'message.updated' && event.properties && event.properties.info;
  return (info && info.id) || null;
}

async function WardenPlugin(input, { logFilePath, notifyOpts = {}, contextWindowTokens } = {}) {
  const client = input && input.client;
  const evaluator = createSessionEvaluator({ client, logFilePath, contextWindowTokens });
  // Handed between the `event` and transform hooks; cleared once delivered.
  let pendingMessage = null;
  // Keeps sessions with no id out of one shared escalation/dedup bucket.
  const fallbackSessionKey = `opencode-${process.pid}-${Date.now()}`;
  // Dedup on streamingMessageId so GRACE_TURN_LIMIT can't exhaust within a
  // single turn.
  let lastProcessedMessageId = null;
  // Never cleared by the transform hook, unlike pendingMessage: tool calls
  // must keep being blocked for as long as the session stays STOP'd.
  let stopBlockMessage = null;

  return {
    event: async ({ event }) => {
      const result = await evaluator.ingest(event);
      if (!result || !result.decision) return;
      if (result.decision.action === ACTIONS.CONTINUE) return;

      const messageId = streamingMessageId(event);
      if (messageId && messageId === lastProcessedMessageId) return;
      if (messageId) lastProcessedMessageId = messageId;

      const sessionKey = result.state.sessionId || fallbackSessionKey;
      // decide() is stateless, so it re-emits the same action every turn once
      // a floor is crossed — without this the toast repeats for the rest of the
      // session. Read BEFORE logDecision appends this turn's entry, same as
      // native.js and pi's extension.
      const alreadyNudgedThisAction =
        getLastNudgedAction(sessionKey, evaluator.logFilePath) === result.decision.action;

      const effectiveDecision = escalateHandoffToStop(
        result.decision,
        sessionKey,
        evaluator.logFilePath,
      );

      logDecision(effectiveDecision, result.state, sessionKey, evaluator.logFilePath);
      maybeNotifyHuman(effectiveDecision, sessionKey, evaluator.logFilePath, notifyOpts);
      // No turn-abort hook exists in the OpenCode SDK
      // (anomalyco/opencode#16626), so STOP blocks through tool.execute.before
      // rather than relying on the toast alone.
      const message = respondFor(effectiveDecision.action, effectiveDecision.reasons);
      stopBlockMessage = effectiveDecision.action === ACTIONS.STOP ? message : null;

      if ((effectiveDecision.action !== ACTIONS.STOP && alreadyNudgedThisAction) || !message)
        return;

      pendingMessage = message;
      await showToastForAction(client, effectiveDecision.action, message);
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
