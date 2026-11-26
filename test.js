'use strict';
// Ring of 12 boot smoke test (EE-2026-11-20-001).
// package.json already ran "node test.js", but the file did not exist, so
// "npm test" failed. This adds it. No keys, no network calls to any model:
// it starts the server on a free port with no LLM key, checks the public
// status routes answer, then stops it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = String(30000 + Math.floor(Math.random() * 20000));

function waitForListen(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in 20s')), 20000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('listening on port')) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('server exited early: ' + code)); });
  });
}

test('Ring of 12 starts and answers its status routes without keys', async () => {
  const env = { ...process.env, PORT };
  delete env.LLM_API_KEY;
  delete env.FIREWORKS_API_KEY;
  const child = spawn(process.execPath, [path.join(__dirname, 'start.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForListen(child);
    const root = await fetch(`http://127.0.0.1:${PORT}/`);
    assert.equal(root.status, 200);
    const body = await root.json();
    assert.equal(body.status, 'ok');
    assert.ok(Array.isArray(body.endpoints) && body.endpoints.includes('/ask'));
    assert.equal(body.llmConfigured, false);
    const quota = await fetch(`http://127.0.0.1:${PORT}/quota`);
    assert.equal(quota.status, 200);
  } finally {
    child.kill();
  }
});
