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

function loadSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

function isWardenHookEntry(entry, adapterPath) {
  return (entry.hooks || []).some(
    (h) => h.type === 'command' && h.command && h.command.includes(adapterPath),
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

  if (existing.some((p) => path.resolve(baseDir, p) === entryPath)) {
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
// registrations above — there's no safe generic way to merge it with a
// user's existing statusLine (no shell parser, no new runtime deps — see
// AGENTS.md). Set it only when unconfigured; otherwise warn and leave it
// alone, same precedent as checkCodexHooksFeatureFlag.
function withWardenStatusLineRegistered(settings, statuslinePath) {
  const command = `node ${statuslinePath}`;
  const existing = settings.statusLine;

  if (!existing) {
    return {
      settings: { ...settings, statusLine: { type: 'command', command } },
      changed: true,
      warning: null,
    };
  }
  if (existing.command && existing.command.includes(statuslinePath)) {
    return { settings, changed: false, warning: null };
  }
  return {
    settings,
    changed: false,
    warning:
      `Claude Code: statusLine already set to "${existing.command}" — leaving it alone. ` +
      `Add warden's decision line yourself by appending \`node ${statuslinePath}\` to that script.`,
  };
}

function registerStatusLine(settingsPath, statuslinePath) {
  const before = loadSettings(settingsPath);
  const {
    settings: after,
    changed,
    warning,
  } = withWardenStatusLineRegistered(before, statuslinePath);

  if (warning) {
    console.log(warning);
    return;
  }
  if (!changed) {
    console.log(`Claude Code: warden statusLine already registered in ${settingsPath}.`);
    return;
  }

  const backupPath = `${settingsPath}.bak.${Date.now()}`;
  if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, backupPath);
  fs.writeFileSync(settingsPath, `${JSON.stringify(after, null, 2)}\n`);
  console.log(`Claude Code: warden statusLine registered in ${settingsPath}.`);
}

function main() {
  registerHook(SETTINGS_PATH, NATIVE_ADAPTER_PATH, 'Claude Code');
  registerStatusLine(SETTINGS_PATH, STATUSLINE_PATH);
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
};
