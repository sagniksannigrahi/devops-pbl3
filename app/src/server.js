// MediTrack - a tiny patient-records service used for the DevOps PBL-III tasks.
// Uses only Node.js built-ins (no npm dependencies) so the image stays small
// enough to build and run on a t3.micro (1 GB RAM).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = process.env.APP_VERSION || 'dev';
const PORT = Number(process.env.PORT || 3000);
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Demo data only - fictional patients, no real health information.
const patients = [
  { id: 1, name: 'Patient A', age: 34, department: 'Cardiology', status: 'Admitted' },
  { id: 2, name: 'Patient B', age: 58, department: 'Orthopaedics', status: 'Discharged' },
  { id: 3, name: 'Patient C', age: 21, department: 'General Medicine', status: 'Out-patient' },
];

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10_000) reject(new Error('payload too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(INDEX_HTML);
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { status: 'UP' });
    }

    if (req.method === 'GET' && url.pathname === '/api/info') {
      return sendJson(res, 200, {
        app: 'MediTrack',
        version: VERSION,
        pod: os.hostname(),
        time: new Date().toISOString(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/patients') {
      return sendJson(res, 200, patients);
    }

    if (req.method === 'POST' && url.pathname === '/api/patients') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.name || typeof body.name !== 'string') {
          return sendJson(res, 400, { error: 'name is required' });
        }
        const patient = {
          id: patients.length + 1,
          name: body.name.slice(0, 100),
          age: Number(body.age) || null,
          department: String(body.department || 'General Medicine').slice(0, 100),
          status: 'Admitted',
        };
        patients.push(patient);
        return sendJson(res, 201, patient);
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
    }

    return sendJson(res, 404, { error: 'not found' });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => console.log(`MediTrack v${VERSION} listening on port ${PORT}`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

module.exports = { createServer };
