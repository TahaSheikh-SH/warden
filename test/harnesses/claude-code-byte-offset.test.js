'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { streamNormalizedEntries } = require('../../harnesses/claude-code/transcript');

function assistantLine(inputTokens) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-26T00:00:00.000Z',
    message: { usage: { input_tokens: inputTokens, output_tokens: 1 } },
  });
}

function tempTranscriptPath() {
  return path.join(os.tmpdir(), `warden-byte-offset-test-${process.hrtime.bigint()}.jsonl`);
}

async function collect(iterable) {
  const out = [];
  for await (const entry of iterable) out.push(entry);
  return out;
}

describe('streamNormalizedEntries byte offset', () => {
  test('progress.byteOffset tracks total bytes consumed, including blank lines', async () => {
    const filePath = tempTranscriptPath();
    const content = [assistantLine(1000), '', assistantLine(2000)].join('\n') + '\n';
    fs.writeFileSync(filePath, content);
    try {
      const progress = {};
      await collect(streamNormalizedEntries(filePath, { progress }));
      assert.equal(progress.byteOffset, Buffer.byteLength(content, 'utf8'));
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  test('opts.startByteOffset resumes the underlying read from that byte position', async () => {
    const filePath = tempTranscriptPath();
    fs.writeFileSync(filePath, assistantLine(1000) + '\n' + assistantLine(2000) + '\n');
    try {
      const firstProgress = {};
      await collect(streamNormalizedEntries(filePath, { progress: firstProgress }));

      fs.appendFileSync(filePath, assistantLine(3000) + '\n');

      const resumeProgress = { lineCount: firstProgress.lineCount };
      const entries = await collect(
        streamNormalizedEntries(filePath, {
          startLine: firstProgress.lineCount,
          startByteOffset: firstProgress.byteOffset,
          progress: resumeProgress,
        }),
      );

      assert.deepEqual(
        entries.map((e) => e.usage.inputTokens),
        [3000],
      );
      assert.equal(resumeProgress.lineCount, 3);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});
