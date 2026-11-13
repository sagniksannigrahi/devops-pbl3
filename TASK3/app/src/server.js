// MediTrack Secure - patient-records service hardened for a healthcare (HIPAA-style) environment.
//
// Security controls implemented in the application:
//   1. Authentication      - Bearer tokens (from a Kubernetes Secret), compared in constant time
//   2. Authorisation (RBAC)- "doctor" sees full records and can create them; "staff" sees masked PHI only
//   3. Encryption at rest  - PHI fields (name, phone, diagnosis) stored AES-256-GCM encrypted
//   4. Audit logging       - every PHI access is logged as JSON (who / what / when / result) WITHOUT PHI values
//   5. Brute-force defence - too many failed logins from one IP -> HTTP 429
//   6. Input validation    - strict allow-lists, size limits, JSON-only, generic error messages
//   7. Security headers    - CSP, no-sniff, frame-deny, no-referrer, HSTS, no-store caching for PHI
// Uses only Node.js built-ins: zero third-party dependencies = zero dependency CVEs.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const phi = require('./phi-crypto');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};
const DEPARTMENTS = ['Cardiology', 'Orthopaedics', 'General Medicine', 'Neurology', 'Paediatrics', 'Oncology'];
const MAX_BODY_BYTES = 4 * 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// constant-time comparison so response timing does not leak the token
function tokenMatches(given, expected) {
  return Boolean(given) && Boolean(expected) && crypto.timingSafeEqual(sha256(given), sha256(expected));
}

function maskName(name) {
  return name.split(/\s+/).map((part) => part[0] + '*'.repeat(Math.max(part.length - 1, 2))).join(' ');
}

function maskPhone(phone) {
  return '*'.repeat(Math.max(phone.length - 4, 0)) + phone.slice(-4);
}

