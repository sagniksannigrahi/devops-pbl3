// Functional + security tests. Run in the pipeline by `docker build --target test`.
// Test credentials below are dummy, low-entropy values used only in tests.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createServer, maskName, maskPhone } = require('../src/server');
const phi = require('../src/phi-crypto');

const DOCTOR = 'doctor-test';
const STAFF = 'staff-test';
const KEY = 'a'.repeat(64);
const auditLog = [];
let server;
let base;

const get = (path, token) =>
  fetch(base + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
const post = (path, token, body, type = 'application/json') =>
  fetch(base + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': type },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

before(async () => {
  server = createServer({
    doctorToken: DOCTOR, staffToken: STAFF, encryptionKey: KEY,
    maxFailedLogins: 50, audit: (e) => auditLog.push(e),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// ---------- basics ----------
test('health check is public', async () => {
  const res = await get('/health');
  assert.strictEqual(res.status, 200);
});

test('security headers are set on every response', async () => {
  for (const path of ['/', '/health', '/api/patients']) {
    const res = await get(path);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    assert.strictEqual(res.headers.get('x-powered-by'), null);
  }
});

// ---------- authentication ----------
test('patient data requires authentication', async () => {
  assert.strictEqual((await get('/api/patients')).status, 401);
  assert.strictEqual((await get('/api/patients', 'wrong-token')).status, 401);
});

// ---------- authorisation / minimum necessary ----------
test('doctor sees the full clinical record', async () => {
  const body = await (await get('/api/patients', DOCTOR)).json();
  assert.strictEqual(body[0].name, 'Asha Verma');
  assert.strictEqual(body[0].diagnosis, 'Hypertension stage 1');
});

test('staff sees masked PHI and no diagnosis', async () => {
  const body = await (await get('/api/patients', STAFF)).json();
  assert.strictEqual(body[0].diagnosis, '[REDACTED]');
  assert.notStrictEqual(body[0].name, 'Asha Verma');
  assert.match(body[0].phone, /^\*+1234$/);
});

test('staff cannot create records (403)', async () => {
  const res = await post('/api/patients', STAFF, { name: 'Test Person', age: 30, department: 'Neurology', phone: '9000000000', diagnosis: 'Migraine' });
  assert.strictEqual(res.status, 403);
});

test('doctor can create a valid record', async () => {
  const res = await post('/api/patients', DOCTOR, { name: 'Test Person', age: 30, department: 'Neurology', phone: '9000000000', diagnosis: 'Migraine' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual((await res.json()).diagnosis, 'Migraine');
});

// ---------- input validation ----------
test('invalid input is rejected with 400', async () => {
  const res = await post('/api/patients', DOCTOR, { name: '<script>alert(1)</script>', age: -5, department: 'Hackers', phone: 'abc', diagnosis: '<b>' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).details.length, 5);
});

test('malformed JSON returns 400 without a stack trace', async () => {
  const res = await post('/api/patients', DOCTOR, '{"name": ');
  const text = await res.text();
  assert.strictEqual(res.status, 400);
  assert.doesNotMatch(text, /at .*\.js|SyntaxError/);
});

test('non-JSON content type is rejected (415)', async () => {
  assert.strictEqual((await post('/api/patients', DOCTOR, 'name=x', 'text/plain')).status, 415);
});

test('oversized body is rejected (413)', async () => {
  const res = await post('/api/patients', DOCTOR, { name: 'A'.repeat(10_000) });
  assert.strictEqual(res.status, 413);
});

test('unknown routes and path traversal return 404', async () => {
  assert.strictEqual((await get('/../../etc/passwd')).status, 404);
  assert.strictEqual((await get('/api/patients/999', DOCTOR)).status, 404);
});

// ---------- encryption at rest ----------
test('PHI encryption round-trips and is randomised', () => {
  const key = phi.loadKey(KEY);
  const a = phi.encrypt(key, 'Diabetes type 2');
  const b = phi.encrypt(key, 'Diabetes type 2');
  assert.notStrictEqual(a, b); // random IV
  assert.ok(!a.includes('Diabetes'));
  assert.strictEqual(phi.decrypt(key, a), 'Diabetes type 2');
});

test('tampered ciphertext is detected', () => {
  const key = phi.loadKey(KEY);
  const parts = phi.encrypt(key, 'secret').split(':');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => phi.decrypt(key, parts.join(':')));
});

test('weak or missing keys and tokens are refused (fail closed)', () => {
  assert.throws(() => phi.loadKey('short'));
  assert.throws(() => createServer({ doctorToken: 'x', staffToken: 'x', encryptionKey: KEY }));
});

// ---------- audit logging ----------
test('audit log records access but never PHI values', async () => {
  await get('/api/patients', DOCTOR);
  const entries = auditLog.filter((e) => e.action === 'PHI_LIST');
  assert.ok(entries.length > 0);
  assert.ok(entries.some((e) => e.role === 'doctor'));
  const all = JSON.stringify(auditLog);
  assert.ok(!all.includes('Asha') && !all.includes('Hypertension') && !all.includes('9876501234'));
  assert.ok(auditLog.some((e) => e.action === 'LOGIN_FAILED'));
});

// ---------- brute force ----------
test('repeated failed logins are locked out (429)', async () => {
  const s = createServer({ doctorToken: DOCTOR, staffToken: STAFF, encryptionKey: KEY, maxFailedLogins: 3, audit: () => {} });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/api/patients`;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(url, { headers: { Authorization: 'Bearer bad' } })).status);
  s.close();
  assert.deepStrictEqual(codes, [401, 401, 401, 429, 429]);
});

test('masking helpers', () => {
  assert.strictEqual(maskName('Asha Verma'), 'A*** V****');
  assert.strictEqual(maskPhone('9876501234'), '******1234');
});
