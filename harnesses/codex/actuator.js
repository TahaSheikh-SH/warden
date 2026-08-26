#!/usr/bin/env node
'use strict';

// Codex CLI UserPromptSubmit hook (learn.chatgpt.com/docs/hooks): hook input
// on stdin, response JSON on stdout. Advisory except STOP, which hard-blocks
// with continue:false.

const fs = require('fs');
const {
  reduceTranscriptEntries,
  isContextUsageTrustworthy,
} = require('../../core/resourceStateCore');
const { streamNormalizedEntries } = require('./transcript');
const { decide, ACTIONS } = require('../../decide');
const {
  nudgeMessageFor,
  getLastNudgedAction,
  appendLogEntry,
  escalateHandoffToStop,
  maybeNotifyHuman,
  shouldNotifyHuman,
} = require('../../actuators/shared');

function logDecision(decision, state, sessionFilePath, logFilePath) {
  appendLogEntry(
    {
      timestamp: new Date().toISOString(),
      harness: 'codex',
      sessionKey: sessionFilePath,
      action: decision.action,
      reasons: decision.reasons,
      contextUsedPct: state.contextUsedPct,
      compactionCount: state.compactionCount,
      sessionAgeMinutes: state.sessionAgeMinutes,
    },
    logFilePath,
  );
}

// Mirrors actuators/native.js's logDecisionAndNotify.
function logDecisionAndNotify(
  effectiveDecision,
  state,
  sessionFilePath,
  sessionKey,
  notifyOpts = {},
  logFilePath,
) {
  logDecision(effectiveDecision, state, sessionFilePath, logFilePath);
  maybeNotifyHuman(effectiveDecision, sessionKey, logFilePath, notifyOpts);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function computeEffectiveDecision(decision, sessionFilePath, logFilePath) {
  return escalateHandoffToStop(decision, sessionFilePath, logFilePath);
}

// Advisory for COMPACT/CHECKPOINT/HANDOFF; STOP uses this harness's hard-stop
// lever instead.
function respondFor(action, reasons) {
  const message = nudgeMessageFor(action, reasons);
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
  const entries = streamNormalizedEntries(sessionFilePath, { maxLines });
  const state = {
    ...(await reduceTranscriptEntries(entries, { contextWindowTokens })),
    sessionFilePath,
  };
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
      : respondFor(effectiveDecision.action, effectiveDecision.reasons);
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
