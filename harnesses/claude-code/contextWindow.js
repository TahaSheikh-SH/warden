'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolves the real effective context window on Claude Code. AGENTS.md:
// "Do not reintroduce an assumed default: a window guessed too large is
// silent, since isContextUsageTrustworthy can only catch one that's too
// small." A model name alone cannot resolve this — Opus 5 is 200K on
// Bedrock/GCP/Foundry, CLAUDE_CODE_DISABLE_1M_CONTEXT=1 holds native-1M
// models to 200K, and autoCompactWindow can cap any model lower still. So
// this combines the model table with autoCompactWindow/env overrides and
// takes the minimum: warden's effective budget is whichever comes first.

// Claude Code reports no context window, only `message.model`. An unlisted
// model gives null — an unknown window, not an assumed one.
const MODEL_CONTEXT_WINDOWS = [
  [/^claude-(sonnet|opus)-4-[6-9]/, 1000000],
  [/^claude-(fable|sonnet|opus)-[5-9]/, 1000000],
  [/^claude-(sonnet|opus)-4-[0-5]/, 200000],
  [/^claude-haiku-/, 200000],
  [/^claude-3/, 200000],
];

const MIN_AUTO_COMPACT_WINDOW = 100000;
const MAX_AUTO_COMPACT_WINDOW = 1000000;
// autoCompactWindow values in this range are documented to mean thousands
// (e.g. 300 means 300,000), not a literal token count.
const BARE_THOUSANDS_MIN = 100;
const BARE_THOUSANDS_MAX = 1000;

function contextWindowForModel(model) {
  if (typeof model !== 'string' || !model) return null;
  const match = MODEL_CONTEXT_WINDOWS.find(([pattern]) => pattern.test(model));
  return match ? match[1] : null;
}

function clampAutoCompactWindow(tokens) {
  if (tokens < MIN_AUTO_COMPACT_WINDOW) return MIN_AUTO_COMPACT_WINDOW;
  if (tokens > MAX_AUTO_COMPACT_WINDOW) return MAX_AUTO_COMPACT_WINDOW;
  return tokens;
}

// Parses the three documented autoCompactWindow forms: a plain token count,
// a k/M-suffixed shorthand, or a bare 100-1000 number meaning thousands.
// Returns null (not a guess) for anything that doesn't parse as a positive
// number, so a malformed setting stands down rather than corrupting the
// resolved window.
function parseAutoCompactWindow(raw) {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const tokens = raw >= BARE_THOUSANDS_MIN && raw <= BARE_THOUSANDS_MAX ? raw * 1000 : raw;
    return clampAutoCompactWindow(tokens);
  }

  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();

  const suffixMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*([kKmM])$/);
  if (suffixMatch) {
    const value = Number(suffixMatch[1]);
    const multiplier = suffixMatch[2].toLowerCase() === 'k' ? 1000 : 1000000;
    return clampAutoCompactWindow(value * multiplier);
  }

  const plain = Number(trimmed);
  if (!Number.isFinite(plain) || plain <= 0) return null;
  const tokens = plain >= BARE_THOUSANDS_MIN && plain <= BARE_THOUSANDS_MAX ? plain * 1000 : plain;
  return clampAutoCompactWindow(tokens);
}

// Lowers {tokens, source} to candidateTokens/candidateSource when the
// candidate is a real number and strictly lower — warden's effective budget
// is whichever cap fires first, never whichever was checked last.
function capIfLower(current, candidateTokens, candidateSource) {
  if (candidateTokens == null) return current;
  if (current.tokens != null && candidateTokens >= current.tokens) return current;
  return { tokens: candidateTokens, source: candidateSource };
}

// Combines model table, settings, and env into one effective window plus a
// human-readable source string — never undefined, so it's never silently
// missing from a logged decision.
function resolveContextWindow({
  overrideTokens,
  model,
  baseTokens,
  baseSource,
  settingsAutoCompactWindow,
  env = {},
} = {}) {
  if (typeof overrideTokens === 'number' && overrideTokens > 0) {
    return { tokens: overrideTokens, source: 'override' };
  }

  // Either a model resolves via the table, or a caller (e.g. resourceState.js,
  // which already folded a detected window from the transcript) passes one in
  // directly — same precedence chain applies from here either way.
  const detectedTokens = typeof baseTokens === 'number' ? baseTokens : contextWindowForModel(model);
  let resolved = {
    tokens: detectedTokens,
    source: detectedTokens != null ? baseSource || 'model-table' : 'unknown',
  };

  if (
    resolved.tokens != null &&
    env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1' &&
    resolved.tokens > 200000
  ) {
    resolved = { tokens: 200000, source: 'model-table+disable-1m' };
  }

  resolved = capIfLower(
    resolved,
    parseAutoCompactWindow(settingsAutoCompactWindow),
    'settings.autoCompactWindow',
  );
  resolved = capIfLower(
    resolved,
    parseAutoCompactWindow(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW),
    'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  );
  resolved = capIfLower(
    resolved,
    parseAutoCompactWindow(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS),
    'env.CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  );

  return resolved;
}

function readAutoCompactWindowFrom(settingsFilePath) {
  try {
    const raw = fs.readFileSync(settingsFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.autoCompactWindow != null ? parsed.autoCompactWindow : null;
  } catch {
    return null; // absent/unreadable/malformed settings file: no signal, not a crash
  }
}

// Local settings.local.json takes precedence over the project's shared
// settings.json, which takes precedence over the user's own — matching
// Claude Code's own settings-merge order. First one that sets
// autoCompactWindow wins.
function readAutoCompactWindowFromSettings(cwd = process.cwd(), homeDir = os.homedir()) {
  const candidates = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(homeDir, '.claude', 'settings.json'),
  ];
  for (const candidate of candidates) {
    const value = readAutoCompactWindowFrom(candidate);
    if (value != null) return value;
  }
  return null;
}

module.exports = {
  MODEL_CONTEXT_WINDOWS,
  contextWindowForModel,
  parseAutoCompactWindow,
  resolveContextWindow,
  readAutoCompactWindowFromSettings,
};
