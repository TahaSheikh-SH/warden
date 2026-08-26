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
    .filter((line) => line.trim()).length;
  const checkpoints = [];
  for (let lineNum = stepLines; lineNum < totalLines; lineNum += stepLines)
    checkpoints.push(lineNum);
  checkpoints.push(totalLines);

  console.log(`\n=== ${path.basename(sessionFilePath)} (${totalLines} lines) ===`);

  // null, not a fabricated 0, when unmeasurable — render "unknown" rather
  // than formatting a fake number.
  const pctDisplay = (pct) => (pct === null ? 'unknown' : `${(pct * 100).toFixed(0)}%`);
  const ageDisplay = (minutes) => (minutes === null ? 'unknown' : `${minutes.toFixed(0)}m`);

  let lastAction = null;
  for (const lineNum of checkpoints) {
    const state = await buildResourceState(sessionFilePath, { maxLines: lineNum });
    const { action, reasons } = decide(state);
    if (action !== lastAction) {
      console.log(
        `  line ${lineNum}/${totalLines}: ${action} ` +
          `(context ${pctDisplay(state.contextUsedPct)}, ` +
          `${state.compactionCount} compactions, ${ageDisplay(state.sessionAgeMinutes)}) — ${reasons[0]}`,
      );
      lastAction = action;
    }
  }

  const finalState = await buildResourceState(sessionFilePath);
  console.log(
    `  actual end state: ${finalState.compactionCount} real compaction(s), ` +
      `final context ${pctDisplay(finalState.contextUsedPct)}, ` +
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

main().catch((error) => {
  console.error(`backtest error: ${error.message}`);
  process.exit(1);
});
