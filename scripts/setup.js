#!/usr/bin/env node
'use strict';

// One-command onboarding. Auto-registers:
// - Claude Code: actuators/native.js as a UserPromptSubmit hook in
//   ~/.claude/settings.json.
// - Codex CLI: harnesses/codex/actuator.js the same way, in
//   ~/.codex/hooks.json — confirmed on this machine to use the identical
//   {hooks: {EventName: [{matcher, hooks: [{type, command}]}]}} shape as
//   Claude Code's settings.json.
// - Pi: harnesses/pi/extension.js into the "packages" array in
//   ~/.pi/agent/settings.json.
// - OpenCode: harnesses/opencode/plugin.js into the "plugin" array in
//   ~/.config/opencode/opencode.jsonc.
// All four are idempotent — running this twice does not duplicate an
// entry — and back up the file they touch first. JSON.parse/stringify is
// used throughout; a hand-written opencode.jsonc with // comments will
// have those comments dropped on first run (no jsonc parser — no new
// runtime deps, see AGENTS.md).

const fs = require('fs');
const os = require('os');
const path = require('path');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const NATIVE_ADAPTER_PATH = path.join(__dirname, '..', 'actuators', 'native.js');

const CODEX_HOOKS_PATH = path.join(os.homedir(), '.codex', 'hooks.json');
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');
const CODEX_ACTUATOR_PATH = path.join(__dirname, '..', 'harnesses', 'codex', 'actuator.js');

const PI_SETTINGS_PATH = path.join(os.homedir(), '.pi', 'agent', 'settings.json');
const PI_EXTENSION_PATH = path.join(__dirname, '..', 'harnesses', 'pi', 'extension.js');

const OPENCODE_CONFIG_PATH = path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc');
const OPENCODE_PLUGIN_PATH = path.join(__dirname, '..', 'harnesses', 'opencode', 'plugin.js');

const STATUSLINE_PATH = path.join(__dirname, '..', 'actuators', 'statusline.js');
// Lives in ~/.warden (warden's own state dir, alongside the session logs)
// rather than the repo — it's generated per machine from whatever statusLine
// that machine already had.
const STATUSLINE_WRAPPER_PATH = path.join(os.homedir(), '.warden', 'claude-statusline.sh');

function loadSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

function isWardenHookEntry(entry, adapterPath) {
  return (entry.hooks || []).some(
    (hook) => hook.type === 'command' && hook.command && hook.command.includes(adapterPath),
  );
}

function withWardenHookRegistered(settings, adapterPath) {
  const next = { ...settings, hooks: { ...settings.hooks } };
  const existing = next.hooks.UserPromptSubmit || [];

  if (existing.some((entry) => isWardenHookEntry(entry, adapterPath))) {
    return { settings: next, changed: false };
  }

  next.hooks.UserPromptSubmit = [
    ...existing,
    { hooks: [{ type: 'command', command: `node ${adapterPath}` }] },
  ];
  return { settings: next, changed: true };
}

// Shared by both the Claude Code and Codex registration steps — same
// {hooks: {UserPromptSubmit: [{hooks: [{type, command}]}]}} shape, same
// backup-then-write behavior. Idempotent per adapterPath.
function registerHook(settingsPath, adapterPath, harnessLabel) {
  const settingsDir = path.dirname(settingsPath);
  if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });

  const before = loadSettings(settingsPath);
  const { settings: after, changed } = withWardenHookRegistered(before, adapterPath);

  if (!changed) {
    console.log(
      `${harnessLabel}: warden hook already registered in ${settingsPath} — nothing to do.`,
    );
    return;
  }

  if (fs.existsSync(settingsPath)) {
    const backupPath = `${settingsPath}.bak.${Date.now()}`;
    fs.copyFileSync(settingsPath, backupPath);
    console.log(`${harnessLabel}: backed up existing settings to ${backupPath}`);
  }

  fs.writeFileSync(settingsPath, `${JSON.stringify(after, null, 2)}\n`);
  console.log(`${harnessLabel}: warden hook registered in ${settingsPath}.`);
}

// Codex only runs hooks at all when `[features] hooks = true` is set in
// config.toml. Warden won't hand-edit TOML without a parser (no new
// runtime deps — see AGENTS.md), so this just checks the raw text and
// warns if the flag looks missing, rather than writing to the file.
function checkCodexHooksFeatureFlag() {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) return;
  const config = fs.readFileSync(CODEX_CONFIG_PATH, 'utf8');
  const hasHooksFeature = /\[features\][^[]*\bhooks\s*=\s*true/.test(config);
  if (!hasHooksFeature) {
    console.log(
      `Codex CLI: hooks may be disabled — add "[features]\\nhooks = true" to ${CODEX_CONFIG_PATH} to enable them.`,
    );
  }
}

// Pi (packages) and OpenCode (plugin) both register warden by appending a
// file path to a top-level array in a JSON(C) config. Entries may be
// relative or absolute (Pi's has been hand-edited before) — compare by
// resolved path, not raw string, to dedupe both forms.
function withWardenArrayEntryRegistered(settings, arrayKey, entryPath, baseDir) {
  const next = { ...settings };
  const existing = next[arrayKey] || [];

  if (existing.some((existingPath) => path.resolve(baseDir, existingPath) === entryPath)) {
    return { settings: next, changed: false };
  }

  next[arrayKey] = [...existing, entryPath];
  return { settings: next, changed: true };
}

