'use strict';

// opencode loads config-file plugins through readV1Plugin + getLegacyPlugins
// (packages/opencode/src/plugin). This test mirrors that loader contract for
// the plugin module, so a loading regression can't pass while the plugin
// silently never registers. The other plugin tests drive the hooks directly —
// they never import the module the way opencode does, which is why the
// previous named-exports-only shape passed every test yet failed to load.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const PLUGIN_PATH = path.join(__dirname, '..', '..', 'harnesses', 'opencode', 'plugin.js');

function isRecord(value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

// Faithful copy of opencode's readV1Plugin(mod, spec, "server", "detect").
function readV1Plugin(mod) {
  const value = mod.default;
  if (!isRecord(value)) return undefined;
  if (!('id' in value) && !('server' in value) && !('tui' in value)) return undefined;
  const server = 'server' in value ? value.server : undefined;
  if (server !== undefined && typeof server !== 'function') {
    throw new TypeError('Plugin has invalid server export');
  }
  return value;
}

// opencode's applyPlugin server path: v1 default export wins; the legacy
// path (every export must be a function) is only reached when v1 is absent.
async function applyServerPlugin(mod, input) {
  const v1 = readV1Plugin(mod);
  assert.ok(v1, 'plugin must load via the v1 server path');
  return v1.server(input, undefined);
}

describe('opencode plugin loader contract', () => {
  test('readV1Plugin detects the v1 id/server export', async () => {
    const mod = await import(pathToFileURL(PLUGIN_PATH).href);
    const v1 = readV1Plugin(mod);
    assert.ok(v1, 'default export must carry id and server');
    assert.equal(v1.id, 'warden');
    assert.equal(typeof v1.server, 'function');
  });

  test('applying the plugin registers the event, transform, and tool hooks', async () => {
    const mod = await import(pathToFileURL(PLUGIN_PATH).href);
    const hooks = await applyServerPlugin(mod, { client: undefined });
    assert.equal(typeof hooks.event, 'function');
    assert.equal(typeof hooks['experimental.chat.system.transform'], 'function');
    assert.equal(typeof hooks['tool.execute.before'], 'function');
  });

  test('named CommonJS exports stay require()able for the plugin tests', () => {
    const helpers = require(PLUGIN_PATH);
    assert.equal(typeof helpers.WardenPlugin, 'function');
    assert.equal(typeof helpers.createSessionEvaluator, 'function');
    assert.equal(typeof helpers.showToastForAction, 'function');
    assert.equal(typeof helpers.respondFor, 'function');
    assert.equal(helpers.server, helpers.WardenPlugin);
  });
});
