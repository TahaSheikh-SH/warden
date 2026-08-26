'use strict';

// ~/.warden/sessions and ~/.warden/cache accumulate one file per
// session forever, and *.bak.<epoch> files pile up beside every settings
// file setup.js touches. sweepDirectory is the one shared primitive both use
// — a size/age sweep on write, since SessionEnd (Claude Code only) isn't a
// harness-agnostic trigger (Gate B, AGENTS.md).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sweepDirectory } = require('../../actuators/retention');

function tempDir() {
  const dir = path.join(os.tmpdir(), `warden-retention-test-${process.hrtime.bigint()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFileAt(dir, name, mtimeMs) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, 'x');
  fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  return filePath;
}

describe('sweepDirectory', () => {
  test('does nothing when the directory does not exist', () => {
    const dir = path.join(os.tmpdir(), `warden-retention-missing-${process.hrtime.bigint()}`);
    assert.doesNotThrow(() => sweepDirectory(dir, { keepNewest: 2 }));
  });

  test('keepNewest deletes everything but the N most recently modified files', () => {
    const dir = tempDir();
    try {
      writeFileAt(dir, 'a.jsonl', 1_000);
      writeFileAt(dir, 'b.jsonl', 2_000);
      writeFileAt(dir, 'c.jsonl', 3_000);
      sweepDirectory(dir, { keepNewest: 2 });
      assert.deepEqual(fs.readdirSync(dir).sort(), ['b.jsonl', 'c.jsonl']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('maxAgeMs deletes files older than the cutoff', () => {
    const dir = tempDir();
    try {
      const now = Date.now();
      writeFileAt(dir, 'old.jsonl', now - 40 * 24 * 60 * 60 * 1000);
      writeFileAt(dir, 'new.jsonl', now);
      sweepDirectory(dir, { maxAgeMs: 30 * 24 * 60 * 60 * 1000, now });
      assert.deepEqual(fs.readdirSync(dir), ['new.jsonl']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('pattern restricts the sweep to matching filenames, leaving others untouched', () => {
    const dir = tempDir();
    try {
      writeFileAt(dir, 'settings.json.bak.1', 1_000);
      writeFileAt(dir, 'settings.json.bak.2', 2_000);
      writeFileAt(dir, 'settings.json.bak.3', 3_000);
      writeFileAt(dir, 'settings.json', 4_000);
      sweepDirectory(dir, { keepNewest: 1, pattern: /\.bak\.\d+$/ });
      assert.deepEqual(fs.readdirSync(dir).sort(), ['settings.json', 'settings.json.bak.3']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never throws on an unreadable/unwritable path — retention is best-effort', () => {
    assert.doesNotThrow(() => sweepDirectory('/root/definitely-not-writable', { keepNewest: 1 }));
  });
});
