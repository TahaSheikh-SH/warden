#!/usr/bin/env node
'use strict';

// Dev tool, not part of the shipped governor: replays a real session
// transcript incrementally through decide(), so recommendations can be
// checked against what actually happened in the session at that point.
// Usage: node scripts/backtest.js <session.jsonl> [stepLines]

const fs = require('fs');
const path = require('path');
const { buildResourceState } = require('../resourceState');
const { decide } = require('../decide');

async function backtest(sessionFilePath, stepLines) {
  const totalLines = fs
    .readFileSync(sessionFilePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim()).length;
  const checkpoints = [];
  for (let n = stepLines; n < totalLines; n += stepLines) checkpoints.push(n);
  checkpoints.push(totalLines);

  console.log(`\n=== ${path.basename(sessionFilePath)} (${totalLines} lines) ===`);

  let lastAction = null;
  for (const n of checkpoints) {
    const state = await buildResourceState(sessionFilePath, { maxLines: n });
    const { action, reasons } = decide(state);
    if (action !== lastAction) {
      console.log(
        `  line ${n}/${totalLines}: ${action} ` +
          `(context ${(state.contextUsedPct * 100).toFixed(0)}%, ` +
          `${state.compactionCount} compactions, ${state.sessionAgeMinutes.toFixed(0)}m) — ${reasons[0]}`,
      );
      lastAction = action;
    }
  }

  const finalState = await buildResourceState(sessionFilePath);
  console.log(
    `  actual end state: ${finalState.compactionCount} real compaction(s), ` +
      `final context ${(finalState.contextUsedPct * 100).toFixed(0)}%, ` +
      `${finalState.messageCount} assistant turns`,
  );
}

async function main() {
  const [sessionFilePath, stepArg] = process.argv.slice(2);
  if (!sessionFilePath) {
    console.error('usage: node scripts/backtest.js <session.jsonl> [stepLines]');
    process.exit(1);
  }
  await backtest(sessionFilePath, Number(stepArg) || 50);
}

main().catch((err) => {
  console.error(`backtest error: ${err.message}`);
  process.exit(1);
});
