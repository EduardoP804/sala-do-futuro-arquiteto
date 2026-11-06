/**
 * Optional MCP Streamable HTTP gateway for the local stdio agent.
 * Never expose without HTTPS, a strong token, and private access controls.
 * The default listener is restricted to loopback.
 */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOST = process.env.SDF_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.SDF_BRIDGE_PORT || 43187);
const SECRET = process.env.SDF_BRIDGE_TOKEN || '';
if (!SECRET || Buffer.byteLength(SECRET) < 32) {
  console.error('Defina SDF_BRIDGE_TOKEN com ao menos 32 caracteres aleatorios.');
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('Porta invalida');
if (!['127.0.0.1', '::1'].includes(HOST) && process.env.SDF_ALLOW_NETWORK !== 'yes') {
  throw new Error('Binding externo requer SDF_ALLOW_NETWORK=yes e controle HTTPS externo');
}

const child = spawn(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url))], {
  stdio: ['pipe', 'pipe', 'inherit'], env: process.env
});
let nextId = 0;
let stdoutBuffer = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', data => {
  stdoutBuffer += data;
  while (stdoutBuffer.includes('\n')) {
    const i = stdoutBuffer.indexOf('\n');
    const line = stdoutBuffer.slice(0, i).trim();
    stdoutBuffer = stdoutBuffer.slice(i + 1);
    try {
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    } catch { /* Ignore nonprotocol stdout lines. */ }
  }
});
function failAll() {
  for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(new Error('Agente local encerrado')); pending.delete(id); }
}
child.once('exit', failAll);
function forward(message) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return reject(new Error('Agente indisponivel'));
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Tempo limite na operacao local'));
    }, 120000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ ...message, id }) + '\n', err => {
      if (err) { const entry = pending.get(id); if (entry) { clearTimeout(entry.timer); pending.delete(id); reject(err); } }
    });
  });
}
function isAuthorized(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(SECRET);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function respond(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' });
  res.end(JSON.stringify(body));
}
const server = createServer(async (req, res) => {
  if (req.url !== '/mcp' || !['POST', 'GET'].includes(req.method)) return respond(res, 404, { error: 'not_found' });
  if (!isAuthorized(req.headers.authorization)) return respond(res, 401, { error: 'unauthorized' });
  if (req.method === 'GET') return respond(res, 405, { error: 'Use POST MCP JSON-RPC' });
  const origin = req.headers.origin;
  if (origin && !/^https:\/\//i.test(origin)) return respond(res, 403, { error: 'invalid_origin' });
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return respond(res, 415, { error: 'expected_json' });
  const parts = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > 1024 * 1024) return respond(res, 413, { error: 'request_too_large' });
    parts.push(part);
  }
  let msg;
  try { msg = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { return respond(res, 400, { error: 'invalid_json' }); }
  if (!msg || Array.isArray(msg) || typeof msg !== 'object' || typeof msg.method !== 'string') return respond(res, 400, { error: 'invalid_rpc' });
  if (!Object.hasOwn(msg, 'id')) return res.writeHead(202, { 'cache-control': 'no-store' }).end();
  try {
    const output = await forward(msg);
    // Reattach the caller's id, which must not be exposed to the stdio process.
    respond(res, 200, { ...output, id: msg.id });
  } catch { respond(res, 503, { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Operacao local indisponivel ou expirada' } }); }
});
server.requestTimeout = 130000;
server.listen(PORT, HOST, () => console.log(`Gateway MCP local ativo em http://${HOST}:${PORT}/mcp`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); child.kill(signal); });
