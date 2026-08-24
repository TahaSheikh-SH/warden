'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  sanitizeCwdToProjectDir,
  findLatestSessionFile,
} = require('../../harnesses/claude-code/locate');

describe('sanitizeCwdToProjectDir', () => {
  test('replaces path separators and non-alphanumerics with dashes', () => {
    assert.equal(sanitizeCwdToProjectDir('/Users/me/my-project'), '-Users-me-my-project');
  });

  test('leaves alphanumerics untouched', () => {
    assert.equal(sanitizeCwdToProjectDir('abc123'), 'abc123');
  });
});

describe('findLatestSessionFile', () => {
  test('throws when the project session directory does not exist', () => {
    const cwd = path.join(os.tmpdir(), `warden-locate-missing-${process.hrtime.bigint()}`);
    assert.throws(() => findLatestSessionFile(cwd), /no Claude Code session directory found/);
  });

  test('throws when the project session directory has no .jsonl files', () => {
    const cwd = `warden-locate-empty-${process.hrtime.bigint()}`;
    const projectDir = path.join(os.homedir(), '.claude', 'projects', sanitizeCwdToProjectDir(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    try {
      assert.throws(() => findLatestSessionFile(cwd), /no session files found/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('returns the most recently modified .jsonl file', async () => {
    const cwd = `warden-locate-latest-${process.hrtime.bigint()}`;
    const projectDir = path.join(os.homedir(), '.claude', 'projects', sanitizeCwdToProjectDir(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    try {
      const older = path.join(projectDir, 'older.jsonl');
      const newer = path.join(projectDir, 'newer.jsonl');
      fs.writeFileSync(older, '{}');
      const oldTime = new Date(Date.now() - 60000);
      fs.utimesSync(older, oldTime, oldTime);
      fs.writeFileSync(newer, '{}');

      assert.equal(findLatestSessionFile(cwd), newer);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('ignores non-.jsonl files in the project directory', () => {
    const cwd = `warden-locate-filter-${process.hrtime.bigint()}`;
    const projectDir = path.join(os.homedir(), '.claude', 'projects', sanitizeCwdToProjectDir(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'hi');
      const session = path.join(projectDir, 'session.jsonl');
      fs.writeFileSync(session, '{}');

      assert.equal(findLatestSessionFile(cwd), session);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
