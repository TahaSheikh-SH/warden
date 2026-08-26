'use strict';

// Advisory nudge text per decide() action. Each adapter owns its own wrapping
// (hook JSON vs. a plain notify string).

const { ACTIONS } = require('../decide');

const MESSAGE_BY_ACTION = {
  [ACTIONS.COMPACT]: (reasonText) =>
    `[warden] Context usage is high (${reasonText}). Run /compact before continuing with this task.`,
  [ACTIONS.CHECKPOINT]: (reasonText) =>
    `[warden] Checkpoint recommended (${reasonText}). Write a durable note covering: current task and status, files modified, key decisions and why, any failed approaches (don't retry them), and the next action.`,
  [ACTIONS.HANDOFF]: (reasonText) =>
    `[warden] Session should be handed off, not continued (${reasonText}). Start a fresh session with a handoff note covering: current task and status, files modified, key decisions and why, failed approaches (don't retry them), open blockers, and the next action.`,
  [ACTIONS.STOP]: (reasonText) =>
    `[warden] Session should stop (${reasonText}). Wrap up and start fresh rather than continuing.`,
};

// null for CONTINUE and any unrecognized action.
function nudgeMessageFor(action, reasons) {
  const buildMessage = MESSAGE_BY_ACTION[action];
  return buildMessage ? buildMessage(reasons.join('; ')) : null;
}

module.exports = {
  MESSAGE_BY_ACTION,
  nudgeMessageFor,
};
