'use strict';

// Advisory nudge text per decide() action. Each adapter still owns its own
// wrapping (Claude Code hook JSON vs. a plain notify string).

const { ACTIONS } = require('../decide');
const { priceFor } = require('../lib/pricing');

// Median latency for compaction based on measurement over 79 real compactions
// across 84 local transcripts (2026-08-22 analysis).
const COMPACTION_LATENCY_SECONDS = 153;

const MESSAGE_BY_ACTION = {
  [ACTIONS.COMPACT]: (reasonText, costClause) =>
    `[warden] Context usage is high (${reasonText}). Run /compact before continuing with this task.` +
    (costClause ? ` ${costClause}` : ''),
  [ACTIONS.CHECKPOINT]: (reasonText) =>
    `[warden] Checkpoint recommended (${reasonText}). Write a durable note covering: current task and status, files modified, key decisions and why, any failed approaches (don't retry them), and the next action.`,
  [ACTIONS.HANDOFF]: (reasonText) =>
    `[warden] Session should be handed off, not continued (${reasonText}). Start a fresh session with a handoff note covering: current task and status, files modified, key decisions and why, failed approaches (don't retry them), open blockers, and the next action.`,
  [ACTIONS.STOP]: (reasonText) =>
    `[warden] Session should stop (${reasonText}). Wrap up and start fresh rather than continuing.`,
};

// Estimate the cache-write cost of compacting. Compaction rewrites the
// prompt prefix, invalidating the cache — the next turn re-pays a cache
// write on context it would otherwise have read cheaply, so the delta is
// (cacheWrite - cacheRead) per token. Depends only on tokens in context;
// the window size doesn't enter it. Null when the token count is unknown.
function estimateCompactionCostDollars(state) {
  const contextTokens = state && state.contextUsedTokens;
  if (!contextTokens || contextTokens <= 0) return null;
  // Unknown model falls back to the default row rather than skipping the
  // clause — an order-of-magnitude estimate still beats no signal.
  const rates = priceFor(state.model);
  return (rates.cacheWrite - rates.cacheRead) * contextTokens;
}

// Format cache-write cost and latency estimate as a human-readable clause
// for the COMPACT nudge. Returns null if cost can't be estimated.
function compactionCostClause(state) {
  const costDollars = estimateCompactionCostDollars(state);
  if (costDollars === null) return null;
  const costText = costDollars < 0.01 ? '<$0.01' : `$${costDollars.toFixed(2)}`;
  return `(Compaction costs ~${costText} in cache writes + ~${COMPACTION_LATENCY_SECONDS}s latency.)`;
}

// null for CONTINUE and any unrecognized action — every adapter's
// advisory-only stance in one place.
function nudgeMessageFor(action, reasons, state) {
  const buildMessage = MESSAGE_BY_ACTION[action];
  if (!buildMessage) return null;

  if (action === ACTIONS.COMPACT) {
    const costClause = compactionCostClause(state);
    return buildMessage(reasons.join('; '), costClause);
  }

  return buildMessage(reasons.join('; '));
}

module.exports = {
  MESSAGE_BY_ACTION,
  nudgeMessageFor,
};
