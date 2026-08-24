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

function timestampAtLine(sessionFilePath, n) {
  const lines = fs
    .readFileSync(sessionFilePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  for (let i = Math.min(n, lines.length) - 1; i >= 0; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]);
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
    .filter((l) => l.trim()).length;
  const checkpoints = [];
  for (let n = stepLines; n < totalLines; n += stepLines) checkpoints.push(n);
  checkpoints.push(totalLines);

  const entries = [];
  for (const n of checkpoints) {
    const state = await buildResourceState(sessionFilePath, { maxLines: n });
    const { action, reasons } = decide(state);
    entries.push({
      timestamp: timestampAtLine(sessionFilePath, n),
      sessionKey: sessionFilePath,
      action,
      reasons,
      contextUsedPct: state.contextUsedPct,
      compactionCount: state.compactionCount,
      sessionAgeMinutes: state.sessionAgeMinutes,
    });
  }

  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
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
  main().catch((err) => {
    console.error(`backfill error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { timestampAtLine, backfill };
