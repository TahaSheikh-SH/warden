#!/usr/bin/env node
'use strict';

// Claude Code UserPromptSubmit hook: runs decide() every turn and acts on
// it directly (same decide.js/buildResourceState as cli.js, no new
// decision logic). Session-lifecycle only — no per-turn model-effort
// throttling, since native hooks can't set effort/thinking-budget.
//
// Register in .claude/settings.json:
//   "hooks": { "UserPromptSubmit": [{ "hooks": [{ "type": "command",
//     "command": "node /path/to/warden/actuators/native.js" }] }] }

const fs = require('fs');
const { evaluateSession } = require('../resourceState');
const { ACTIONS } = require('../decide');
const {
  LOG_FILE,
  getLastNudgedAction,
  escalateHandoffToStop,
  maybeNotifyHuman,
  shouldNotifyHuman,
  nudgeMessageFor,
  appendLogEntry,
} = require('./shared');

// Timeboxed experiment to measure nudge-follow/block-override rates (see
// scripts/rollup.js) — not permanent infra.
function logDecision(decision, state, sessionFilePath, logFilePath) {
  appendLogEntry(
    {
      timestamp: new Date().toISOString(),
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

// Thin wrapper so this file's sessionKey/log-path wiring is testable
// independent of escalateHandoffToStop's own logic.
function computeEffectiveDecision(decision, sessionFilePath, logFilePath) {
  return escalateHandoffToStop(decision, sessionFilePath, logFilePath);
}

// Extracted from main() so it's testable with an injected execFileFn
// without going through a real stdin hook invocation.
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

// COMPACT/CHECKPOINT/HANDOFF are always advisory. STOP hard-blocks (exit 2)
// — it only fires after GRACE_TURN_LIMIT consecutive ignored HANDOFFs, a
// narrower trigger than the old blanket HANDOFF/STOP block reverted after
// ~97% override rate (commit 8787). WARDEN_DISABLE_STOP_BLOCK=1 reverts
// just this path back to advisory.
function respondFor(action, reasons) {
  const message = nudgeMessageFor(action, reasons);
  if (!message) return { exitCode: 0, output: null };

  if (action === ACTIONS.STOP && process.env.WARDEN_DISABLE_STOP_BLOCK !== '1') {
    return { exitCode: 2, output: null, stderr: message };
  }

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
      ? respondFor(effectiveDecision.action, effectiveDecision.reasons)
      : effectiveDecision.action !== ACTIONS.CONTINUE &&
          alreadyNudgedThisAction &&
          !notifyingHumanThisTurn
        ? { exitCode: 0, output: null, stderr: null }
        : respondFor(effectiveDecision.action, effectiveDecision.reasons);

  if (output) {
    process.stdout.write(JSON.stringify(output));
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`warden native adapter error: ${err.message}`);
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
