import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import pg from 'pg';

let pool;
let initialized = false;
const keyText = process.env.SESSION_KEY || '';
const key = keyText ? Buffer.from(keyText, 'base64') : null;
if (key && key.length !== 32) throw new Error('SESSION_KEY must be 32 random bytes encoded as base64.');

async function db() {
  if (!process.env.DATABASE_URL) {
    return null;
  }
  if (!pool) pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 10000 });
  if (!initialized) {
    await pool.query('CREATE TABLE IF NOT EXISTS sdf_session (id integer PRIMARY KEY CHECK (id = 1), payload text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    initialized = true;
  }
  return pool;
}

function encrypt(value) {
  if (!key) throw new Error('SESSION_KEY is required for persistent sessions.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function decrypt(payload) {
  if (!key) throw new Error('SESSION_KEY is required for persistent sessions.');
  const raw = Buffer.from(payload, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
}

export async function loadSession() {
  const conn = await db();
  if (!conn) return null;
  const result = await conn.query('SELECT payload FROM sdf_session WHERE id = 1');
  return result.rows.length ? decrypt(result.rows[0].payload) : null;
}

export async function saveSession(value) {
  const conn = await db();
  if (!conn) return false;
  await conn.query('INSERT INTO sdf_session (id, payload) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()', [encrypt(value)]);
  return true;
}

