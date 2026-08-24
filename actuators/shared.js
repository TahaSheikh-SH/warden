'use strict';

// Thin re-export barrel over the actuator kernel's three real modules:
// escalationPolicy.js (decisions), notify.js (I/O), messages.js (templates).
// Kept for one release cycle so call sites don't all need to change import
// paths in this same commit; a follow-up commit updates the 5 call sites
// and deletes this file.

const { LOG_DIR, LOG_FILE, appendLogEntry, notifyHuman, maybeNotifyHuman } = require('./notify');
const { nudgeMessageFor } = require('./messages');
const {
  GRACE_TURN_LIMIT,
  getLastNudgedAction,
  countTrailingAction,
  hasEverStopped,
  escalateHandoffToStop,
  shouldNotifyHuman,
} = require('./escalationPolicy');

module.exports = {
  LOG_DIR,
  LOG_FILE,
  GRACE_TURN_LIMIT,
  nudgeMessageFor,
  appendLogEntry,
  getLastNudgedAction,
  countTrailingAction,
  hasEverStopped,
  escalateHandoffToStop,
  shouldNotifyHuman,
  notifyHuman,
  maybeNotifyHuman,
};
