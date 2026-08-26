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

// compact_boundary system entries in the transcript strictly after
// `sinceTimestamp`, with the trigger Claude Code reports (compactMetadata is
// Claude-Code-only — see AGENTS.md "Keep harness-specific behavior out of the
// shared core"; other harnesses' boundaries come back with trigger: null).
function compactionsAfter(sessionKey, sinceTimestamp) {
  if (!sessionKey || !fs.existsSync(sessionKey)) return [];
  const lines = fs.readFileSync(sessionKey, 'utf8').split('\n');
  const compactions = [];
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
      compactions.push({
        timestamp: entry.timestamp,
        trigger: entry.compactMetadata?.trigger ?? null,
      });
    }
  }
  return compactions;
}

function transcriptCompactedAfter(sessionKey, sinceTimestamp) {
  return compactionsAfter(sessionKey, sinceTimestamp).length > 0;
}

// contextUsedPct is null when the context window was unmeasurable
// (core/resourceStateCore.js finalizeAccumulator) — a real "unknown", not a
// measured 0%. count tallies every entry for the action regardless;
// measuredCount tallies only entries that actually contributed to
// sumContextPct, so a consumer computing an average divides by the right
// denominator instead of folding unknowns in as zeros.
function tallyByAction(entries) {
  const byAction = {};
  for (const entry of entries) {
    byAction[entry.action] = byAction[entry.action] || {
      count: 0,
      measuredCount: 0,
      sumContextPct: 0,
    };
    byAction[entry.action].count += 1;
    if (entry.contextUsedPct != null) {
      byAction[entry.action].measuredCount += 1;
      byAction[entry.action].sumContextPct += entry.contextUsedPct;
    }
  }
  return byAction;
}

// Follow-through: for each COMPACT/CHECKPOINT nudge, did the same transcript
// show a compact_boundary after that timestamp? Only a 'manual' trigger is
// warden's win — 'auto' means the harness compacted on its own (possibly
// unrelated to the nudge), and counting it inflates the headline metric.
// compactMetadata.trigger is Claude-Code-only: a harness that never sets
// it lands in the unknown-trigger bucket, tallied
// but not claimed as follow-through.
function classifyNudges(entries, nudges) {
  const nudgesByHarness = {};
  let nudgesFollowedManual = 0;
  let nudgesFollowedAuto = 0;
  let nudgesFollowedUnknownTrigger = 0;
  for (const nudge of nudges) {
    const harnessLabel = nudge.harness || 'claude-code';
    nudgesByHarness[harnessLabel] = (nudgesByHarness[harnessLabel] || 0) + 1;
    const sessionKey = nudge.sessionKey ?? nudge.transcriptPath;
    const compactions = compactionsAfter(sessionKey, nudge.timestamp);
    if (!compactions.length) continue;
    if (compactions.some((c) => c.trigger === 'manual')) {
      nudgesFollowedManual += 1;
    } else if (compactions.some((c) => c.trigger === 'auto')) {
      nudgesFollowedAuto += 1;
    } else {
      nudgesFollowedUnknownTrigger += 1;
    }
  }
  return {
    nudgesByHarness,
    nudgesFollowedManual,
    nudgesFollowedAuto,
    nudgesFollowedUnknownTrigger,
  };
}

// Override: for a HANDOFF/STOP block, did a later log entry exist for the
// same transcript that wasn't just the harness resetting state via its own
// compaction? A CONTINUE that only appears after a compact_boundary reflects
// the compaction's reset, not the user overriding the block.
function isOverridden(entries, block) {
  const blockSessionKey = block.sessionKey ?? block.transcriptPath;
  const laterEntries = entries.filter(
    (entry) =>
      (entry.sessionKey ?? entry.transcriptPath) === blockSessionKey &&
      entry.timestamp > block.timestamp,
  );
  if (!laterEntries.length) return false;
  const compactionTimestamps = compactionsAfter(blockSessionKey, block.timestamp)
    .map((c) => c.timestamp)
    .sort();
  const firstCompactionTimestamp = compactionTimestamps[0] ?? null;
  return laterEntries.some(
    (entry) => !firstCompactionTimestamp || entry.timestamp < firstCompactionTimestamp,
  );
}

function rollup(entries) {
  const byAction = tallyByAction(entries);

  const nudges = entries.filter(
    (entry) => entry.action === 'COMPACT' || entry.action === 'CHECKPOINT',
  );
  const {
    nudgesByHarness,
    nudgesFollowedManual,
    nudgesFollowedAuto,
    nudgesFollowedUnknownTrigger,
  } = classifyNudges(entries, nudges);

  const blocks = entries.filter((entry) => entry.action === 'HANDOFF' || entry.action === 'STOP');
  const blocksOverridden = blocks.filter((block) => isOverridden(entries, block)).length;

  return {
    byAction,
    nudges: nudges.length,
    nudgesByHarness,
    nudgesFollowedManual,
    nudgesFollowedAuto,
    nudgesFollowedUnknownTrigger,
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
  const {
    byAction,
    nudges,
    nudgesByHarness,
    nudgesFollowedManual,
    nudgesFollowedAuto,
    nudgesFollowedUnknownTrigger,
    blocks,
    blocksOverridden,
  } = rollup(entries);

  console.log(`${entries.length} logged decisions\n`);
  console.log('by action:');
  for (const [action, { count, measuredCount, sumContextPct }] of Object.entries(byAction)) {
    const avgPct =
      measuredCount > 0 ? `${((sumContextPct / measuredCount) * 100).toFixed(1)}%` : 'unknown';
    const unmeasuredSuffix = measuredCount < count ? `, ${count - measuredCount} unmeasured` : '';
    console.log(`  ${action}: ${count} (avg context ${avgPct}${unmeasuredSuffix})`);
  }
  console.log('');

  // compactMetadata.trigger is Claude-Code-only (Gate B): a
  // headline follow-through number computed only from those sessions and
  // read as warden's overall rate would be the same inflated-metric error
  // this rollup exists to fix, so every count below is labelled by harness.
  const claudeCodeNudges = nudgesByHarness['claude-code'] || 0;
  const otherHarnessNudges = nudges - claudeCodeNudges;
  console.log(
    `nudges (COMPACT/CHECKPOINT): ${nudges} — claude-code: ${claudeCodeNudges}, other harnesses: ${otherHarnessNudges}`,
  );
  if (claudeCodeNudges) {
    console.log(
      `  manual follow-through (claude-code only): ${nudgesFollowedManual}/${claudeCodeNudges}` +
        ` (${((nudgesFollowedManual / claudeCodeNudges) * 100).toFixed(0)}%)`,
    );
    console.log(
      `  harness auto-compacted instead (not a warden win): ${nudgesFollowedAuto}/${claudeCodeNudges}`,
    );
  }
  if (otherHarnessNudges) {
    console.log(
      `  follow-through, trigger unreported by harness: ${nudgesFollowedUnknownTrigger}/${otherHarnessNudges}` +
        ' (cannot split manual vs auto on this harness)',
    );
  }
  console.log(
    `block override rate (HANDOFF/STOP), excluding compaction-driven resets: ${blocksOverridden}/${blocks}` +
      (blocks ? ` (${((blocksOverridden / blocks) * 100).toFixed(0)}%)` : ''),
  );
  console.log('');
  console.log(
    'caveat: cross-run token variance can be large on identical tasks — treat' +
      ' any single-run before/after delta as noise; repeated runs or a large N are needed for a real comparison.',
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`rollup failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  loadEntries,
  transcriptCompactedAfter,
  compactionsAfter,
  rollup,
  resolveLogFiles,
};
