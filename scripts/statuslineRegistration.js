'use strict';

// Claude Code's statusLine is a single opaque command string, unlike the hook
// and array registrations in setup.js, so warden can't merge into an existing
// one by editing it. It generates a wrapper it owns instead. Kept in its own
// module so setup.js stays about registration, not shell generation.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Single-quote for the shell: safe for newlines, `;`, `&&`, `$`, backticks
// and spaces alike, so no shell parser is needed (no new runtime deps — see
// AGENTS.md).
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Does `command` run `targetPath`? Tokens are compared as resolved paths, not
// substrings, so `~/.warden/x.sh` and `/Users/me/.warden/x.sh` are recognized
// as the same file. A path only counts in the position a command would put it
// in — first word, or the argument after an interpreter — so a path mentioned
// inside an unrelated string doesn't read as a registration.
function commandRunsPath(command, targetPath) {
  const tokens = String(command)
    .split(/\s+/)
    .map((token) => token.replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  return tokens.some((token, index) => {
    const isRunPosition = index === 0 || ['node', 'bash', 'sh', 'zsh'].includes(tokens[index - 1]);
    if (!isRunPosition) return false;
    const expanded = token.startsWith('~/') ? path.join(os.homedir(), token.slice(2)) : token;
    return path.resolve(expanded) === targetPath;
  });
}

// statusLine is a single opaque command string, unlike the hook/array
// registrations above, so warden can't merge into an existing one by editing
// it. Instead it generates a wrapper script it owns that runs the previously
// configured command and then warden's, and points statusLine at the wrapper.
// The user's own script is never edited, and reinstalling it can't drop
// warden's line, because the wrapper calls that script rather than living
// inside it.
function withWardenStatusLineRegistered(settings, statuslinePath, wrapperPath) {
  const existing = settings.statusLine;

  if (!existing || !existing.command) {
    return {
      settings: {
        ...settings,
        statusLine: { type: 'command', command: `node ${shellQuote(statuslinePath)}` },
      },
      changed: true,
      wrapper: null,
      wrapperInUse: false,
    };
  }
  if (commandRunsPath(existing.command, statuslinePath)) {
    return { settings, changed: false, wrapper: null, wrapperInUse: false };
  }
  // Recognizing the wrapper is what keeps this idempotent: without it, a
  // re-run would generate a wrapper whose previous command is the wrapper
  // itself, and the status line would recurse until the shell ran out of
  // processes.
  if (commandRunsPath(existing.command, wrapperPath)) {
    return { settings, changed: false, wrapper: null, wrapperInUse: true };
  }

  return {
    settings: {
      ...settings,
      statusLine: { type: 'command', command: `bash ${shellQuote(wrapperPath)}` },
    },
    changed: true,
    wrapper: { path: wrapperPath, previousCommand: existing.command },
    wrapperInUse: false,
  };
}

// Inverse of withWardenStatusLineRegistered. wrapperContents is the wrapper
// file's current text (read by the caller) so the previous command can be
// recovered via parsePreviousCommandFromWrapper — the wrapper is the only
// record of it once settings.json points there instead. Returns unchanged
// when statusLine points at neither warden nor its wrapper (not ours to
// touch) or is already absent.
function withWardenStatusLineUnregistered(settings, statuslinePath, wrapperPath, wrapperContents) {
  const existing = settings.statusLine;
  if (!existing || !existing.command) return { settings, changed: false };

  if (commandRunsPath(existing.command, statuslinePath)) {
    const next = { ...settings };
    delete next.statusLine;
    return { settings: next, changed: true };
  }

  if (commandRunsPath(existing.command, wrapperPath)) {
    const previousCommand = parsePreviousCommandFromWrapper(wrapperContents);
    if (previousCommand == null) return { settings, changed: false };
    return {
      settings: { ...settings, statusLine: { ...existing, command: previousCommand } },
      changed: true,
    };
  }

  return { settings, changed: false };
}

// Claude Code delivers the statusLine payload on stdin and both commands need
// it, so the wrapper reads it once and replays it to each. The previous
// command goes through `bash -c` so a multi-line or `;`-joined command still
// receives that stdin as a whole. No `set -e`: one command failing must not
// suppress the other's line. The env guard is a second line of defence
// against recursion, for a chain warden can't see when it generates this.
// Prefix for the structured comment line below — the only place the wrapper
// records its previous command in a form uninstall can parse back out,
// rather than trying to recover it from the bash -c invocation.
const PREVIOUS_COMMAND_MARKER = '# warden-previous-command: ';

function wrapperScriptContents(previousCommand, statuslinePath) {
  return [
    '#!/bin/bash',
    "# Generated by warden's setup (npm run setup) — do not edit by hand.",
    `${PREVIOUS_COMMAND_MARKER}${JSON.stringify(previousCommand)}`,
    '[ -n "$WARDEN_STATUSLINE_ACTIVE" ] && exit 0',
    'export WARDEN_STATUSLINE_ACTIVE=1',
    'input=$(cat)',
    '',
    `printf '%s' "$input" | bash -c ${shellQuote(previousCommand)}`,
    `printf '%s' "$input" | node ${shellQuote(statuslinePath)}`,
    '',
  ].join('\n');
}

// Recovers the previous command from the structured comment above — the
// wrapper file is the only record of it once settings.json has been
// rewritten to point at the wrapper.
function parsePreviousCommandFromWrapper(wrapperContents) {
  const line = String(wrapperContents)
    .split('\n')
    .find((candidate) => candidate.startsWith(PREVIOUS_COMMAND_MARKER));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(PREVIOUS_COMMAND_MARKER.length));
  } catch {
    return null;
  }
}

