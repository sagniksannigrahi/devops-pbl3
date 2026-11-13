// Field-level encryption for Protected Health Information (PHI).
// AES-256-GCM gives confidentiality + integrity (tampered ciphertext fails to decrypt).
// The key comes from a Kubernetes Secret - it is never in the image or the git repo.

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function loadKey(hexKey) {
  if (!hexKey || !/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error('PHI_ENCRYPTION_KEY must be 64 hex characters (256-bit key)');
  }
  return Buffer.from(hexKey, 'hex');
}

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12); // unique IV per value
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

function decrypt(key, payload) {
  const [version, iv, tag, data] = String(payload).split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('invalid ciphertext');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { loadKey, encrypt, decrypt };
