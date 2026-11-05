import { chromium } from 'playwright';
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
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
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



