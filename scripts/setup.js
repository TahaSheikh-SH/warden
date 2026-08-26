#!/usr/bin/env node
'use strict';

// One-command onboarding: registers warden's adapter with each harness it
// finds — Claude Code and Codex as a UserPromptSubmit hook, Pi and OpenCode as
// a config array entry. Every step is idempotent and backs up the file it
// touches. JSON.parse/stringify throughout, so comments in a hand-written
// opencode.jsonc are dropped on first run (no jsonc parser — no new runtime
// deps, see AGENTS.md).

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  withWardenStatusLineRegistered,
  wrapperScriptContents,
  registerStatusLine,
} = require('./statuslineRegistration');

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
// In ~/.warden, not the repo: generated per machine from whatever statusLine
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

// Claude Code and Codex share the hook file shape, so they share this.
// Idempotent per adapterPath.
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

// Codex runs no hooks at all unless `[features] hooks = true`. Editing TOML
// would need a parser (no new runtime deps — see AGENTS.md), so this only
// warns when the flag looks missing.
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

// Pi and OpenCode both register by appending a path to a top-level array.
// Entries may be relative or absolute, so dedupe by resolved path.
function withWardenArrayEntryRegistered(settings, arrayKey, entryPath, baseDir) {
  const next = { ...settings };
  const existing = next[arrayKey] || [];

  if (existing.some((existingPath) => path.resolve(baseDir, existingPath) === entryPath)) {
    return { settings: next, changed: false };
  }

  next[arrayKey] = [...existing, entryPath];
  return { settings: next, changed: true };
}

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

function main() {
  registerHook(SETTINGS_PATH, NATIVE_ADAPTER_PATH, 'Claude Code');
  registerStatusLine(SETTINGS_PATH, STATUSLINE_PATH, STATUSLINE_WRAPPER_PATH, loadSettings);
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
