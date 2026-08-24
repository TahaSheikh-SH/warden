#!/usr/bin/env node
'use strict';

// Measurement rollup. Reads the per-session decision logs under
// ~/.warden/sessions/*.jsonl (written by each harness actuator on every
// turn — see actuators/logStore.js) and reports, per action type: how
// often a COMPACT/CHECKPOINT nudge was followed, and how often a
// HANDOFF/STOP block got overridden (session kept going in the same
// transcript instead of a fresh one).
//
// Timeboxed measurement experiment, not permanent infra. Usage:
//   node scripts/rollup.js [path/to/log.jsonl | path/to/sessions/dir]

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const LOG_DIR = path.join(os.homedir(), '.warden');
const DEFAULT_SESSIONS_DIR = path.join(LOG_DIR, 'sessions');
// Pre-per-session-file log, still supported as a fallback/explicit target.
const LEGACY_LOG_FILE = path.join(LOG_DIR, 'log.jsonl');

function resolveLogFiles(target) {
  if (target) {
    return fs.existsSync(target) && fs.statSync(target).isDirectory()
      ? fs
          .readdirSync(target)
          .filter((fname) => fname.endsWith('.jsonl'))
          .map((fname) => path.join(target, fname))
      : [target];
  }
  if (fs.existsSync(DEFAULT_SESSIONS_DIR)) {
    return fs
      .readdirSync(DEFAULT_SESSIONS_DIR)
      .filter((fname) => fname.endsWith('.jsonl'))
      .map((fname) => path.join(DEFAULT_SESSIONS_DIR, fname));
  }
  return [LEGACY_LOG_FILE];
}

async function loadEntries(logFile) {
  const entries = [];
  const stream = readline.createInterface({
    input: fs.createReadStream(logFile, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of stream) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      continue; // tolerate a partial trailing line from an in-progress write
    }
  }
  return entries;
}

// Did a compact_boundary system entry appear in the transcript strictly
// after `sinceTimestamp`?
function transcriptCompactedAfter(sessionKey, sinceTimestamp) {
  if (!sessionKey || !fs.existsSync(sessionKey)) return false;
  const lines = fs.readFileSync(sessionKey, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      entry.type === 'system' &&
      entry.subtype === 'compact_boundary' &&
      entry.timestamp &&
      entry.timestamp > sinceTimestamp
    ) {
      return true;
    }
  }
  return false;
}

function rollup(entries) {
  const byAction = {};
  for (const entry of entries) {
    byAction[entry.action] = byAction[entry.action] || { count: 0, sumContextPct: 0 };
    byAction[entry.action].count += 1;
    byAction[entry.action].sumContextPct += entry.contextUsedPct || 0;
  }

  // Follow-through: for each COMPACT/CHECKPOINT nudge, did the same
  // transcript show a compact_boundary after that timestamp?
  const nudges = entries.filter(
    (entry) => entry.action === 'COMPACT' || entry.action === 'CHECKPOINT',
  );
  let nudgesFollowed = 0;
  for (const nudge of nudges) {
    const sessionKey = nudge.sessionKey ?? nudge.transcriptPath;
    if (transcriptCompactedAfter(sessionKey, nudge.timestamp)) nudgesFollowed += 1;
  }

  // Override: for each HANDOFF/STOP block, did a later log entry exist
  // for the same transcript (i.e. the user kept going instead of starting
  // fresh)?
  const blocks = entries.filter((entry) => entry.action === 'HANDOFF' || entry.action === 'STOP');
  let blocksOverridden = 0;
  for (const block of blocks) {
    const blockSessionKey = block.sessionKey ?? block.transcriptPath;
    const continuedSameTranscript = entries.some(
      (entry) =>
        (entry.sessionKey ?? entry.transcriptPath) === blockSessionKey &&
        entry.timestamp > block.timestamp,
    );
    if (continuedSameTranscript) blocksOverridden += 1;
  }

  return {
    byAction,
    nudges: nudges.length,
    nudgesFollowed,
    blocks: blocks.length,
    blocksOverridden,
  };
}

async function main() {
  const logFiles = resolveLogFiles(process.argv[2]).filter((fname) => fs.existsSync(fname));
  if (logFiles.length === 0) {
    console.log('no log files found yet — nothing to roll up');
    return;
  }
  const entries = (await Promise.all(logFiles.map(loadEntries))).flat();
  if (entries.length === 0) {
    console.log('log file is empty — nothing to roll up');
    return;
  }
  const { byAction, nudges, nudgesFollowed, blocks, blocksOverridden } = rollup(entries);

  console.log(`${entries.length} logged decisions\n`);
  console.log('by action:');
  for (const [action, { count, sumContextPct }] of Object.entries(byAction)) {
    const avgPct = ((sumContextPct / count) * 100).toFixed(1);
    console.log(`  ${action}: ${count} (avg context ${avgPct}%)`);
  }
  console.log('');
  console.log(
    `nudge follow-through (COMPACT/CHECKPOINT): ${nudgesFollowed}/${nudges}` +
      (nudges ? ` (${((nudgesFollowed / nudges) * 100).toFixed(0)}%)` : ''),
  );
  console.log(
    `block override rate (HANDOFF/STOP): ${blocksOverridden}/${blocks}` +
      (blocks ? ` (${((blocksOverridden / blocks) * 100).toFixed(0)}%)` : ''),
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`rollup failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { loadEntries, transcriptCompactedAfter, rollup, resolveLogFiles };
