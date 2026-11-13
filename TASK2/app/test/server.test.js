const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../src/server');

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('GET /health returns UP', async () => {
  const res = await fetch(`${base}/health`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).status, 'UP');
});

test('GET /api/info returns app name and version', async () => {
  const body = await (await fetch(`${base}/api/info`)).json();
  assert.strictEqual(body.app, 'MediTrack');
  assert.ok(body.version);
});

test('GET /api/info reports the blue/green color', async () => {
  const body = await (await fetch(`${base}/api/info`)).json();
  assert.ok(['blue', 'green'].includes(body.color));
});

test('GET /api/patients returns a list', async () => {
  const body = await (await fetch(`${base}/api/patients`)).json();
  assert.ok(Array.isArray(body));
  assert.ok(body.length >= 3);
});

test('POST /api/patients creates a patient', async () => {
  const res = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Patient D', age: 40, department: 'Neurology' }),
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual((await res.json()).name, 'Patient D');
});

test('POST /api/patients rejects missing name', async () => {
  const res = await fetch(`${base}/api/patients`, { method: 'POST', body: '{}' });
  assert.strictEqual(res.status, 400);
});

test('unknown route returns 404', async () => {
  const res = await fetch(`${base}/nope`);
  assert.strictEqual(res.status, 404);
});
