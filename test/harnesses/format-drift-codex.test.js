'use strict';

// Codex actuator mirrors resourceState.js's driftDetected check
// (test/resourceState.format-drift.test.js) using reduceTranscriptEntries'
// own messageCount, since it streams straight from streamNormalizedEntries
// rather than going through resourceState.js's cache-aware wrapper. Unlike
// Claude Code, a Codex entry is only ever normalized to type 'assistant'
// once its usage payload parses (harnesses/codex/transcript.js
// handleEventMsg), so messageCount and assistantUsageCount move together
// here — the regression below is the pre-assistant-entry false-fire, not a
// renamed-usage-field case.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluateCodexSession } = require('../../harnesses/codex/actuator');

function tempTranscriptPath() {
  return path.join(os.tmpdir(), `warden-format-drift-codex-test-${process.hrtime.bigint()}.jsonl`);
}

function sessionMetaLine() {
  return JSON.stringify({ type: 'session_meta', payload: { id: 'abc', cwd: '/repo' } });
}

describe('codex format-drift detection', () => {
  // Regression: gating on raw line count fired before any assistant turn
  // existed, since session_meta/turn_context/etc. records precede the first
  // real token_count line in every real rollout.
  test('many non-assistant records before any usage is parsed is not drift', async () => {
    const sessionFilePath = tempTranscriptPath();
    try {
      const lines = Array.from({ length: 25 }, () => sessionMetaLine());
      fs.writeFileSync(sessionFilePath, lines.join('\n') + '\n');

      const { state } = await evaluateCodexSession(sessionFilePath, {
        contextWindowTokens: 100000,
      });
      assert.equal(state.driftDetected, false);
    } finally {
      fs.rmSync(sessionFilePath, { force: true });
    }
  });
});
