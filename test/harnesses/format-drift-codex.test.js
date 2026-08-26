'use strict';

// Codex actuator mirrors resourceState.js's driftDetected check
// (test/resourceState.format-drift.test.js) using its own line-count
// progress counter, since it streams straight from streamNormalizedEntries
// rather than going through resourceState.js's cache-aware wrapper.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluateCodexSession } = require('../../harnesses/codex/actuator');

function tempTranscriptPath() {
  return path.join(os.tmpdir(), `warden-format-drift-codex-test-${process.hrtime.bigint()}.jsonl`);
}

function renamedTokenCountLine() {
  // 'last_token_usage2' instead of 'last_token_usage' — every line is still
  // valid JSON with a recognized top-level type, so nothing is rejected; the
  // usage payload is just never recognized.
  return JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage2: { input_tokens: 1000 } } },
  });
}

describe('codex format-drift detection', () => {
  test('many parsed lines with zero usage entries sets driftDetected', async () => {
    const sessionFilePath = tempTranscriptPath();
    try {
      const lines = Array.from({ length: 25 }, () => renamedTokenCountLine());
      fs.writeFileSync(sessionFilePath, lines.join('\n') + '\n');

      const { state } = await evaluateCodexSession(sessionFilePath, {
        contextWindowTokens: 100000,
      });
      assert.equal(state.driftDetected, true);
    } finally {
      fs.rmSync(sessionFilePath, { force: true });
    }
  });
});
