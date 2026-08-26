#!/usr/bin/env node
'use strict';

// Claude Code UserPromptSubmit hook: runs decide() every turn and acts on it.
// Register in .claude/settings.json (or run `npm run setup`):
//   "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command",
//     "command": "node /path/to/warden/actuators/native.js" }] }] }

const fs = require('fs');
const { evaluateSession } = require('../resourceState');
const { ACTIONS } = require('../decide');
const { LOG_FILE, logDecision } = require('./logStore');
const { nudgeMessageFor, driftWarningFor } = require('./messages');
const {
  getLastNudgedAction,
  escalateHandoffToStop,
  shouldNotifyHuman,
} = require('./escalationPolicy');
const { maybeNotifyHuman } = require('./notify');
const { readStdin } = require('./hookStdin');

// Wrapper so this file's sessionKey/log-path wiring is testable on its own.
function computeEffectiveDecision(decision, sessionFilePath, logFilePath) {
  return escalateHandoffToStop(decision, sessionFilePath, logFilePath);
}

// Separate from main() so a test can inject execFileFn without stdin. Feeds
// the nudge-follow/override rates that scripts/rollup.js reports.
function logDecisionAndNotify(
  effectiveDecision,
  state,
  sessionFilePath,
  sessionKey,
  notifyOpts = {},
  logFilePath,
) {
  logDecision({ decision: effectiveDecision, state, sessionKey: sessionFilePath, logFilePath });
  maybeNotifyHuman(effectiveDecision, sessionKey, logFilePath, notifyOpts);
}

// All actions, including STOP, stay advisory on Claude Code: exit code 2 on
// UserPromptSubmit blocks prompt processing and erases what the user typed
// (Claude Code docs), and the only documented escape is an env var requiring
// a restart. Enforcement is asymmetric by design (AGENTS.md) — Pi/OpenCode
// keep their own in-process blocks at interception points they already own.
// driftDetected covers the case a nudge can't — CONTINUE has no message at
// all, which is exactly what a renamed usage field silently produces
// forever. A real action nudge still wins.
function respondFor(action, reasons, driftDetected) {
  const message = nudgeMessageFor(action, reasons) || (driftDetected ? driftWarningFor() : null);
  if (!message) return { exitCode: 0, output: null };

  return {
    exitCode: 0,
    output: {
      systemMessage: message,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: message,
      },
    },
    // systemMessage/additionalContext don't reliably render in the CLI
    // (anthropics/claude-code#50542, #9090, #40380) — stderr is the only
    // channel confirmed visible, so mirror the nudge there too.
    stderr: message,
  };
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // malformed hook input: don't block the turn over this
  }

  const sessionFilePath = input.transcript_path;
  if (!sessionFilePath || !fs.existsSync(sessionFilePath)) {
    process.exit(0); // no transcript yet (e.g. first turn) — nothing to evaluate
  }

  const { state, decision } = await evaluateSession(sessionFilePath, {
    contextWindowTokens: process.env.WARDEN_CONTEXT_WINDOW
      ? Number(process.env.WARDEN_CONTEXT_WINDOW)
      : undefined,
  });

  if (!decision) {
    process.exit(0); // unknown/untrustworthy window size — refuse to act, same as cli.js
  }

  const sessionKey = sessionFilePath;
  const alreadyNudgedThisAction = getLastNudgedAction(sessionKey) === decision.action;
  const effectiveDecision = computeEffectiveDecision(decision, sessionKey);

  // Must check before logDecisionAndNotify appends this turn's entry —
  // same ordering alreadyNudgedThisAction relies on above.
  const notifyingHumanThisTurn = shouldNotifyHuman(effectiveDecision.action, sessionKey);

  logDecisionAndNotify(effectiveDecision, state, sessionFilePath, sessionKey);

  const { exitCode, output, stderr } =
    effectiveDecision.action === ACTIONS.STOP
      ? respondFor(effectiveDecision.action, effectiveDecision.reasons, state.driftDetected)
      : effectiveDecision.action !== ACTIONS.CONTINUE &&
          alreadyNudgedThisAction &&
          !notifyingHumanThisTurn
        ? { exitCode: 0, output: null, stderr: null }
        : respondFor(effectiveDecision.action, effectiveDecision.reasons, state.driftDetected);

  if (output) {
    process.stdout.write(JSON.stringify(output));
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`warden native adapter error: ${error.message}`);
    process.exit(0); // fail open — a broken adapter must never block real work
  });
}

module.exports = {
  getLastNudgedAction,
  computeEffectiveDecision,
  logDecisionAndNotify,
  respondFor,
  LOG_FILE,
};