// Shared by the Pi and OpenCode registration steps — same
// {[arrayKey]: [...entries]} shape, same backup-then-write behavior.
// Idempotent per entryPath.
function registerArrayEntry(filePath, arrayKey, entryPath, harnessLabel) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const before = loadSettings(filePath);
  const { settings: after, changed } = withWardenArrayEntryRegistered(
    before,
    arrayKey,
    entryPath,
    dir,
  );

  if (!changed) {
    console.log(`${harnessLabel}: warden entry already registered in ${filePath} — nothing to do.`);
    return;
  }

  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.bak.${Date.now()}`;
    fs.copyFileSync(filePath, backupPath);
    console.log(`${harnessLabel}: backed up existing config to ${backupPath}`);
  }

  fs.writeFileSync(filePath, `${JSON.stringify(after, null, 2)}\n`);
  console.log(`${harnessLabel}: warden entry registered in ${filePath}.`);
}

// statusLine is a single opaque command string, unlike the hook/array
// registrations above, so warden can't merge itself into an existing one
// without a shell parser (no new runtime deps — see AGENTS.md). Instead of
// giving up when one is configured, warden generates a wrapper script it
// owns that calls the previous command and then its own, and points
// statusLine at the wrapper. That leaves the user's own script untouched —
// warden never edits a file it doesn't own — and it survives that script
// being reinstalled, since the wrapper calls it rather than living in it.
function withWardenStatusLineRegistered(settings, statuslinePath, wrapperPath) {
  const command = `node ${statuslinePath}`;
  const existing = settings.statusLine;

  if (!existing || !existing.command) {
    return {
      settings: { ...settings, statusLine: { type: 'command', command } },
      changed: true,
      wrapper: null,
    };
  }
  // Already warden's own command, or already the wrapper. The wrapper check
  // is what keeps this idempotent: without it, a re-run would generate a
  // wrapper whose "previous command" is the wrapper itself.
  if (existing.command.includes(statuslinePath) || existing.command.includes(wrapperPath)) {
    return { settings, changed: false, wrapper: null };
  }

  return {
    settings: { ...settings, statusLine: { type: 'command', command: `bash ${wrapperPath}` } },
    changed: true,
    wrapper: { path: wrapperPath, previousCommand: existing.command },
  };
}

// Claude Code delivers the statusLine payload on stdin, and both commands
// need it, so the wrapper reads it once and replays it to each. No `set -e`:
// a failing previous command must not swallow warden's line, or vice versa.
function wrapperScriptContents(previousCommand, statuslinePath) {
  return [
    '#!/bin/bash',
    "# Generated by warden's setup (npm run setup). Do not edit by hand —",
    '# re-run setup to regenerate. Chains the statusLine command that was',
    "# configured before warden, then appends warden's decision line.",
    'input=$(cat)',
    '',
    `printf '%s' "$input" | ${previousCommand}`,
    `printf '%s' "$input" | node ${statuslinePath}`,
    '',
  ].join('\n');
}

function registerStatusLine(settingsPath, statuslinePath, wrapperPath) {
  const before = loadSettings(settingsPath);
  const {
    settings: after,
    changed,
    wrapper,
  } = withWardenStatusLineRegistered(before, statuslinePath, wrapperPath);

  if (!changed) {
    console.log(`Claude Code: warden statusLine already registered in ${settingsPath}.`);
    return;
  }

  if (wrapper) {
    const wrapperDir = path.dirname(wrapper.path);
    if (!fs.existsSync(wrapperDir)) fs.mkdirSync(wrapperDir, { recursive: true });
    fs.writeFileSync(wrapper.path, wrapperScriptContents(wrapper.previousCommand, statuslinePath), {
      mode: 0o755,
    });
    console.log(
      `Claude Code: statusLine was "${wrapper.previousCommand}" — wrapped it in ${wrapper.path} ` +
        `so both it and warden's decision line render.`,
    );
  }

  if (fs.existsSync(settingsPath)) {
    const backupPath = `${settingsPath}.bak.${Date.now()}`;
    fs.copyFileSync(settingsPath, backupPath);
    console.log(`Claude Code: backed up existing settings to ${backupPath}`);
  }
  fs.writeFileSync(settingsPath, `${JSON.stringify(after, null, 2)}\n`);
  console.log(`Claude Code: warden statusLine registered in ${settingsPath}.`);
}

function main() {
  registerHook(SETTINGS_PATH, NATIVE_ADAPTER_PATH, 'Claude Code');
  registerStatusLine(SETTINGS_PATH, STATUSLINE_PATH, STATUSLINE_WRAPPER_PATH);
  registerHook(CODEX_HOOKS_PATH, CODEX_ACTUATOR_PATH, 'Codex CLI');
  checkCodexHooksFeatureFlag();
  registerArrayEntry(PI_SETTINGS_PATH, 'packages', PI_EXTENSION_PATH, 'Pi');
  registerArrayEntry(OPENCODE_CONFIG_PATH, 'plugin', OPENCODE_PLUGIN_PATH, 'OpenCode');
}

if (require.main === module) main();

module.exports = {
  withWardenHookRegistered,
  withWardenArrayEntryRegistered,
  withWardenStatusLineRegistered,
  wrapperScriptContents,
};
