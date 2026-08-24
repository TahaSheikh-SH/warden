#!/usr/bin/env node
'use strict';

// Dev tool: replays a real transcript incrementally through decide() (same
// mechanism as backtest.js) and writes the results in native.js's log
// format to a test log file, so scripts/rollup.js can be sanity-checked
// against known data before waiting weeks for real usage to accumulate.
//
// Writes to a SEPARATE file, never ~/.warden/log.jsonl — this is synthetic
// backfill data, not a real decision history.
//
// Usage: node scripts/backfill-log.js <session.jsonl> [stepLines] [outFile]

const fs = require('fs');
const path = require('path');
const { buildResourceState } = require('../resourceState');
const { decide } = require('../decide');

function timestampAtLine(sessionFilePath, lineCount) {
  const lines = fs
    .readFileSync(sessionFilePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim());
  for (let lineIdx = Math.min(lineCount, lines.length) - 1; lineIdx >= 0; lineIdx -= 1) {
    try {
      const entry = JSON.parse(lines[lineIdx]);
      if (entry.timestamp) return entry.timestamp;
    } catch {
      continue;
    }
  }
  return new Date(0).toISOString(); // no timestamped line found yet
}

async function backfill(sessionFilePath, stepLines, outFile) {
  const totalLines = fs
    .readFileSync(sessionFilePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim()).length;
  const checkpoints = [];
  for (let lineNum = stepLines; lineNum < totalLines; lineNum += stepLines)
    checkpoints.push(lineNum);
  checkpoints.push(totalLines);

  const entries = [];
  for (const lineNum of checkpoints) {
    const state = await buildResourceState(sessionFilePath, { maxLines: lineNum });
    const { action, reasons } = decide(state);
    entries.push({
      timestamp: timestampAtLine(sessionFilePath, lineNum),
      sessionKey: sessionFilePath,
      action,
      reasons,
      contextUsedPct: state.contextUsedPct,
      compactionCount: state.compactionCount,
      sessionAgeMinutes: state.sessionAgeMinutes,
    });
  }

  const lines = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  fs.appendFileSync(outFile, lines);
  console.log(
    `wrote ${entries.length} entries from ${path.basename(sessionFilePath)} to ${outFile}`,
  );
}

async function main() {
  const [sessionFilePath, stepArg, outArg] = process.argv.slice(2);
  if (!sessionFilePath) {
    console.error('usage: node scripts/backfill-log.js <session.jsonl> [stepLines] [outFile]');
    process.exit(1);
  }
  const outFile = outArg || path.join(__dirname, '..', '.backfill-log.jsonl');
  await backfill(sessionFilePath, Number(stepArg) || 50, outFile);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`backfill error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { timestampAtLine, backfill };
