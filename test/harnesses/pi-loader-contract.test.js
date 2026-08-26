'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createJiti } = require('jiti');

// Reproduces the exact loader path in @earendil-works/pi-coding-agent
// dist/core/extensions/loader.js: `await jiti.import(extensionPath, { default: true })`
// followed by `typeof factory !== 'function'`. jiti's `{ default: true }` does not
// unwrap a hand-written `.default` on a CommonJS object export — it returns
// module.exports whole — so the export shape itself, not require(), is the contract.
describe('pi extension loader contract', () => {
  test('jiti default-import resolves to a callable factory', async () => {
    const jiti = createJiti(__filename);
    const extensionPath = path.join(__dirname, '../../harnesses/pi/extension.js');
    const factory = await jiti.import(extensionPath, { default: true });
    assert.equal(typeof factory, 'function');
  });
});
