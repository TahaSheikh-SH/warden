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
const { nudgeMessageFor } = require('../../actuators/messages');
const { logDecision } = require('../../actuators/logStore');
const { getLastNudgedAction, escalateHandoffToStop } = require('../../actuators/escalationPolicy');
const { maybeNotifyHuman } = require('../../actuators/notify');

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

// One OpenCode server process hosts every concurrent chat session, and this
// plugin is instantiated once for the whole server (PluginInput carries no
// sessionID) — so all per-session state here must be keyed by sessionKey,
// never shared across sessions the way a single-session harness could get
// away with.
function createSessionEvaluator({ contextWindowTokens, client, logFilePath } = {}) {
  const entriesBySession = new Map();
  const resolveContextWindowTokens = createContextWindowResolver(client);
  // Sticky per session: a compaction event carries no providerID/modelID, and
  // the window must not be lost whenever the latest event isn't a message.
  const lastKnownContextWindowBySession = new Map();

  return {
    logFilePath,
    async ingest(event, fallbackSessionKey) {
      const normalized = normalizeEvent(event);
      if (!normalized) return null;

      const sessionKey = normalized.sessionId || fallbackSessionKey;
      if (!entriesBySession.has(sessionKey)) entriesBySession.set(sessionKey, []);
      const entries = entriesBySession.get(sessionKey);
      entries.push(normalized);

      if (normalized.providerID && normalized.modelID) {
        const resolved = await resolveContextWindowTokens(
          normalized.providerID,
          normalized.modelID,
        );
        if (resolved) lastKnownContextWindowBySession.set(sessionKey, resolved);
      }

      const state = await reduceTranscriptEntries(entries, {
        contextWindowTokens: contextWindowTokens || lastKnownContextWindowBySession.get(sessionKey),
      });
      // Unknown or too-small window — refuse to act, same as native.js/cli.js.
      if (!isContextUsageTrustworthy(state)) return { state, decision: null, sessionKey };
      const decision = decide(state);
      return { state, decision, sessionKey };
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
  // One plugin instance serves every session on this OpenCode server, so all
  // per-session state below is keyed by sessionKey — never a bare scalar —
  // or one session's nudge/toast/block leaks into every other session's turn.
  // Handed between the `event` and transform hooks; cleared once delivered.
  const pendingMessageBySession = new Map();
  // Keeps sessions with no id out of one shared escalation/dedup bucket.
  const fallbackSessionKey = `opencode-${process.pid}-${Date.now()}`;
  // Dedup on streamingMessageId so GRACE_TURN_LIMIT can't exhaust within a
  // single turn.
  const lastProcessedMessageIdBySession = new Map();
  // Never cleared by the transform hook, unlike pendingMessage: tool calls
  // must keep being blocked for as long as that session stays STOP'd.
  const stopBlockMessageBySession = new Map();

  return {
    event: async ({ event }) => {
      const result = await evaluator.ingest(event, fallbackSessionKey);
      if (!result || !result.decision) return;
      if (result.decision.action === ACTIONS.CONTINUE) return;

      const { sessionKey } = result;
      const messageId = streamingMessageId(event);
      if (messageId && messageId === lastProcessedMessageIdBySession.get(sessionKey)) return;
      if (messageId) lastProcessedMessageIdBySession.set(sessionKey, messageId);

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

      logDecision({
        harness: 'opencode',
        decision: effectiveDecision,
        state: result.state,
        sessionKey,
        logFilePath: evaluator.logFilePath,
      });
      maybeNotifyHuman(effectiveDecision, sessionKey, evaluator.logFilePath, notifyOpts);
      // No turn-abort hook exists in the OpenCode SDK
      // (anomalyco/opencode#16626), so STOP blocks through tool.execute.before
      // rather than relying on the toast alone.
      const message = respondFor(effectiveDecision.action, effectiveDecision.reasons);
      if (effectiveDecision.action === ACTIONS.STOP) {
        stopBlockMessageBySession.set(sessionKey, message);
      } else {
        stopBlockMessageBySession.delete(sessionKey);
      }

      if ((effectiveDecision.action !== ACTIONS.STOP && alreadyNudgedThisAction) || !message)
        return;

      pendingMessageBySession.set(sessionKey, message);
      await showToastForAction(client, effectiveDecision.action, message);
    },
    'experimental.chat.system.transform': async (transformInput, output) => {
      const sessionKey = (transformInput && transformInput.sessionID) || fallbackSessionKey;
      const pendingMessage = pendingMessageBySession.get(sessionKey);
      if (!pendingMessage) return;
      output.system.push(pendingMessage);
      pendingMessageBySession.delete(sessionKey);
    },
    'tool.execute.before': async (toolInput) => {
      const sessionKey = (toolInput && toolInput.sessionID) || fallbackSessionKey;
      const stopBlockMessage = stopBlockMessageBySession.get(sessionKey);
      if (stopBlockMessage) throw new Error(stopBlockMessage);
    },
  };
}

module.exports = { WardenPlugin, createSessionEvaluator, respondFor, showToastForAction };
