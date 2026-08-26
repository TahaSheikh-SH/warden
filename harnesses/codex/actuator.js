#!/usr/bin/env node
'use strict';

// Codex CLI UserPromptSubmit hook (learn.chatgpt.com/docs/hooks): hook input
// on stdin, response JSON on stdout. Advisory except STOP, which hard-blocks
// with continue:false.

const fs = require('fs');
const {
  reduceTranscriptEntries,
  isContextUsageTrustworthy,
  isFormatDriftDetected,
} = require('../../core/resourceStateCore');
const { streamNormalizedEntries } = require('./transcript');
const { decide, ACTIONS } = require('../../decide');
const { nudgeMessageFor, driftWarningFor } = require('../../actuators/messages');
const { logDecision } = require('../../actuators/logStore');
const {
  getLastNudgedAction,
  escalateHandoffToStop,
  shouldNotifyHuman,
} = require('../../actuators/escalationPolicy');
const { maybeNotifyHuman } = require('../../actuators/notify');
const { readStdin } = require('../../actuators/hookStdin');

// Mirrors actuators/native.js's logDecisionAndNotify.
function logDecisionAndNotify(
  effectiveDecision,
  state,
  sessionFilePath,
  sessionKey,
  notifyOpts = {},
  logFilePath,
) {
  logDecision({
    harness: 'codex',
    decision: effectiveDecision,
    state,
    sessionKey: sessionFilePath,
    logFilePath,
  });
  maybeNotifyHuman(effectiveDecision, sessionKey, logFilePath, notifyOpts);
}

function computeEffectiveDecision(decision, sessionFilePath, logFilePath) {
  return escalateHandoffToStop(decision, sessionFilePath, logFilePath);
}

// Advisory for COMPACT/CHECKPOINT/HANDOFF; STOP uses this harness's hard-stop
// lever instead. driftDetected mirrors native.js's respondFor: CONTINUE has
// no nudge text at all, which is exactly the case a renamed usage field
// silently falls into.
function respondFor(action, reasons, driftDetected) {
  const message = nudgeMessageFor(action, reasons) || (driftDetected ? driftWarningFor() : null);
  if (!message) return null;

  if (action === ACTIONS.STOP) {
    return { continue: false, stopReason: message };
  }

  return {
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: message,
    },
    // additionalContext reaches the model but isn't guaranteed to reach the
    // human, so the nudge is mirrored to stderr.
    stderr: message,
  };
}

async function evaluateCodexSession(sessionFilePath, { contextWindowTokens, maxLines } = {}) {
  const progress = { lineCount: 0 };
  const entries = streamNormalizedEntries(sessionFilePath, { maxLines, progress });
  const reduced = await reduceTranscriptEntries(entries, { contextWindowTokens });
  const driftDetected = isFormatDriftDetected({
    lineCount: progress.lineCount,
    assistantUsageCount: reduced.assistantUsageCount,
  });
  const state = { ...reduced, sessionFilePath, driftDetected };
  // Unknown or too-small window — refuse to act, same as native.js/cli.js.
  if (!isContextUsageTrustworthy(state)) {
    return { state, decision: null };
  }
  return { state, decision: decide(state) };
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const sessionFilePath = input.transcript_path;
  if (!sessionFilePath || !fs.existsSync(sessionFilePath)) {
    process.exit(0);
  }

  const { state, decision } = await evaluateCodexSession(sessionFilePath, {
    contextWindowTokens: process.env.WARDEN_CONTEXT_WINDOW
      ? Number(process.env.WARDEN_CONTEXT_WINDOW)
      : undefined,
  });

  if (!decision) {
    process.exit(0);
  }

  const sessionKey = sessionFilePath;
  const alreadyNudgedThisAction = getLastNudgedAction(sessionKey) === decision.action;
  const effectiveDecision = computeEffectiveDecision(decision, sessionKey);

  // Checked BEFORE logDecisionAndNotify appends this turn's entry, same
  // ordering alreadyNudgedThisAction relies on above.
  const notifyingHumanThisTurn = shouldNotifyHuman(effectiveDecision.action, sessionKey);

  logDecisionAndNotify(effectiveDecision, state, sessionFilePath, sessionKey);

  const output =
    effectiveDecision.action !== ACTIONS.CONTINUE &&
    effectiveDecision.action !== ACTIONS.STOP &&
    alreadyNudgedThisAction &&
    !notifyingHumanThisTurn
      ? null
      : respondFor(effectiveDecision.action, effectiveDecision.reasons, state.driftDetected);
  if (output) {
    const { stderr, ...stdoutPayload } = output;
    process.stdout.write(JSON.stringify(stdoutPayload));
    if (stderr) process.stderr.write(stderr);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`warden codex adapter error: ${error.message}`);
    process.exit(0);
  });
}

module.exports = {
  evaluateCodexSession,
  respondFor,
  computeEffectiveDecision,
  logDecisionAndNotify,
};