// Reports when statusLine is configured but points at neither warden's own
// script nor its wrapper — meaning some other checkout, or setup was never
// run for it, and warden's decision line is not actually visible anywhere.
function statusLineDriftMessage(settings, statuslinePath, wrapperPath) {
  const command = settings.statusLine && settings.statusLine.command;
  if (!command) return null;
  if (commandRunsPath(command, statuslinePath) || commandRunsPath(command, wrapperPath)) {
    return null;
  }
  return (
    `Claude Code: statusLine is "${command}" — neither warden nor its wrapper. ` +
    "Warden's decision line will not be visible on the status line."
  );
}

function backupFile(filePath, label) {
  if (!fs.existsSync(filePath)) return;
  const backupPath = `${filePath}.bak.${Date.now()}`;
  fs.copyFileSync(filePath, backupPath);
  console.log(`Claude Code: backed up existing ${label} to ${backupPath}`);
}

// Inverse of registerStatusLine. No-ops when statusLine points at neither
// warden nor its wrapper (not ours to touch).
function unregisterStatusLine(settingsPath, statuslinePath, wrapperPath, loadSettings) {
  const before = loadSettings(settingsPath);
  const wrapperContents = fs.existsSync(wrapperPath) ? fs.readFileSync(wrapperPath, 'utf8') : '';
  const { settings: after, changed } = withWardenStatusLineUnregistered(
    before,
    statuslinePath,
    wrapperPath,
    wrapperContents,
  );

  if (!changed) {
    console.log(
      `Claude Code: warden statusLine not registered in ${settingsPath} — nothing to do.`,
    );
    return;
  }

  backupFile(settingsPath, 'settings');
  fs.writeFileSync(settingsPath, `${JSON.stringify(after, null, 2)}\n`);
  console.log(`Claude Code: warden statusLine removed from ${settingsPath}.`);
}

function registerStatusLine(settingsPath, statuslinePath, wrapperPath, loadSettings) {
  const before = loadSettings(settingsPath);
  const {
    settings: after,
    changed,
    wrapper,
    wrapperInUse,
  } = withWardenStatusLineRegistered(before, statuslinePath, wrapperPath);

  if (!changed) {
    // A wrapper generated from a different checkout chains that checkout's
    // statusline.js, so this one would never run despite statusLine looking
    // correctly registered.
    if (wrapperInUse && !fs.readFileSync(wrapperPath, 'utf8').includes(statuslinePath)) {
      console.log(
        `Claude Code: ${wrapperPath} points at a different warden checkout — ` +
          `delete it and re-run setup to wire this one.`,
      );
      return;
    }
    console.log(`Claude Code: warden statusLine already registered in ${settingsPath}.`);
    return;
  }

  backupFile(settingsPath, 'settings');

  if (wrapper) {
    const wrapperDir = path.dirname(wrapper.path);
    if (!fs.existsSync(wrapperDir)) fs.mkdirSync(wrapperDir, { recursive: true });
    // Backed up too: the previous command it chains may exist nowhere else
    // once settings.json has been rewritten.
    backupFile(wrapper.path, 'statusline wrapper');
    fs.writeFileSync(wrapper.path, wrapperScriptContents(wrapper.previousCommand, statuslinePath), {
      mode: 0o755,
    });
    console.log(
      `Claude Code: statusLine was "${wrapper.previousCommand}" — wrapped it in ${wrapper.path} ` +
        `so both it and warden's decision line render.`,
    );
  }

  fs.writeFileSync(settingsPath, `${JSON.stringify(after, null, 2)}\n`);
  console.log(`Claude Code: warden statusLine registered in ${settingsPath}.`);
}

module.exports = {
  withWardenStatusLineRegistered,
  withWardenStatusLineUnregistered,
  wrapperScriptContents,
  parsePreviousCommandFromWrapper,
  statusLineDriftMessage,
  registerStatusLine,
  unregisterStatusLine,
};
