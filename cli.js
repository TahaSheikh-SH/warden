#!/usr/bin/env node
'use strict';

const { evaluateSession } = require('./resourceState');
const { findLatestSessionFile } = require('./observe');

function parseArgs(argv) {
  const flags = { contextWindowTokens: null };
  const positional = [];
  for (let argIndex = 0; argIndex < argv.length; argIndex++) {
    if (argv[argIndex] === '--context-window') {
      const value = Number(argv[++argIndex]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--context-window must be a positive number');
      }
      flags.contextWindowTokens = value;
    } else {
      positional.push(argv[argIndex]);
    }
  }
  return { flags, positional };
}

/**
 * Layer 3 (harness-specific, advisory-only for v0): prints a recommendation.
 * No auto-kill, no auto-relaunch — that belongs in the actuator layer.
 */
async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const sessionFilePath = positional[0] || findLatestSessionFile();

  const { state, decision } = await evaluateSession(sessionFilePath, {
    contextWindowTokens: flags.contextWindowTokens || undefined,
  });

  console.log(`session       ${state.sessionId}`);
  console.log(`cwd           ${state.cwd}`);
  console.log(`branch        ${state.gitBranch}`);
  const window = state.contextWindowTokens
    ? `${state.contextWindowTokens.toLocaleString()} tokens (${(state.contextUsedPct * 100).toFixed(1)}%)`
    : 'unknown window';
  console.log(`context       ${state.contextUsedTokens.toLocaleString()} / ${window}`);
  console.log(`compactions   ${state.compactionCount}`);
  console.log(`session age   ${state.sessionAgeMinutes.toFixed(0)}m`);
  console.log(`messages      ${state.messageCount}`);
  console.log('');

  if (!decision) {
    const why = state.contextWindowTokens
      ? `context used (${state.contextUsedTokens.toLocaleString()} tokens) exceeds the assumed ` +
        `${state.contextWindowTokens.toLocaleString()}-token window`
      : `no context window could be determined for this model`;
    console.log(
      `recommendation: UNKNOWN — ${why}. Re-run with --context-window <real size> ` +
        `to get a trustworthy recommendation.`,
    );
    return;
  }

  console.log(`recommendation: ${decision.action}`);
  for (const reason of decision.reasons) {
    console.log(`  - ${reason}`);
  }
}

main().catch((error) => {
  console.error(`governor error: ${error.message}`);
  process.exit(1);
});
