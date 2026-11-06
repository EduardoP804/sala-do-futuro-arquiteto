import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';

const SDF = 'https://saladofuturo.educacao.sp.gov.br';
const IPTV = 'https://edusp-api.ip.tv';
let browser;
let page;
let authToken;
let nick;
let rooms = [];
let tasks = new Map();
let opened = new Map();
let captcha;
let queue = Promise.resolve();

export function exclusive(fn) {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

function requireSession() {
  if (!page || page.isClosed() || !authToken) throw new Error('Sessão de tarefas ausente. Use login_and_list.');
  if (new URL(page.url()).origin !== IPTV) throw new Error('A página saiu da origem de tarefas. Faça login novamente.');
}

async function request(path, { method = 'GET', body, extraHeaders = {} } = {}) {
  requireSession();
  return page.evaluate(async ({ path, method, body, token, extraHeaders }) => {
    const response = await fetch(path, {
      method,
      signal: AbortSignal.timeout(25000),
      headers: {
        accept: 'application/json',
        'x-api-key': token,
        'x-api-platform': 'webclient',
        'x-api-realm': 'edusp',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const type = response.headers.get('content-type') || '';
    const text = await response.text();
    let data = null;
    if (type.includes('json')) try { data = JSON.parse(text); } catch {}
    return { status: response.status, type: type.split(';')[0], data, text: data === null ? text.slice(0, 160000) : '' };
  }, { path, method, body, token: authToken, extraHeaders });
}

async function closeSession() {
  if (browser) await browser.close().catch(() => {});
  browser = undefined;
  page = undefined;
  authToken = undefined;
  nick = undefined;
  rooms = [];
  tasks = new Map();
  opened = new Map();
  captcha = undefined;
}

export async function loginAndList({ ra, digit, uf, password }) {
  if (!/^\d{1,12}$/.test(ra) || !/^[0-9Xx]$/.test(digit) || !/^[A-Z]{2}$/.test(uf) || !password) throw new Error('RA, dígito, UF ou senha inválidos.');
  await closeSession();
  try {
    const headless = process.env.SDF_HEADLESS === '1';
    const browserOptions = { headless, ...(!headless && { args: ['--start-minimized'] }) };
    try { browser = await chromium.launch({ channel: 'msedge', ...browserOptions }); }
    catch { browser = await chromium.launch(browserOptions); }
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const configRequest = page.waitForRequest(req => new URL(req.url()).pathname.endsWith('/api/configuracoes'), { timeout: 3000 }).catch(() => null);
    await page.goto(`${SDF}/login-alunos`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const key = (await configRequest)?.headers()['ocp-apim-subscription-key'] || 'd701a2043aa24d7ebb37e9adf60d043b';
    const loginResponse = await fetch('https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', 'ocp-apim-subscription-key': key, 'x-product-name': 'SalaDoFuturo', origin: SDF },
      body: JSON.stringify({ user: ra + digit + uf, senha: password })
    });
    const login = await loginResponse.json().catch(() => ({}));
    if (!loginResponse.ok || !login.token) throw new Error(`Login da SED não confirmado (HTTP ${loginResponse.status}).`);
    const landing = await page.goto(`${IPTV}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (landing?.status() !== 200) throw new Error(`A plataforma de tarefas não abriu (HTTP ${landing?.status() || 'sem resposta'}).`);
    await page.waitForTimeout(12000);
    const exchange = await page.evaluate(async token => {
      const response = await fetch('/registration/edusp/token', {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json', 'x-api-platform': 'webclient', 'x-api-realm': 'edusp' },
        body: JSON.stringify({ token })
      });
      const type = response.headers.get('content-type') || '';
      return { status: response.status, data: type.includes('json') ? await response.json().catch(() => ({})) : {} };
    }, login.token);
    if (exchange.status !== 200 || !exchange.data.auth_token) throw new Error(`Token de tarefas não confirmado (HTTP ${exchange.status}).`);
    authToken = exchange.data.auth_token;
    nick = exchange.data.nick || '';
    const roomResponse = await request('/room/user?list_all=true&with_cards=true');
    if (roomResponse.status !== 200) throw new Error(`Salas não carregadas (HTTP ${roomResponse.status}).`);
    rooms = Array.isArray(roomResponse.data?.rooms) ? roomResponse.data.rooms : [];
    return await listActivities();
  } catch (error) {
    await closeSession();
    throw error;
  }
}

function targets() {
  const values = [];
  for (const room of rooms) {
    if (room.name) {
      values.push(room.name);
      if (nick) values.push(`${room.name}:${nick}`);
    }
    for (const category of room.group_categories || []) if (category.id) values.push(String(category.id));
  }
  return [...new Set(values)];
}

async function fetchGroup(essay, expired) {
  const all = [];
  let pageNo = 0;
  for (; pageNo < 10; pageNo++) {
    const query = new URLSearchParams({
      expired_only: String(expired), limit: '100', offset: String(pageNo * 100), filter_expired: String(!expired),
      is_exam: 'false', with_answer: 'true', is_essay: String(essay), with_apply_moment: 'true'
    });
    for (const value of targets()) query.append('publication_target', value);
    const response = await request(`/tms/task/todo?${query}`);
    if (response.status !== 200 || !Array.isArray(response.data)) throw new Error(`Listagem de tarefas bloqueada (HTTP ${response.status}, ${response.type || 'sem tipo'}).`);
    all.push(...response.data);
    if (response.data.length < 100) break;
  }
  return { items: all, truncated: pageNo === 10 };
}

function publicTask(task, category) {
  return {
    id: task.id, title: task.title || 'Sem título', category,
    expire_at: task.expire_at || null, question_count: task.question_count ?? null,
    is_essay: !!task.is_essay, answer_status: task.answer_status || null,
    answer_id_present: !!task.answer_id
  };
}

export async function listActivities() {
  requireSession();
  const [current, expired, essays, expiredEssays] = await Promise.all([
    fetchGroup(false, false), fetchGroup(false, true), fetchGroup(true, false), fetchGroup(true, true)
  ]);
  const unique = new Map();
  for (const item of [...current.items, ...expired.items, ...essays.items, ...expiredEssays.items]) {
    const previous = unique.get(item.id);
    if (!previous || (item.answer_id && !previous.answer_id)) unique.set(item.id, item);
  }
  tasks = unique;
  const result = { pending: [], drafts: [], expired: [], finished: [] };
  for (const task of unique.values()) {
    const category = ['finished', 'submitted'].includes(task.answer_status) ? 'finished'
      : task.task_expired ? 'expired'
      : task.answer_status === 'draft' || task.answer_id ? 'drafts' : 'pending';
    result[category].push(publicTask(task, category));
  }
  for (const items of Object.values(result)) items.sort((a, b) => (a.expire_at || '').localeCompare(b.expire_at || ''));
  return {
    status: 'listed',
    counts: Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value.length])),
    pending: result.pending, drafts: result.drafts, expired: result.expired,
    finished_count: result.finished.length,
    truncated: [current, expired, essays, expiredEssays].some(group => group.truncated)
  };
}

function decodeTask(response) {
  if (response.data && typeof response.data === 'object') return response.data;
  if (response.text) {
    try { return JSON.parse(Buffer.from(response.text, 'base64').toString('utf8')); } catch {}
  }
  return null;
}

async function challengeFor(taskId) {
  const sessionKey = randomUUID().replaceAll('-', '');
  const response = await request('/captcha/challenge', {
    method: 'POST', body: { realm: 'edusp' }, extraHeaders: { 'x-session-key': sessionKey }
  });
  const challengeId = response.data?.challengeId;
  const image = response.data?.challenge?.image;
  if (response.status !== 200 || !challengeId || !image) throw new Error(`CAPTCHA indisponível (HTTP ${response.status}).`);
  captcha = { taskId, challengeId, sessionKey, image, attempts: (captcha?.taskId === taskId ? captcha.attempts : 0) + 1 };
  if (captcha.attempts > 3) throw new Error('CAPTCHA não validado após três tentativas.');
  const zoomed_image = await page.evaluate(async source => {
    const picture = new Image();
    picture.src = `data:image/png;base64,${source}`;
    await picture.decode();
    const canvas = document.createElement('canvas');
    canvas.width = picture.naturalWidth * 6;
    canvas.height = picture.naturalHeight * 6;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  }, image);
  return { status: 'captcha_required', task_id: taskId, image, zoomed_image, mimeType: 'image/png', attempts: captcha.attempts };
}

export async function getTask({ task_id, captcha_token } = {}) {
  requireSession();
  const task = tasks.get(Number(task_id));
  if (!task) throw new Error('Tarefa desconhecida. Atualize a listagem.');
  const cached = opened.get(task.id);
  if (cached && !captcha_token) return { status: 'opened', task_id: task.id, title: task.title, task: cached.data, cached: true };
  if (captcha?.taskId === task.id && !captcha_token) return {
    status: 'captcha_required', task_id: task.id, image: captcha.image,
    zoomed_image: await page.evaluate(async source => {
      const picture = new Image(); picture.src = `data:image/png;base64,${source}`; await picture.decode();
      const canvas = document.createElement('canvas'); canvas.width = picture.naturalWidth * 6; canvas.height = picture.naturalHeight * 6;
      const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png').split(',')[1];
    }, captcha.image), mimeType: 'image/png', attempts: captcha.attempts, reused: true
  };
  const query = new URLSearchParams({ preview_mode: 'false' });
  if (task.answer_id) {
    query.set('answer_id', String(task.answer_id));
    for (const field of ['id', 'nick', 'status', 'task_id', 'answers', 'duration', 'revised_request_count']) query.append('answer_fields', field);
  }
  query.set('token_code', 'null');
  query.set('room_name', task.publication_target || '');
  const response = await request(`/tms/task/${task.id}/apply?${query}`, { extraHeaders: captcha_token ? { 'x-captcha-token': captcha_token } : {} });
  if (response.status === 403 && /captcha/i.test(JSON.stringify(response.data || {}))) return challengeFor(task.id);
  if (response.status !== 200) {
    const detail = response.data?.message || response.data?.error || response.data?.detail || JSON.stringify(response.data || {}).slice(0, 350);
    throw new Error(`Não foi possível abrir a tarefa (HTTP ${response.status}, ${response.type || 'sem tipo'}): ${String(detail).slice(0, 350)}`);
  }
  const data = decodeTask(response);
  if (!data?.questions) throw new Error('A tarefa abriu, mas as questões não vieram em formato reconhecido.');
  opened.set(task.id, { data, at: Date.now() });
  captcha = undefined;
  return { status: 'opened', task_id: task.id, title: task.title, task: data };
}

export async function answerCaptcha({ answer }) {
  requireSession();
  if (!captcha) throw new Error('Nenhum CAPTCHA aguardando resposta.');
  if (typeof answer !== 'string' || !/^[a-zA-Z0-9]{3,12}$/.test(answer.trim())) throw new Error('Resposta do CAPTCHA inválida.');
  const active = captcha;
  const response = await request('/captcha/verify', {
    method: 'POST',
    body: { type: 'image', realm: 'edusp', payload: { challengeId: active.challengeId, answer: answer.trim().toLowerCase() } },
    extraHeaders: { 'x-session-key': active.sessionKey }
  });
  if (response.status === 200 && response.data?.valid && response.data?.token) {
    return getTask({ task_id: active.taskId, captcha_token: response.data.token });
  }
  return challengeFor(active.taskId);
}

export async function submitAnswers({ task_id, answers }) {
  requireSession();
  const id = Number(task_id);
  const task = tasks.get(id);
  const openedTask = opened.get(id);
  if (!task || !openedTask) throw new Error('Abra a tarefa e leia as questões antes de enviar.');
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('answers deve ser um objeto por ID de questão.');
  const questions = (openedTask.data.questions || []).filter(q => !['info', 'section'].includes(q.type));
  const missing = questions.filter(q => !Object.hasOwn(answers, String(q.id))).map(q => q.id);
  if (missing.length) throw new Error(`Respostas ausentes para ${missing.length} questões.`);
  const isEssay = !!(task.is_essay || openedTask.data.is_essay || questions.some(q => q.type === 'essay'));
  const minimumSeconds = Number(openedTask.data.min_execution_time) || 0;
  const elapsedMs = Date.now() - openedTask.at;
  if (minimumSeconds > 0 && elapsedMs < minimumSeconds * 1000 + 1500) {
    await new Promise(resolve => setTimeout(resolve, minimumSeconds * 1000 + 1500 - elapsedMs));
  }
  const payload = {
    status: isEssay ? 'draft' : 'submitted', answers,
    accessed_on: 'room', executed_on: task.publication_target,
    duration: Math.max(1, Math.round((Date.now() - openedTask.at) / 1000))
  };
  const answerId = openedTask.data.answer?.id || task.answer_id;
  const path = answerId ? `/tms/task/${id}/answer/${answerId}` : `/tms/task/${id}/answer`;
  const response = await request(path, { method: answerId ? 'PUT' : 'POST', body: payload });
  if (response.status !== 200) return {
    task_id: id, status: 'not_confirmed', http_status: response.status,
    response_type: response.type,
    server_error: response.data?.error || response.data?.message || response.data?.detail || null
  };
  const serverStatus = response.data?.status || null;
  opened.delete(id);
  const updated = await listActivities().catch(() => null);
  const listed = updated ? [...updated.pending, ...updated.drafts, ...updated.expired].find(item => item.id === id) : null;
  return {
    task_id: id,
    status: isEssay ? 'draft_saved' : serverStatus === 'submitted' || serverStatus === 'finished' || (!listed && !!updated) ? 'confirmed' : 'unconfirmed',
    server_status: serverStatus,
    answer_id_present: !!(response.data?.id || answerId),
    remaining: updated?.counts || null
  };
}

export { closeSession };
