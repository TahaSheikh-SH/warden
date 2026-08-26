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
const { normalizeEntry } = require('../../harnesses/codex/transcript');

function tempTranscriptPath() {
  return path.join(os.tmpdir(), `warden-format-drift-codex-test-${process.hrtime.bigint()}.jsonl`);
}

function sessionMetaLine() {
  return JSON.stringify({ type: 'session_meta', payload: { id: 'abc', cwd: '/repo' } });
}

// renamed_token_usage line simulates a Codex payload where
// `last_token_usage` was renamed (e.g. `token_usage`) — before the fix,
// handleEventMsg only set base.type = 'assistant' once last_token_usage
// parsed, so messageCount and assistantUsageCount moved in lockstep and
// the drift canary (messageCount > 3 && assistantUsageCount === 0) was
// structurally unreachable on Codex.
function renamedTokenUsageLine() {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        token_usage: { input_tokens: 100, output_tokens: 10 },
        model_context_window: 258400,
      },
    },
  });
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

  test('token_count event marks the entry assistant even when last_token_usage is renamed away', () => {
    const normalized = normalizeEntry(JSON.parse(renamedTokenUsageLine()));
    assert.equal(normalized.type, 'assistant');
    assert.equal(normalized.usage, null);
  });

  test('10 renamed-field token_count lines sets driftDetected — the canary must actually fire on Codex', async () => {
    const sessionFilePath = tempTranscriptPath();
    try {
      const lines = Array.from({ length: 10 }, () => renamedTokenUsageLine());
      fs.writeFileSync(sessionFilePath, lines.join('\n') + '\n');

      const { state } = await evaluateCodexSession(sessionFilePath, {
        contextWindowTokens: 100000,
      });
      assert.equal(state.messageCount, 10);
      assert.equal(state.assistantUsageCount, 0);
      assert.equal(state.driftDetected, true);
    } finally {
      fs.rmSync(sessionFilePath, { force: true });
    }
  });
});
