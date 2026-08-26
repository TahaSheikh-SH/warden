'use strict';

// If Claude Code renames a field (e.g. usage -> usage2), every parsed
// line is still valid JSON and passes validateTranscriptEntry — usage is
// optional — but zero assistant entries ever fold a usage object, so
// contextUsedTokens stays 0 and decide() silently returns CONTINUE forever.
// buildResourceState must surface that as driftDetected instead of failing
// open with no signal (AGENTS.md's "Read context limits..." note: a
// too-small/absent signal must be visible, not silently guessed away).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildResourceState } = require('../resourceState');

function tempTranscriptPath() {
  return path.join(os.tmpdir(), `warden-format-drift-test-${process.hrtime.bigint()}.jsonl`);
}

function renamedUsageLine(inputTokens) {
  // 'usage2' instead of 'usage' — simulates a renamed field. Still a valid
  // object per validateTranscriptEntry (usage is optional), so it's not
  // rejected; it's just never folded into any total.
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    message: { usage2: { input_tokens: inputTokens, output_tokens: 10 } },
  });
}

function realUsageLine(inputTokens) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    message: { usage: { input_tokens: inputTokens, output_tokens: 10 } },
  });
}

describe('format-drift detection', () => {
  test('many parsed lines with zero usage entries sets driftDetected', async () => {
    const sessionFilePath = tempTranscriptPath();
    try {
      const lines = Array.from({ length: 25 }, (_, i) => renamedUsageLine(1000 + i));
      fs.writeFileSync(sessionFilePath, lines.join('\n') + '\n');

      const state = await buildResourceState(sessionFilePath, { contextWindowTokens: 100000 });
      assert.equal(state.driftDetected, true);
    } finally {
      fs.rmSync(sessionFilePath, { force: true });
    }
  });

  test('does not fire below the line-count threshold', async () => {
    const sessionFilePath = tempTranscriptPath();
    try {
      fs.writeFileSync(sessionFilePath, renamedUsageLine(1000) + '\n');

      const state = await buildResourceState(sessionFilePath, { contextWindowTokens: 100000 });
      assert.equal(state.driftDetected, false);
    } finally {
      fs.rmSync(sessionFilePath, { force: true });
    }
  });

  test('does not fire when usage entries are parsing normally', async () => {
    const sessionFilePath = tempTranscriptPath();
    try {
      const lines = Array.from({ length: 25 }, (_, i) => realUsageLine(1000 + i));
      fs.writeFileSync(sessionFilePath, lines.join('\n') + '\n');

      const state = await buildResourceState(sessionFilePath, { contextWindowTokens: 100000 });
      assert.equal(state.driftDetected, false);
    } finally {
      fs.rmSync(sessionFilePath, { force: true });
    }
  });
});
