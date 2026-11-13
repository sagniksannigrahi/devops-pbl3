'use strict';
// No inline scripts (allowed by the strict Content-Security-Policy). All output uses textContent (no XSS).

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function setStatus(text, ok) {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = ok ? 'ok' : 'err';
}

async function loadPatients(event) {
  event.preventDefault();
  const token = document.getElementById('token').value.trim();
  const rows = document.getElementById('rows');
  const res = await fetch('/api/patients', { headers: { Authorization: 'Bearer ' + token } });
  const body = await res.json();
  rows.replaceChildren();
  if (!res.ok) {
    setStatus('HTTP ' + res.status + ': ' + body.error, false);
    return;
  }
  const masked = body.some((p) => p.diagnosis === '[REDACTED]');
  setStatus(masked ? 'Signed in as STAFF: PHI is masked (minimum necessary access)' : 'Signed in as DOCTOR: full clinical record', true);
  body.forEach((p) => {
    const tr = document.createElement('tr');
    [p.id, p.name, p.age, p.department, p.phone, p.diagnosis].forEach((v) => tr.appendChild(cell(v)));
    rows.appendChild(tr);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login').addEventListener('submit', (e) => {
    loadPatients(e).catch(() => setStatus('Request failed', false));
  });
  fetch('/api/info').then((r) => r.json()).then((i) => {
    document.getElementById('version').textContent = i.app + ' - version ' + i.version;
  });
});
