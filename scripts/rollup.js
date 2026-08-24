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
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => path.join(target, f))
      : [target];
  }
  if (fs.existsSync(DEFAULT_SESSIONS_DIR)) {
    return fs
      .readdirSync(DEFAULT_SESSIONS_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(DEFAULT_SESSIONS_DIR, f));
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
  for (const e of entries) {
    byAction[e.action] = byAction[e.action] || { count: 0, sumContextPct: 0 };
    byAction[e.action].count += 1;
    byAction[e.action].sumContextPct += e.contextUsedPct || 0;
  }

  // Follow-through: for each COMPACT/CHECKPOINT nudge, did the same
  // transcript show a compact_boundary after that timestamp?
  const nudges = entries.filter((e) => e.action === 'COMPACT' || e.action === 'CHECKPOINT');
  let nudgesFollowed = 0;
  for (const n of nudges) {
    const sessionKey = n.sessionKey ?? n.transcriptPath;
    if (transcriptCompactedAfter(sessionKey, n.timestamp)) nudgesFollowed += 1;
  }

  // Override: for each HANDOFF/STOP block, did a later log entry exist
  // for the same transcript (i.e. the user kept going instead of starting
  // fresh)?
  const blocks = entries.filter((e) => e.action === 'HANDOFF' || e.action === 'STOP');
  let blocksOverridden = 0;
  for (const b of blocks) {
    const bSessionKey = b.sessionKey ?? b.transcriptPath;
    const continuedSameTranscript = entries.some(
      (e) => (e.sessionKey ?? e.transcriptPath) === bSessionKey && e.timestamp > b.timestamp,
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
  const logFiles = resolveLogFiles(process.argv[2]).filter((f) => fs.existsSync(f));
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
  main().catch((err) => {
    console.error(`rollup failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { loadEntries, transcriptCompactedAfter, rollup, resolveLogFiles };
