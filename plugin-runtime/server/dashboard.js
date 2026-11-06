import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as taskApi from './task-api.js';

const htmlPath = fileURLToPath(new URL('./dashboard.html', import.meta.url));
const cssPath = fileURLToPath(new URL('./dashboard.css', import.meta.url));
const jsPath = fileURLToPath(new URL('./dashboard-client.js', import.meta.url));
const secret = randomBytes(32).toString('hex');
let server;
let base;
let loginState = { status: 'not_authenticated' };
let khanAdapter;
let khanState = { status: 'not_connected' };
let khanCredentials;
let khanAccountKey;

export function rememberKhanCredentials(login) {
  const nextKey = createHash('sha256').update(`${String(login.ra).trim()}:${String(login.digit).trim()}:${String(login.uf).toUpperCase()}`).digest('hex').slice(0, 16);
  if (khanAccountKey !== nextKey) khanState = { status: 'not_connected' };
  khanAccountKey = nextKey;
  khanCredentials = { value: { ra: login.ra, digit: login.digit, uf: login.uf, password: login.password }, expires: Date.now() + 15 * 60 * 1000 };
}

export function currentKhanAccountKey() { return khanAccountKey; }

export function khanLoginCredentials() {
  if (!khanCredentials || khanCredentials.expires < Date.now()) { khanCredentials = undefined; return null; }
  return khanCredentials.value;
}

export function clearKhanCredentials() { khanCredentials = undefined; }
export function resetKhanState() { khanState = { status: 'not_connected' }; }
export function setKhanAdapter(adapter) { khanAdapter = adapter; }

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function cookieValid(req) {
  const actual = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('sdf_session='))?.slice(12) || '';
  if (actual.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(secret));
}

function sameOrigin(req) {
  return req.headers.origin === base;
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error('Dados de login muito grandes.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handle(req, res) {
  const url = new URL(req.url, base);
  if (url.pathname === '/unlock' && req.method === 'GET') {
    if (url.searchParams.get('key') !== secret) return json(res, 403, { error: 'Acesso negado.' });
    res.writeHead(302, { location: '/', 'set-cookie': `sdf_session=${secret}; HttpOnly; SameSite=Strict; Path=/`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    return res.end();
  }
  if (!cookieValid(req)) return json(res, 403, { error: 'Abra o painel pelo link fornecido pelo plugin.' });
  if (req.method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: 'Origem inválida.' });
  if (req.method === 'GET' && ['/','/dashboard.css','/dashboard-client.js'].includes(url.pathname)) {
    const [path, type] = url.pathname === '/' ? [htmlPath, 'text/html'] : url.pathname === '/dashboard.css' ? [cssPath, 'text/css'] : [jsPath, 'text/javascript'];
    const data = await readFile(path);
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'content-length': data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'" });
    return res.end(data);
  }
  if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, loginState);
  if (url.pathname === '/api/login' && req.method === 'POST') {
    if (loginState.status === 'loading') return json(res, 409, { error: 'Login em andamento.' });
    const { ra, digit, uf, password } = await bodyJson(req);
    loginState = { status: 'loading' };
    try {
      const list = await taskApi.exclusive(() => taskApi.loginAndList({ ra, digit, uf, password }));
      rememberKhanCredentials({ ra, digit, uf, password });
      loginState = { status: 'authenticated', counts: list.counts, activities: { pending: list.pending, drafts: list.drafts, expired: list.expired } };
      return json(res, 200, loginState);
    } catch (error) {
      loginState = { status: 'error', message: error.message };
      return json(res, 400, loginState);
    }
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    try {
      const list = await taskApi.exclusive(() => taskApi.listActivities());
      loginState = { status: 'authenticated', counts: list.counts, activities: { pending: list.pending, drafts: list.drafts, expired: list.expired } };
      return json(res, 200, loginState);
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (url.pathname === '/api/khan/state' && req.method === 'GET') return json(res, 200, khanState);
  if (url.pathname === '/api/khan/connect' && req.method === 'POST') {
    if (!khanAdapter) return json(res, 503, { error: 'Integração Khan indisponível.' });
    if (khanState.status === 'connecting') return json(res, 409, { error: 'Conexão em andamento.' });
    khanState = { status: 'connecting' };
    try { khanState = await khanAdapter.connect(); return json(res, 200, khanState); }
    catch (error) { khanState = { status: 'error', message: error.message }; return json(res, 400, khanState); }
  }
  if (url.pathname === '/api/khan/refresh' && req.method === 'POST') {
    if (!khanAdapter) return json(res, 503, { error: 'Integração Khan indisponível.' });
    try { khanState = await khanAdapter.list({ fresh: true }); return json(res, 200, khanState); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (url.pathname === '/api/khan/unit' && req.method === 'POST') {
    if (!khanAdapter?.unit) return json(res, 503, { error: 'Leitura da unidade indisponível.' });
    try {
      const { course_index, unit_index } = await bodyJson(req);
      if (!Number.isInteger(course_index) || !Number.isInteger(unit_index) || course_index < 0 || unit_index < 0) return json(res, 400, { error: 'Unidade inválida.' });
      return json(res, 200, await khanAdapter.unit({ course_index, unit_index }));
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  return json(res, 404, { error: 'Página inexistente.' });
}

export async function openDashboard({ openBrowser = true } = {}) {
  if (!server) {
    server = createServer((req, res) => handle(req, res).catch(error => json(res, 500, { error: error.message })));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const url = `${base}/unlock?key=${secret}`;
  if (openBrowser && process.platform === 'win32') {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  }
  return { status: 'ready', url, login_status: loginState.status, opened: openBrowser && process.platform === 'win32' };
}

export function dashboardState() { return loginState; }

export function setDashboardList(list) {
  loginState = { status: 'authenticated', counts: list.counts, activities: { pending: list.pending, drafts: list.drafts, expired: list.expired } };
}

export async function waitForDashboardLogin({ timeout_seconds = 30 } = {}) {
  const seconds = Math.min(60, Math.max(1, Number(timeout_seconds) || 30));
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until && loginState.status !== 'authenticated' && loginState.status !== 'error') {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return loginState;
}
