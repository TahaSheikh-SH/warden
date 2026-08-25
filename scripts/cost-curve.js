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
const { priceFor } = require('../lib/pricing');

function turnCost(usage, modelId) {
  const rates = priceFor(modelId);
  return (
    usage.inputTokens * rates.input +
    usage.outputTokens * rates.output +
    usage.cacheCreationTokens * rates.cacheWrite +
    usage.cacheReadTokens * rates.cacheRead
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
    const rawUsage = entry.message.usage;
    const usage = {
      inputTokens: rawUsage.input_tokens || 0,
      outputTokens: rawUsage.output_tokens || 0,
      cacheCreationTokens: rawUsage.cache_creation_input_tokens || 0,
      cacheReadTokens: rawUsage.cache_read_input_tokens || 0,
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
    .filter((line) => line.trim()).length;
  let handoffLine = null;
  for (let lineNum = 10; lineNum <= totalLines; lineNum += 10) {
    const state = await buildResourceState(sessionFilePath, { maxLines: lineNum });
    const { action } = decide(state);
    if (action === 'HANDOFF' && handoffLine === null) {
      handoffLine = lineNum;
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

main().catch((error) => {
  console.error(`cost-curve error: ${error.message}`);
  process.exit(1);
});