function createServer(options = {}) {
  const config = {
    version: options.version || process.env.APP_VERSION || 'dev',
    doctorToken: options.doctorToken || process.env.DOCTOR_TOKEN,
    staffToken: options.staffToken || process.env.STAFF_TOKEN,
    key: phi.loadKey(options.encryptionKey || process.env.PHI_ENCRYPTION_KEY),
    maxFailedLogins: Number(options.maxFailedLogins || process.env.MAX_FAILED_LOGINS || 10),
    lockoutMs: Number(options.lockoutMs || 60_000),
    audit: options.audit || ((entry) => console.log(JSON.stringify(entry))),
  };
  // fail closed: refuse to start without credentials
  if (!config.doctorToken || !config.staffToken || config.doctorToken === config.staffToken) {
    throw new Error('DOCTOR_TOKEN and STAFF_TOKEN must be set and different');
  }

  const staticCache = {};
  for (const [route, meta] of Object.entries(STATIC_FILES)) {
    staticCache[route] = fs.readFileSync(path.join(PUBLIC_DIR, meta.file));
  }

  // ---- encrypted in-memory store (demo data: fictional patients) ----
  const store = [];
  function addPatient({ name, age, department, phone, diagnosis }) {
    const record = {
      id: store.length + 1,
      age,
      department,
      name: phi.encrypt(config.key, name),
      phone: phi.encrypt(config.key, phone),
      diagnosis: phi.encrypt(config.key, diagnosis),
      createdAt: new Date().toISOString(),
    };
    store.push(record);
    return record;
  }
  addPatient({ name: 'Asha Verma', age: 34, department: 'Cardiology', phone: '9876501234', diagnosis: 'Hypertension stage 1' });
  addPatient({ name: 'Rahul Mehta', age: 58, department: 'Orthopaedics', phone: '9123405678', diagnosis: 'Knee osteoarthritis' });
  addPatient({ name: 'Neha Iyer', age: 21, department: 'General Medicine', phone: '9988776655', diagnosis: 'Seasonal influenza' });

  function view(record, role) {
    const name = phi.decrypt(config.key, record.name);
    const phone = phi.decrypt(config.key, record.phone);
    if (role === 'doctor') {
      return { id: record.id, name, age: record.age, department: record.department, phone,
        diagnosis: phi.decrypt(config.key, record.diagnosis) };
    }
    // minimum-necessary principle: non-clinical staff never see the diagnosis
    return { id: record.id, name: maskName(name), age: record.age, department: record.department,
      phone: maskPhone(phone), diagnosis: '[REDACTED]' };
  }

  // ---- brute-force protection: failed logins per client IP ----
  const failures = new Map();
  function isLockedOut(ip) {
    const f = failures.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > config.lockoutMs) { failures.delete(ip); return false; }
    return f.count >= config.maxFailedLogins;
  }
  function recordFailure(ip) {
    const f = failures.get(ip);
    if (!f || Date.now() - f.since > config.lockoutMs) failures.set(ip, { count: 1, since: Date.now() });
    else f.count += 1;
  }

  function authenticate(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (tokenMatches(token, config.doctorToken)) return 'doctor';
    if (tokenMatches(token, config.staffToken)) return 'staff';
    return null;
  }

  function send(res, status, body, type = 'application/json') {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        return reject(Object.assign(new Error('Content-Type must be application/json'), { status: 415 }));
      }
      const tooLarge = () => Object.assign(new Error('Request body too large'), { status: 413 });
      if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) {
        req.resume(); // discard the body
        return reject(tooLarge());
      }
      let size = 0;
      let overflow = false;
      const chunks = [];
      req.on('data', (chunk) => {
        if (overflow) return; // keep draining, stop storing
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { overflow = true; reject(tooLarge()); }
        else chunks.push(chunk);
      });
      req.on('end', () => {
        if (overflow) return;
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
      });
      req.on('error', () => reject(Object.assign(new Error('Bad request'), { status: 400 })));
    });
  }

  function validatePatient(body) {
    const errors = [];
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!/^[A-Za-z][A-Za-z .'-]{1,79}$/.test(name)) errors.push('name: 2-80 letters');
    const age = Number(body.age);
    if (!Number.isInteger(age) || age < 0 || age > 130) errors.push('age: integer 0-130');
    if (!DEPARTMENTS.includes(body.department)) errors.push(`department: one of ${DEPARTMENTS.join(', ')}`);
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!/^[0-9]{10}$/.test(phone)) errors.push('phone: 10 digits');
    const diagnosis = typeof body.diagnosis === 'string' ? body.diagnosis.trim() : '';
    if (diagnosis.length < 2 || diagnosis.length > 200 || /[<>]/.test(diagnosis)) errors.push('diagnosis: 2-200 chars, no < >');
    return { errors, value: { name, age, department: body.department, phone, diagnosis } };
  }

  return http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress;
    const url = new URL(req.url, 'http://localhost');
    const audit = (action, role, status, extra = {}) =>
      config.audit({ ts: new Date().toISOString(), type: 'AUDIT', action, role: role || 'anonymous', ip, status, ...extra });

    try {
      if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
        return send(res, 200, staticCache[url.pathname], STATIC_FILES[url.pathname].type);
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { status: 'UP' });
      }
      if (req.method === 'GET' && url.pathname === '/api/info') {
        return send(res, 200, { app: 'MediTrack Secure', version: config.version });
      }

      if (url.pathname.startsWith('/api/patients')) {
        if (isLockedOut(ip)) {
          audit('LOGIN_LOCKOUT', null, 429);
          return send(res, 429, { error: 'Too many failed login attempts. Try again later.' });
        }
        const role = authenticate(req);
        if (!role) {
          recordFailure(ip);
          audit('LOGIN_FAILED', null, 401, { path: url.pathname });
          return send(res, 401, { error: 'Authentication required' });
        }

        if (req.method === 'GET' && url.pathname === '/api/patients') {
          audit('PHI_LIST', role, 200, { records: store.length, masked: role !== 'doctor' });
          return send(res, 200, store.map((r) => view(r, role)));
        }

        const match = url.pathname.match(/^\/api\/patients\/(\d{1,6})$/);
        if (req.method === 'GET' && match) {
          const record = store.find((r) => r.id === Number(match[1]));
          if (!record) { audit('PHI_READ', role, 404, { patientId: Number(match[1]) }); return send(res, 404, { error: 'Not found' }); }
          audit('PHI_READ', role, 200, { patientId: record.id, masked: role !== 'doctor' });
          return send(res, 200, view(record, role));
        }

        if (req.method === 'POST' && url.pathname === '/api/patients') {
          if (role !== 'doctor') {
            audit('PHI_CREATE_DENIED', role, 403);
            return send(res, 403, { error: 'Only doctors can create patient records' });
          }
          const { errors, value } = validatePatient(await readJson(req));
          if (errors.length) { audit('PHI_CREATE_INVALID', role, 400); return send(res, 400, { error: 'Validation failed', details: errors }); }
          const record = addPatient(value);
          audit('PHI_CREATE', role, 201, { patientId: record.id });
          return send(res, 201, view(record, role));
        }
        return send(res, 405, { error: 'Method not allowed' });
      }

      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      // never leak stack traces or internal details to the client
      const status = err.status || 500;
      if (status === 500) console.error(JSON.stringify({ ts: new Date().toISOString(), type: 'ERROR', message: err.message }));
      return send(res, status, { error: status === 500 ? 'Internal server error' : err.message });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const server = createServer();
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.listen(port, () => console.log(JSON.stringify({ type: 'START', app: 'MediTrack Secure', port })));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

module.exports = { createServer, maskName, maskPhone };
