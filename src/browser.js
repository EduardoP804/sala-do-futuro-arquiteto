import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { loadSession, saveSession } from './state.js';

const ORIGIN = 'https://saladofuturo.educacao.sp.gov.br';
const SELECTOR = '[data-sdf-agent-id]';
let browser;
let context;
let page;
let revision = 0;
let mappedUrl = '';
let targets = new Map();
let lastSubmissionBefore = null;
let queue = Promise.resolve();
let apiAuth;
let gatewayPage;

export function exclusive(fn) {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

function assertOrigin() {
  if (!page || page.isClosed()) throw new Error('No browser session. Call open_session.');
  if (new URL(page.url()).origin !== ORIGIN) throw new Error('Navigation left the allowed origin.');
}

async function ensureBrowser() {
  if (page && !page.isClosed()) return;
  const saved = await loadSession();
  browser = await chromium.launch({ headless: process.env.SDF_HEADED !== '1', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false, ...(saved?.storageState ? { storageState: saved.storageState } : {}) });
  if (saved?.sessionStorage) {
    await context.addInitScript(({ origin, items }) => {
      if (location.origin === origin) for (const [k, v] of items) sessionStorage.setItem(k, v);
    }, { origin: ORIGIN, items: saved.sessionStorage });
  }
  page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
}

async function persist() {
  const previous = await loadSession();
  const storageState = await context.storageState({ indexedDB: true });
  const sessionStorage = await page.evaluate(() => Object.entries(sessionStorage));
  await saveSession({ ...previous, storageState, sessionStorage });
}

export async function directLogin({ ra, digit, uf, password }) {
  if (!/^\d{1,12}$/.test(ra) || !/^[0-9Xx]$/.test(digit) || !/^[A-Z]{2}$/.test(uf)) throw new Error('Invalid RA, digit, or UF format.');
  const probeBrowser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let subscriptionKey;
  try {
    const probePage = await probeBrowser.newPage();
    const configRequest = probePage.waitForRequest(request => new URL(request.url()).pathname.endsWith('/api/configuracoes'), { timeout: 15000 });
    await probePage.goto(`${ORIGIN}/login-alunos`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    subscriptionKey = (await configRequest).headers()['ocp-apim-subscription-key'];
    if (!subscriptionKey) throw new Error('Official API configuration was not observed.');
  } finally { await probeBrowser.close(); }
  const response = await fetch('https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken', {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', 'ocp-apim-subscription-key': subscriptionKey, 'x-product-name': 'SalaDoFuturo', origin: ORIGIN },
    body: JSON.stringify({ user: ra + digit + uf, senha: password })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) return { status: 'login_failed', http_status: response.status, message: data.statusRetorno || 'Authentication failed.' };
  const previous = await loadSession();
  apiAuth = { token: data.token, tokenResumo: data.tokenResumo, user: data.DadosUsuario, subscriptionKey, authenticatedAt: new Date().toISOString() };
  const persisted = await saveSession({ ...previous, apiAuth });
  return { status: persisted ? 'authenticated_api' : 'authenticated_api_ephemeral', profile_count: data.DadosUsuario?.PERFIS?.length || 0, user_id_present: !!data.DadosUsuario?.CD_USUARIO };
}

export async function apiSessionStatus() {
  const auth = apiAuth || (await loadSession())?.apiAuth;
  return { status: auth?.token ? 'authenticated_api' : 'login_required', profile_count: auth?.user?.PERFIS?.length || 0 };
}

export async function diagnoseTaskApi() {
  const auth = apiAuth || (await loadSession())?.apiAuth;
  if (!auth?.token) throw new Error('Call direct_login first.');
  const response = await fetch('https://edusp-api.ip.tv/registration/edusp/token', {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-platform': 'webclient', 'x-api-realm': 'edusp', origin: ORIGIN, referer: `${ORIGIN}/` },
    body: JSON.stringify({ token: auth.token })
  });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('json') ? await response.json().catch(() => ({})) : {};
  if (response.ok && data.auth_token) {
    apiAuth = { ...auth, iptvToken: data.auth_token, nick: data.nick };
    await saveSession({ ...(await loadSession()), apiAuth });
  }
  return { http_status: response.status, server: response.headers.get('server') || null, challenge_page: response.status === 403 && type.includes('html'), task_token_ready: !!apiAuth?.iptvToken };
}

export async function diagnoseSedTaskToken() {
  const auth = apiAuth || (await loadSession())?.apiAuth;
  if (!auth?.token) throw new Error('Call direct_login first.');
  const endpoint = 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/integracoes/Token?plataforma=TarefaSP';
  const variants = [
    ['login_token', auth.token],
    ['summary_token', auth.tokenResumo]
  ].filter(([, value]) => typeof value === 'string' && value.length > 0);
  const results = [];
  for (const [variant, value] of variants) {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(15000),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${value}`,
        'ocp-apim-subscription-key': auth.subscriptionKey,
        'x-product-name': 'SalaDoFuturo',
        origin: ORIGIN
      }
    });
    const type = response.headers.get('content-type') || '';
    const body = await response.text();
    results.push({ variant, http_status: response.status, content_type: type.split(';')[0], body_kind: body.startsWith('{') ? 'object' : body.startsWith('[') ? 'array' : 'text', nonempty: body.length > 0 });
  }
  return { results };
}

export async function probeHeadedTaskApi() {
  const auth = apiAuth || (await loadSession())?.apiAuth;
  if (!auth?.token) throw new Error('Call direct_login first.');
  const display = ':77';
  let xvfbError = '';
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe'] });
  xvfb.on('error', error => { xvfbError = error.message; });
  xvfb.stderr.on('data', chunk => { xvfbError = (xvfbError + chunk.toString()).slice(-500); });
  let probeBrowser;
  try {
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (xvfbError || xvfb.exitCode !== null) return { stage: 'xvfb', error: xvfbError || `exit_${xvfb.exitCode}` };
    probeBrowser = await chromium.launch({ headless: false, env: { ...process.env, DISPLAY: display }, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const probePage = await probeBrowser.newPage();
    const landing = await probePage.goto('https://edusp-api.ip.tv/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await probePage.waitForTimeout(12000);
    const result = await probePage.evaluate(async sedToken => {
      const exchange = await fetch('/registration/edusp/token', {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json', 'x-api-platform': 'webclient', 'x-api-realm': 'edusp' },
        body: JSON.stringify({ token: sedToken })
      });
      const type = exchange.headers.get('content-type') || '';
      const data = type.includes('json') ? await exchange.json().catch(() => ({})) : {};
      if (!exchange.ok || !data.auth_token) return { exchange_status: exchange.status, exchange_type: type.split(';')[0], token_ready: false };
      const headers = { 'x-api-key': data.auth_token, 'x-api-platform': 'webclient', 'x-api-realm': 'edusp' };
      const roomResponse = await fetch('/room/user?list_all=true&with_cards=true', { headers, signal: AbortSignal.timeout(20000) });
      const roomData = roomResponse.ok ? await roomResponse.json().catch(() => ({})) : {};
      const rooms = Array.isArray(roomData.rooms) ? roomData.rooms : [];
      const params = new URLSearchParams({ expired_only: 'false', limit: '100', offset: '0', filter_expired: 'true', is_exam: 'false', with_answer: 'true', is_essay: 'false', with_apply_moment: 'true' });
      for (const room of rooms) {
        if (room.name) {
          params.append('publication_target', room.name);
          if (data.nick) params.append('publication_target', `${room.name}:${data.nick}`);
        }
        for (const category of room.group_categories || []) if (category.id) params.append('publication_target', String(category.id));
      }
      const taskResponse = await fetch(`/tms/task/todo?${params}`, { headers, signal: AbortSignal.timeout(20000) });
      const tasks = taskResponse.ok ? await taskResponse.json().catch(() => null) : null;
      return { exchange_status: exchange.status, token_ready: true, room_status: roomResponse.status, room_count: rooms.length, task_status: taskResponse.status, task_count: Array.isArray(tasks) ? tasks.length : null };
    }, auth.token);
    return { stage: 'complete', landing_status: landing?.status() || null, final_host: new URL(probePage.url()).hostname, title: (await probePage.title()).slice(0, 100), ...result };
  } finally {
    if (probeBrowser) await probeBrowser.close().catch(() => {});
    xvfb.kill();
  }
}

export async function inspectTaskGateway() {
  const auth = apiAuth || (await loadSession())?.apiAuth;
  if (!auth?.token) throw new Error('Call direct_login first.');
  await ensureBrowser();
  if (gatewayPage && !gatewayPage.isClosed()) await gatewayPage.close();
  gatewayPage = await context.newPage();
  const integration = new URL('https://cmspweb.ip.tv/integration');
  integration.searchParams.set('provider', 'seducsp_token');
  integration.searchParams.set('token', auth.token);
  let response;
  let navigationError = null;
  try {
    response = await gatewayPage.goto(integration.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (error) {
    navigationError = error.name;
  }
  await gatewayPage.waitForTimeout(5000);
  const body = await gatewayPage.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const controls = await gatewayPage.locator('input, button, iframe').evaluateAll(elements =>
    elements.slice(0, 25).map(el => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 100),
      visible: !!(el.getBoundingClientRect().width && el.getBoundingClientRect().height)
    }))
  ).catch(() => []);
  const screenshot = (await gatewayPage.screenshot({ type: 'png', fullPage: false })).toString('base64');
  return {
    metadata: {
      http_status: response?.status() || null,
      navigation_error: navigationError,
      final_host: new URL(gatewayPage.url()).hostname,
      title: (await gatewayPage.title()).slice(0, 120),
      body_excerpt: body.slice(0, 700),
      controls
    },
    screenshot
  };
}

export async function waitTaskGateway({ seconds = 25 } = {}) {
  if (!gatewayPage || gatewayPage.isClosed()) throw new Error('Call inspect_task_gateway first.');
  await gatewayPage.waitForTimeout(Math.min(Math.max(seconds, 1), 30) * 1000);
  const body = await gatewayPage.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const screenshot = (await gatewayPage.screenshot({ type: 'png', fullPage: false })).toString('base64');
  return {
    metadata: {
      final_host: new URL(gatewayPage.url()).hostname,
      title: (await gatewayPage.title()).slice(0, 120),
      body_excerpt: body.slice(0, 700),
      interactive_controls: await gatewayPage.locator('input:not([type="hidden"]), button, iframe').count()
    },
    screenshot
  };
}

async function challenge() {
  return await page.evaluate(() => /captcha|verifique que voc[eê] [eé] humano/i.test(document.body.innerText) || !!document.querySelector('iframe[src*="captcha"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"]'));
}

export async function openSession() {
  await ensureBrowser();
  const url = page.url();
  const loginRequired = /login|escolha-de-perfil|autentica/i.test(url) || await page.locator('input[type="password"]').count() > 0;
  return { url, title: await page.title(), login_status: loginRequired ? 'required' : 'unknown_or_active', challenge_detected: await challenge() };
}

export async function bootstrapLogin({ ra, digit, password }) {
  await ensureBrowser();
  await page.goto(`${ORIGIN}/login-alunos`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (await challenge()) return { status: 'manual_challenge_required', url: page.url() };
  const inputs = page.locator('input[type="text"]');
  await inputs.nth(0).fill(ra);
  await inputs.nth(1).fill(digit);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Acessar', exact: true }).click();
  try { await page.waitForURL(ORIGIN + '/', { timeout: 15000 }); } catch {}
  if (await challenge()) return { status: 'manual_challenge_required', url: page.url() };
  if (/login|escolha-de-perfil/i.test(page.url())) return { status: 'login_failed_or_more_steps_required', url: page.url(), message: (await page.locator('body').innerText()).slice(-1000) };
  await persist();
  return { status: 'authenticated', url: page.url() };
}

export async function navigate(url) {
  await ensureBrowser();
  const dest = new URL(url, ORIGIN);
  if (dest.origin !== ORIGIN || dest.protocol !== 'https:') throw new Error('Destination outside allowed origin.');
  await page.goto(dest.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  revision++;
  targets.clear();
  await persist();
  return { url: page.url(), title: await page.title(), challenge_detected: await challenge() };
}

export async function scan() {
  await ensureBrowser();
  assertOrigin();
  revision++;
  mappedUrl = page.url();
  const rows = await page.evaluate(rev => {
    document.querySelectorAll('[data-sdf-agent-id]').forEach(el => el.removeAttribute('data-sdf-agent-id'));
    return [...document.querySelectorAll('body *')].filter(el => {
      const tag = el.tagName.toLowerCase();
      return ['button', 'input', 'textarea', 'select', 'a', 'label'].includes(tag) || el.hasAttribute('role') || el.hasAttribute('tabindex') || el.hasAttribute('onclick') || el.isContentEditable || getComputedStyle(el).cursor === 'pointer';
    }).slice(0, 500).map((el, index) => {
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      if (visible) el.setAttribute('data-sdf-agent-id', `r${rev}_${index}`);
      return { index, tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), role: el.getAttribute('role'), text: (el.innerText || el.textContent || '').trim().slice(0, 240), label: (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') || '').slice(0, 240), visible, enabled: !el.disabled, checked: !!el.checked, box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
    }).filter(x => x.visible);
  }, revision);
  targets = new Map(rows.map(row => [`r${revision}_${row.index}`, row]));
  return { revision, url: page.url(), interactive_elements: [...targets].map(([element_id, row]) => ({ element_id, ...row })), challenge_detected: await challenge() };
}

export async function extract() {
  await ensureBrowser();
  assertOrigin();
  const content = await page.evaluate(() => {
    const root = document.querySelector('main,[role="main"],article') || document.body;
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return {
      url: location.href,
      text: (root.innerText || '').slice(0, 30000),
      questions: [...root.querySelectorAll('[class*="question"],[class*="questao"],[class*="pergunta"],fieldset')].filter(visible).slice(0, 30).map(el => (el.innerText || '').trim().slice(0, 6000)).filter(Boolean),
      media: [...root.querySelectorAll('img,video,canvas,svg')].filter(visible).slice(0, 30).map(el => ({ tag: el.tagName.toLowerCase(), alt: el.getAttribute('alt') || '', src: (el.getAttribute('src') || '').slice(0, 500) }))
    };
  });
  return { ...content, challenge_detected: await challenge() };
}

export async function capture() {
  await ensureBrowser();
  assertOrigin();
  return (await page.screenshot({ type: 'png', fullPage: false })).toString('base64');
}

async function locate(rev, id) {
  assertOrigin();
  if (rev !== revision || page.url() !== mappedUrl) throw new Error('Interaction map is stale. Call scan_environment.');
  const row = targets.get(id);
  if (!row) throw new Error('Unknown element ID. Call scan_environment.');
  const locator = page.locator(`${SELECTOR}[data-sdf-agent-id="${id}"]`);
  if (!await locator.isVisible()) throw new Error('Element is no longer visible. Rescan.');
  return { locator, row };
}

export async function action({ revision: rev, target_id, action, value }) {
  await ensureBrowser();
  if (await challenge()) throw new Error('Challenge detected; manual intervention required.');
  const { locator, row } = await locate(rev, target_id);
  if (!row.enabled) throw new Error('Element is disabled.');
  if (action === 'click') {
    if (/enviar|entregar|finalizar|concluir|submit/i.test(`${row.text} ${row.label}`)) throw new Error('Use submit_activity for final submission.');
    await locator.click({ timeout: 5000 });
  } else if (action === 'fill') {
    if (!['input', 'textarea'].includes(row.tag) && row.role !== 'textbox') throw new Error('Target does not accept text.');
    await locator.fill(value, { timeout: 5000 });
  } else if (action === 'select') {
    if (row.tag !== 'select') throw new Error('Target is not a select.');
    await locator.selectOption(value, { timeout: 5000 });
  } else throw new Error('Invalid action.');
  await persist();
  return { action, target_id, url: page.url(), needs_rescan: true, challenge_detected: await challenge() };
}

export async function submit({ revision: rev, target_id }) {
  await ensureBrowser();
  if (await challenge()) throw new Error('Challenge detected; manual intervention required.');
  const { locator, row } = await locate(rev, target_id);
  if (!['button', 'input'].includes(row.tag) || !/enviar|entregar|finalizar|concluir|submit/i.test(`${row.text} ${row.label}`)) throw new Error('Target is not a final submit button.');
  lastSubmissionBefore = { url: page.url(), body: (await page.locator('body').innerText()).slice(0, 15000) };
  await locator.click({ timeout: 5000 });
  await page.waitForTimeout(1200);
  await persist();
  return verify();
}

export async function verify() {
  await ensureBrowser();
  assertOrigin();
  const body = (await page.locator('body').innerText()).slice(0, 15000);
  const success = /atividade conclu[ií]da|enviad[ao] com sucesso|entrega realizada|conclu[ií]d[ao]/i.test(body);
  const priorSuccess = /atividade conclu[ií]da|enviad[ao] com sucesso|entrega realizada|conclu[ií]d[ao]/i.test(lastSubmissionBefore?.body || '');
  const error = /erro|campo obrigat[oó]rio|tente novamente|falha/i.test(body);
  const changed = !!lastSubmissionBefore && (page.url() !== lastSubmissionBefore.url || body !== lastSubmissionBefore.body);
  return { url: page.url(), status: changed && success && (!priorSuccess || page.url() !== lastSubmissionBefore.url) ? 'confirmed' : changed && error ? 'error_visible' : 'unconfirmed', challenge_detected: await challenge() };
}



