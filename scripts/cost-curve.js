#!/usr/bin/env node
'use strict';

// RESEARCH SPIKE — throwaway dev tool, not shipped, not wired to decide.js.
// Replays a real session transcript and computes an approximate $-cost
// curve per turn, using official Anthropic per-model pricing (fetched
// 2026-08-22 from platform.claude.com/docs/en/about-claude/pricing).
// Marks where decide() first returns HANDOFF, then compares two
// hypothetical STOP policies against actual continued cost past that
// point: immediate STOP vs a grace window of extra turns.
//
// Usage: node scripts/cost-curve.js <session.jsonl> [graceTurns]

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { buildResourceState } = require('../resourceState');
const { decide } = require('../decide');

// $ / token (converted from official $/MTok table). Cache write assumed
// 5-minute (1.25x base input) since that's the default breakpoint type;
// cache read is 0.1x base input across all models.
const PRICING = {
  'claude-sonnet-5': {
    input: 2 / 1e6,
    output: 10 / 1e6,
    cacheWrite: 2.5 / 1e6,
    cacheRead: 0.2 / 1e6,
  },
  'claude-opus-5': {
    input: 5 / 1e6,
    output: 25 / 1e6,
    cacheWrite: 6.25 / 1e6,
    cacheRead: 0.5 / 1e6,
  },
  'claude-haiku-4-5-20251001': {
    input: 1 / 1e6,
    output: 5 / 1e6,
    cacheWrite: 1.25 / 1e6,
    cacheRead: 0.1 / 1e6,
  },
  // fallback for older/unlisted model strings seen in real transcripts
  default: { input: 3 / 1e6, output: 15 / 1e6, cacheWrite: 3.75 / 1e6, cacheRead: 0.3 / 1e6 },
};

function priceFor(modelId) {
  if (!modelId) return PRICING.default;
  const key = Object.keys(PRICING).find((k) => modelId.includes(k));
  return key ? PRICING[key] : PRICING.default;
}

function turnCost(usage, modelId) {
  const p = priceFor(modelId);
  return (
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheCreationTokens * p.cacheWrite +
    usage.cacheReadTokens * p.cacheRead
  );
}

async function* readRawEntries(sessionFilePath) {
  const stream = readline.createInterface({
    input: fs.createReadStream(sessionFilePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of stream) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      continue;
    }
  }
}

async function run(sessionFilePath, graceTurns) {
  console.log(`\n=== ${path.basename(sessionFilePath)} ===`);

  // Pass 1: per-turn cost curve + cumulative cost, using raw entries directly
  // (backtest.js/ResourceState only carry cumulative token totals, not a
  // per-turn history, so this script reads turns itself for the curve).
  const turns = [];
  let cumulativeCost = 0;
  let turnIndex = 0;
  for await (const entry of readRawEntries(sessionFilePath)) {
    if (entry.type !== 'assistant' || !entry.message || !entry.message.usage) continue;
    const u = entry.message.usage;
    const usage = {
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheCreationTokens: u.cache_creation_input_tokens || 0,
      cacheReadTokens: u.cache_read_input_tokens || 0,
    };
    const cost = turnCost(usage, entry.message.model);
    cumulativeCost += cost;
    turnIndex += 1;
    turns.push({ turnIndex, cost, cumulativeCost, model: entry.message.model || null });
  }

  if (turns.length === 0) {
    console.log('  no assistant turns with usage found, skipping');
    return;
  }

  // Pass 2: find first HANDOFF turn via existing decide() replay (reuses
  // buildResourceState exactly as backtest.js does, so this stays consistent
  // with the real governor logic instead of reinventing detection).
  const totalLines = fs
    .readFileSync(sessionFilePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim()).length;
  let handoffLine = null;
  for (let n = 10; n <= totalLines; n += 10) {
    const state = await buildResourceState(sessionFilePath, { maxLines: n });
    const { action } = decide(state);
    if (action === 'HANDOFF' && handoffLine === null) {
      handoffLine = n;
      break;
    }
  }

  if (handoffLine === null) {
    console.log('  HANDOFF never fired in this session — nothing to compare');
    return;
  }

  // Map handoffLine (raw transcript line number) to nearest assistant-turn
  // index: count assistant-usage turns within the first handoffLine raw lines.
  let countAtHandoff = 0;
  let lineCount = 0;
  for await (const entry of readRawEntries(sessionFilePath)) {
    lineCount += 1;
    if (lineCount > handoffLine) break;
    if (entry.type === 'assistant' && entry.message && entry.message.usage) countAtHandoff += 1;
  }
  const handoffTurnIndex = countAtHandoff;

  const atHandoff = turns[handoffTurnIndex - 1];
  const final = turns[turns.length - 1];
  const graceIndex = Math.min(handoffTurnIndex - 1 + graceTurns, turns.length - 1);
  const atGrace = turns[graceIndex];

  const costPastHandoffImmediate = 0; // STOP fires right at handoff: no further spend accrues
  const costPastHandoffGrace = atGrace.cumulativeCost - atHandoff.cumulativeCost;
  const costPastHandoffActual = final.cumulativeCost - atHandoff.cumulativeCost;

  console.log(
    `  HANDOFF fired at turn ${handoffTurnIndex}/${turns.length} (raw line ${handoffLine}/${totalLines})`,
  );
  console.log(`  cost at HANDOFF:        $${atHandoff.cumulativeCost.toFixed(4)}`);
  console.log(`  cost if STOP immediate: +$${costPastHandoffImmediate.toFixed(4)} past handoff`);
  console.log(
    `  cost if STOP w/ grace(${graceTurns}): +$${costPastHandoffGrace.toFixed(4)} past handoff ` +
      `(turn ${handoffTurnIndex} -> ${graceIndex + 1})`,
  );
  console.log(
    `  cost actually incurred staying to end: +$${costPastHandoffActual.toFixed(4)} past handoff ` +
      `(turn ${handoffTurnIndex} -> ${turns.length}, ${turns.length - handoffTurnIndex} more turns)`,
  );
  console.log(
    `  session total cost: $${final.cumulativeCost.toFixed(4)} ` +
      `(${((costPastHandoffActual / final.cumulativeCost) * 100).toFixed(0)}% spent after HANDOFF fired)`,
  );
}

async function main() {
  const [sessionFilePath, graceArg] = process.argv.slice(2);
  if (!sessionFilePath) {
    console.error('usage: node scripts/cost-curve.js <session.jsonl> [graceTurns]');
    process.exit(1);
  }
  await run(sessionFilePath, Number(graceArg) || 5);
}

main().catch((err) => {
  console.error(`cost-curve error: ${err.message}`);
  process.exit(1);
});
