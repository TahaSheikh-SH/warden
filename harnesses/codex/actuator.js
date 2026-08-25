#!/usr/bin/env node
'use strict';

// Codex CLI UserPromptSubmit hook (learn.chatgpt.com/docs/hooks). stdin
// JSON: session_id, transcript_path (nullable), cwd, hook_event_name,
// model, permission_mode, turn_id, prompt. Response JSON on stdout:
// {continue, stopReason, systemMessage, hookSpecificOutput:
// {hookEventName, additionalContext}}. Advisory except STOP, which
// hard-blocks (continue:false) — see respondFor below.

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

// Same advisory stance as native.js's respondFor for
// COMPACT/CHECKPOINT/HANDOFF; STOP uses this harness's hard-stop lever
// (continue:false/stopReason).
function respondFor(action, reasons, state) {
  const message = nudgeMessageFor(action, reasons, state);
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
    // systemMessage/additionalContext don't reliably render in the CLI
    // (anthropics/claude-code#50542, #9090, #40380) — stderr is the only
    // channel confirmed visible, so mirror the nudge there too.
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
      : respondFor(effectiveDecision.action, effectiveDecision.reasons, state);
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
