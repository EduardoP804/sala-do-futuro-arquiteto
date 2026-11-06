import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as taskApi from './task-api.js';
import { graphQL as khanGraphQL, nextReservedItem, presentQuestion, radioAttemptInput, numericAttemptInput } from './khan-fast.js';
import { openDashboard, dashboardState, setDashboardList, waitForDashboardLogin, rememberKhanCredentials, khanLoginCredentials, clearKhanCredentials, currentKhanAccountKey, resetKhanState, setKhanAdapter } from './dashboard.js';

const ORIGIN = 'https://saladofuturo.educacao.sp.gov.br';
const PROFILE = process.env.SDF_PROFILE_DIR || join(process.env.LOCALAPPDATA || process.cwd(), 'SalaDoFuturoArquiteto', 'browser-profile');
const SESSION_STORAGE_FILE = join(PROFILE, 'agent-session-storage.json');
let context;
let page;
let revision = 0;
let targets = new Map();
let mappedUrl = '';
let lastSubmissionBefore = null;
let visibleLogin = false;
let khanContext;
let activeKhanAccountKey;
let portalPage;
let khanPage;
let khanCache;
let khanUnitItems;
let khanLastAttempt;
let khanPractice;
let khanPracticeVariables;
let khanCurrentItem;
let khanPracticeCdp;
let khanRevision = 0;
let khanTargets = new Map();
let khanMappedUrl = '';

const tools = [
  { name: 'open_dashboard', description: 'Abre o painel gráfico local de login e atividades. Retorna um link de acesso restrito ao próprio computador.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'dashboard_state', description: 'Consulta o estado do login feito pelo painel gráfico local.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'wait_for_dashboard_login', description: 'Aguarda até 60 segundos o login do usuário no painel local e retorna a listagem quando estiver pronta.', inputSchema: { type: 'object', properties: { timeout_seconds: { type: 'integer', minimum: 1, maximum: 60 } }, additionalProperties: false } },
  { name: 'list_open_tabs', description: 'Lista apenas domínio, caminho e título das abas da sessão local; omite parâmetros e tokens.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'khan_connect', description: 'Abre Khan Academy pelo acesso oficial da Sala do Futuro e lista as atribuições da conta.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'khan_list_activities', description: 'Consulta atribuições, metas e progresso de cursos e unidades Khan; usa cache por 30 segundos ou força atualização.', inputSchema: { type: 'object', properties: { fresh: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'khan_open_unit', description: 'Abre uma unidade retornada pela listagem e enumera exercícios, testes e estados visíveis.', inputSchema: { type: 'object', properties: { course_index: { type: 'integer', minimum: 0 }, unit_index: { type: 'integer', minimum: 0 } }, required: ['course_index', 'unit_index'], additionalProperties: false } },
  { name: 'khan_open_item', description: 'Abre um exercício ou teste enumerado pela unidade e mapeia a tela inicial ou a questão.', inputSchema: { type: 'object', properties: { item_index: { type: 'integer', minimum: 0 } }, required: ['item_index'], additionalProperties: false } },
  { name: 'khan_scan', description: 'Mapeia texto, links e controles da aba Khan autenticada para estudar ou resolver uma atividade.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'khan_execute_actions', description: 'Executa uma sequência curta de ações na aba Khan usando IDs do mapa atual.', inputSchema: { type: 'object', properties: { revision: { type: 'integer' }, actions: { type: 'array', maxItems: 20, items: { type: 'object', properties: { target_id: { type: 'string' }, action: { type: 'string', enum: ['click', 'fill', 'select', 'press'] }, value: { type: 'string' } }, required: ['target_id', 'action'], additionalProperties: false } } }, required: ['revision', 'actions'], additionalProperties: false } },
  { name: 'khan_drag', description: 'Arrasta um ponto visível da questão Khan entre duas coordenadas da captura atual.', inputSchema: { type: 'object', properties: { revision: { type: 'integer' }, from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' } }, required: ['revision', 'from_x', 'from_y', 'to_x', 'to_y'], additionalProperties: false } },
  { name: 'khan_last_attempt', description: 'Confere a última resposta Khan pela mutação oficial: acerto, quantidade feita e conclusão da prática.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'khan_fast_question', description: 'Lê a próxima questão Khan diretamente da API da prática, incluindo IDs das alternativas; inicia a prática se necessário.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'khan_fast_answer', description: 'Envia por JSON uma alternativa de escolha única ou uma resposta numérica Khan e confirma acerto e progresso na API.', inputSchema: { type: 'object', properties: { assessment_item_id: { type: 'string' }, choice_id: { type: 'string' }, value: { type: 'string' } }, required: ['assessment_item_id'], additionalProperties: false } },
  { name: 'khan_capture_view', description: 'Captura a tela atual do Khan para análise visual das questões.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'close_local_sessions', description: 'Fecha as sessões locais do Edge e libera memória; o login do portal permanece no perfil do navegador.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'login_and_list', description: 'Faz login sem exibir a janela do Edge e lista tarefas pendentes, rascunhos e expiradas. A senha não é guardada.', inputSchema: { type: 'object', properties: { ra: { type: 'string' }, digit: { type: 'string' }, uf: { type: 'string' }, password: { type: 'string' } }, required: ['ra', 'digit', 'uf', 'password'], additionalProperties: false } },
  { name: 'list_activities', description: 'Atualiza a lista de atividades da sessão local autenticada.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_activity', description: 'Abre uma atividade da lista e retorna todas as questões. Se houver CAPTCHA, devolve a imagem para a IA resolver.', inputSchema: { type: 'object', properties: { task_id: { type: 'integer' } }, required: ['task_id'], additionalProperties: false } },
  { name: 'answer_captcha', description: 'Valida a leitura da imagem CAPTCHA da atividade aberta e continua a abertura.', inputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } },
  { name: 'submit_answers', description: 'Envia as respostas de uma atividade aberta e confere o estado retornado pela plataforma.', inputSchema: { type: 'object', properties: { task_id: { type: 'integer' }, answers: { type: 'object', additionalProperties: true } }, required: ['task_id', 'answers'], additionalProperties: false } },
  { name: 'open_session', description: 'Abre o navegador local em segundo plano e verifica a sessão da Sala do Futuro.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'open_login_window', description: 'Abre uma janela somente para renovar manualmente uma sessão expirada.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'resume_background', description: 'Minimiza a janela de login e continua com a mesma sessão em segundo plano.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'resume_headless', description: 'Alias legado de resume_background; mantém o navegador minimizado.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'navigate_to', description: 'Navega para uma URL da origem oficial da Sala do Futuro.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
  { name: 'scan_environment', description: 'Lê a página ativa e mapeia elementos interativos com IDs temporários.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'extract_content', description: 'Extrai texto, opções e mídia visíveis da questão atual.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'capture_view', description: 'Captura a área visível da página para análise visual.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'execute_action', description: 'Clica, preenche ou seleciona um elemento de um mapa atual.', inputSchema: { type: 'object', properties: { revision: { type: 'integer' }, target_id: { type: 'string' }, action: { type: 'string', enum: ['click', 'fill', 'select'] }, value: { type: 'string' } }, required: ['revision', 'target_id', 'action'], additionalProperties: false } },
  { name: 'submit_activity', description: 'Aciona um botão de envio identificado no mapa atual.', inputSchema: { type: 'object', properties: { revision: { type: 'integer' }, target_id: { type: 'string' } }, required: ['revision', 'target_id'], additionalProperties: false } },
  { name: 'verify_submission', description: 'Observa sinais visíveis de conclusão ou erro após o envio.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
];

function assertPage() {
  if (!page || page.isClosed()) throw new Error('Sessão fechada. Chame open_session.');
  const u = new URL(page.url());
  if (u.origin !== ORIGIN) throw new Error('Navegação fora da origem permitida.');
}

async function launchBrowser() {
  await mkdir(PROFILE, { recursive: true });
  const opts = { headless: false, viewport: { width: 1440, height: 900 }, acceptDownloads: false, args: ['--start-minimized'] };
  try { context = await chromium.launchPersistentContext(PROFILE, { ...opts, channel: 'msedge' }); }
  catch { context = await chromium.launchPersistentContext(PROFILE, opts); }
  try {
    const items = JSON.parse(await readFile(SESSION_STORAGE_FILE, 'utf8'));
    if (Array.isArray(items)) await context.addInitScript(({ origin, entries }) => {
      if (location.origin === origin) for (const [key, value] of entries) sessionStorage.setItem(key, value);
    }, { origin: ORIGIN, entries: items });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  visibleLogin = false;
}

async function setWindowVisible(show) {
  if (!page || page.isClosed()) throw new Error('Sessão fechada. Chame open_session.');
  const cdp = await context.newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: show ? 'normal' : 'minimized' } });
  } finally { await cdp.detach(); }
  visibleLogin = show;
}

async function persistSessionStorage() {
  if (!page || page.isClosed() || new URL(page.url()).origin !== ORIGIN) return;
  const items = await page.evaluate(() => Object.entries(sessionStorage));
  await writeFile(SESSION_STORAGE_FILE, JSON.stringify(items), { encoding: 'utf8', mode: 0o600 });
}

async function openSession() {
  const freshLaunch = !context;
  if (!context) {
    await launchBrowser();
  }
  page = context.pages()[0] || await context.newPage();
  if (freshLaunch || page.url() === 'about:blank' || new URL(page.url()).origin !== ORIGIN) await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  await persistSessionStorage();
  if (!visibleLogin) await setWindowVisible(false);
  const hasPasswordField = await page.locator('input[type="password"]').count() > 0;
  return { url: page.url(), title: await page.title(), mode: visibleLogin ? 'visible_login' : 'background', login_status: hasPasswordField || /login|autentica|escolha-de-perfil/i.test(page.url()) ? 'required' : 'unknown_or_active' };
}

function khanTab() {
  if (activeKhanAccountKey !== (currentKhanAccountKey() || 'legacy')) return undefined;
  if (khanPage && !khanPage.isClosed() && /(^|\.)khanacademy\.org$/.test(new URL(khanPage.url()).hostname)) return khanPage;
  khanPage = khanContext?.pages().find(item => /(^|\.)khanacademy\.org$/.test(new URL(item.url()).hostname));
  return khanPage;
}

async function openKhanContext() {
  const accountKey = currentKhanAccountKey() || 'legacy';
  if (khanContext && activeKhanAccountKey === accountKey) return;
  if (khanContext) await khanContext.close();
  khanContext = undefined; portalPage = undefined; khanPage = undefined; khanCache = undefined; khanUnitItems = undefined; khanLastAttempt = undefined; khanPractice = undefined; khanPracticeVariables = undefined; khanCurrentItem = undefined; khanPracticeCdp = undefined;
  const profile = process.env.SDF_KHAN_PROFILE_DIR || join(process.env.LOCALAPPDATA || process.cwd(), 'SalaDoFuturoArquiteto', accountKey === 'legacy' ? 'khan-profile' : `khan-profile-${accountKey}`);
  await mkdir(profile, { recursive: true });
  const opts = { headless: false, viewport: { width: 1440, height: 900 }, acceptDownloads: false, args: ['--start-minimized'] };
  try { khanContext = await chromium.launchPersistentContext(profile, { ...opts, channel: 'msedge' }); }
  catch { khanContext = await chromium.launchPersistentContext(profile, opts); }
  khanContext.on('response', async response => {
    if (new URL(response.url()).pathname === '/api/internal/graphql/getOrCreatePracticeTask' && response.status() === 200) {
      const data = await response.json().catch(() => null);
      const task = data?.data?.getOrCreatePracticeTask?.result?.userTask?.task;
      if (task) khanPractice = task;
    }
    if (new URL(response.url()).pathname !== '/api/internal/graphql/attemptProblem') return;
    const data = await response.json().catch(() => null);
    const result = data?.data?.attemptProblem?.result;
    if (!result) return;
    khanLastAttempt = {
      correct: result.actionResults?.attemptCorrect ?? null,
      completed: result.updatedTask?.isCompleted ?? false,
      completed_items: result.updatedTask?.reservedItemsCompleted?.length ?? null,
      exercise_length: result.updatedTask?.exerciseLength ?? null,
      error: result.error || null,
      at: new Date().toISOString()
    };
  });
  activeKhanAccountKey = accountKey;
  portalPage = khanContext.pages().find(item => item.url().startsWith(ORIGIN)) || khanContext.pages()[0] || await khanContext.newPage();
}

async function khanList({ fresh = false } = {}) {
  const tab = khanTab();
  if (!tab) throw new Error('Khan não conectado. Use khan_connect.');
  if (!fresh && khanCache && Date.now() - khanCache.at < 30000) return { ...khanCache.value, cached: true };
  const observe = name => new Promise(resolve => {
    const timer = setTimeout(() => { khanContext.off('response', receive); resolve(null); }, 45000);
    async function receive(response) {
      if (new URL(response.url()).pathname !== `/api/internal/graphql/${name}` || response.status() !== 200) return;
      khanContext.off('response', receive);
      try { const data = await response.json(); clearTimeout(timer); resolve(data); }
      catch { clearTimeout(timer); resolve(null); }
    }
    khanContext.on('response', receive);
  });
  const assignmentsResponse = observe('ActiveAssignmentsAndGoalsQuery');
  const coursesResponse = observe('courseProgresses');
  await tab.goto('https://pt.khanacademy.org/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const [data, courseData] = await Promise.all([assignmentsResponse, coursesResponse]);
  if (!data) throw new Error('A consulta de atribuições Khan não respondeu.');
  const user = data?.data?.user;
  if (!user) throw new Error('A resposta Khan não contém o aluno.');
  const assignments = user.assignmentsPage?.assignments || [];
  const goals = user.masteryAssignments || [];
  const courses = (courseData?.data?.user?.courseProgressesV2 || []).map(course => ({
    title: course.curationNode?.title || '', pathname: course.curationNode?.relativeUrl || '',
    units: (course.unitProgresses || []).map(unit => ({
      title: unit.curationNode?.title?.trim() || '', pathname: unit.curationNode?.relativeUrl || '',
      percent: unit.currentMastery?.percentage ?? null,
      skills_proficient: unit.currentMastery?.skillsProficient ?? null,
      skills_total: unit.currentMastery?.skillsTotal ?? null,
      last_worked_on: unit.lastWorkedOn || null
    }))
  }));
  const units = courses.flatMap(course => course.units);
  const value = { status: 'connected', counts: { assignments: assignments.length, goals: goals.length, courses: courses.length, incomplete_units: units.filter(unit => unit.percent !== null && unit.percent < 100).length }, assignments, goals, courses, coverage: { assignments: true, course_progress: !!courseData?.data?.user }, updated_at: new Date().toISOString() };
  khanCache = { at: Date.now(), value };
  return value;
}

async function khanConnect() {
  await openKhanContext();
  const existing = khanTab();
  const hasKhanCookies = (await khanContext.cookies('https://pt.khanacademy.org')).length > 0;
  if (existing || hasKhanCookies) {
    khanPage = existing || await khanContext.newPage();
    try {
      if (!existing) await khanPage.goto('https://pt.khanacademy.org/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      return await khanList({ fresh: true });
    } catch {
      if (!khanLoginCredentials()) throw new Error('Sessão Khan expirada. Faça login novamente no painel local para reconectar pelo portal oficial.');
    }
  }
  if (!khanLoginCredentials()) throw new Error('Faça login no painel local para conectar a conta Khan.');
  if (!portalPage || portalPage.isClosed() || new URL(portalPage.url()).origin !== ORIGIN) portalPage = khanContext.pages().find(item => item.url().startsWith(ORIGIN)) || await khanContext.newPage();
  await portalPage.goto(`${ORIGIN}/plataformas`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await portalPage.waitForTimeout(4000);
  if (/login-alunos|escolha-de-perfil/.test(portalPage.url()) || await portalPage.getByPlaceholder('Ex.: 186735683').isVisible().catch(() => false)) {
    const login = khanLoginCredentials();
    if (!login) throw new Error('Faça login novamente no painel local para conectar o Khan.');
    await portalPage.goto(`${ORIGIN}/login-alunos`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await portalPage.getByPlaceholder('Ex.: 186735683').waitFor({ timeout: 60000 });
    await portalPage.getByPlaceholder('Ex.: 186735683').fill(login.ra);
    await portalPage.getByPlaceholder('0', { exact: true }).first().fill(login.digit);
    const ufField = portalPage.locator('[role="combobox"]').first();
    if (login.uf !== 'SP' && await ufField.count()) { await ufField.click(); await portalPage.getByRole('option', { name: login.uf, exact: true }).click(); }
    await portalPage.getByPlaceholder('Digite sua senha').fill(login.password);
    await portalPage.getByRole('button', { name: 'Acessar' }).click();
    await portalPage.waitForURL(url => !/login-alunos|escolha-de-perfil/.test(url.pathname), { timeout: 60000 });
    await portalPage.goto(`${ORIGIN}/plataformas`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  const card = portalPage.getByText('Khan Academy', { exact: true }).last();
  await card.waitFor({ timeout: 60000 });
  const popupPromise = khanContext.waitForEvent('page', { timeout: 20000 }).catch(() => null);
  await card.click({ timeout: 10000 });
  khanPage = await popupPromise || khanTab();
  if (!khanPage) throw new Error('A Sala do Futuro não abriu a aba Khan.');
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const u = new URL(khanPage.url());
    if (u.hostname === 'pt.khanacademy.org' && !['/transfer_auth', '/login/clever/redirect'].includes(u.pathname)) {
      const body = await khanPage.locator('body').innerText({ timeout: 2000 }).catch(() => '');
      if (await khanPage.locator('a[href="/logout"]').count() || /Página inicial do aluno|Minhas turmas|Minhas recomendações/i.test(body)) break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const finalUrl = new URL(khanPage.url());
  const finalBody = await khanPage.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  if (finalUrl.hostname !== 'pt.khanacademy.org' || !(await khanPage.locator('a[href="/logout"]').count()) && !/Página inicial do aluno|Minhas turmas|Minhas recomendações/i.test(finalBody)) {
    throw new Error(`Login oficial do Khan não confirmado (${finalUrl.origin}${finalUrl.pathname}).`);
  }
  await khanPage.getByRole('button', { name: 'Strictly Necessary Only' }).click({ timeout: 2000 }).catch(() => {});
  clearKhanCredentials();
  return khanList({ fresh: true });
}

async function khanOpenUnit({ course_index, unit_index }) {
  const tab = khanTab();
  if (!tab || !khanCache) throw new Error('Conecte o Khan e atualize a listagem antes de abrir uma unidade.');
  const course = khanCache.value.courses?.[course_index];
  const unit = course?.units?.[unit_index];
  if (!unit?.pathname) throw new Error('Unidade não encontrada na listagem atual.');
  const url = new URL(unit.pathname, 'https://pt.khanacademy.org');
  if (url.origin !== 'https://pt.khanacademy.org' || !unit.pathname.startsWith('/') || unit.pathname.startsWith('//')) throw new Error('Caminho de unidade inválido.');
  await tab.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await tab.getByRole('button', { name: 'Strictly Necessary Only' }).click({ timeout: 1500 }).catch(() => {});
  await tab.locator('main a[href*="/e/"]').first().waitFor({ timeout: 30000 });
  await tab.locator('main a[href*="/v/"],main a[href*="/a/"]').first().waitFor({ timeout: 5000 }).catch(() => {});
  const items = await tab.locator('main a[href]').evaluateAll((nodes, pathname) => {
    const result = new Map();
    for (const node of nodes) {
      const href = node.getAttribute('href') || '';
      if (!href.startsWith(pathname + '/') || !/\/(e|quiz|test|v|a)\//.test(href)) continue;
      const clean = href.split('?')[0];
      const label = (node.getAttribute('aria-label') || node.innerText || '').trim();
      if (!label || /^(Iniciar|Praticar|Iniciar teste|Iniciar Teste de unidade)$/i.test(label)) continue;
      const type = href.includes('/e/') ? 'exercise' : href.includes('/quiz/') ? 'quiz' : href.includes('/test/') ? 'test' : href.includes('/v/') ? 'video' : 'article';
      const status = /:\s*(unfamiliar|familiar|proficient|mastered|attempted)$/i.exec(label)?.[1]?.toLowerCase() || null;
      if (!result.has(clean)) result.set(clean, { title: label.replace(/:\s*(unfamiliar|familiar|proficient|mastered|attempted)$/i, '').trim(), pathname: clean, type, status });
    }
    return [...result.values()];
  }, url.pathname);
  khanUnitItems = items;
  khanRevision += 1; khanTargets.clear(); khanMappedUrl = '';
  return { course: course.title, unit: unit.title, percent: unit.percent, skills_proficient: unit.skills_proficient, skills_total: unit.skills_total, items, counts: { exercises: items.filter(item => item.type === 'exercise').length, quizzes: items.filter(item => item.type === 'quiz').length, tests: items.filter(item => item.type === 'test').length, videos: items.filter(item => item.type === 'video').length, articles: items.filter(item => item.type === 'article').length } };
}

async function khanOpenItem({ item_index }) {
  const tab = khanTab();
  const item = khanUnitItems?.[item_index];
  if (!tab || !item?.pathname) throw new Error('Item não encontrado. Use khan_open_unit antes.');
  const url = new URL(item.pathname, 'https://pt.khanacademy.org');
  if (url.origin !== 'https://pt.khanacademy.org' || !item.pathname.startsWith('/') || item.pathname.startsWith('//')) throw new Error('Caminho de item inválido.');
  khanPractice = undefined; khanPracticeVariables = undefined; khanCurrentItem = undefined;
  if (khanPracticeCdp) await khanPracticeCdp.detach().catch(() => {});
  khanPracticeCdp = await khanContext.newCDPSession(tab);
  await khanPracticeCdp.send('Network.enable');
  khanPracticeCdp.on('Network.requestWillBeSent', async event => {
    if (new URL(event.request.url).pathname !== '/api/internal/graphql/getOrCreatePracticeTask') return;
    let body = event.request.postData;
    if (!body) try { body = (await khanPracticeCdp.send('Network.getRequestPostData', { requestId: event.requestId })).postData; } catch {}
    try { khanPracticeVariables = JSON.parse(body).variables; } catch {}
  });
  await tab.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await tab.getByRole('button', { name: 'Strictly Necessary Only' }).click({ timeout: 1500 }).catch(() => {});
  await tab.locator('main').waitFor({ timeout: 30000 });
  if (['exercise', 'quiz', 'test'].includes(item.type)) await tab.getByRole('button', { name: 'Vamos lá' }).waitFor({ timeout: 30000 }).catch(() => {});
  return { item, scan: await khanScan() };
}

async function khanFastQuestion() {
  const tab = khanTab();
  if (!tab || !/\/e\//.test(new URL(tab.url()).pathname)) throw new Error('Abra um exercício Khan antes da leitura rápida.');
  if (khanPractice?.isCompleted) return { status: 'completed', completed_items: khanPractice.reservedItemsCompleted?.length || 0, exercise_length: khanPractice.exerciseLength };
  const start = tab.getByRole('button', { name: 'Vamos lá' });
  if (await start.isVisible().catch(() => false)) await start.click();
  for (let i = 0; i < 60 && (!khanPracticeVariables || !khanPractice); i += 1) await new Promise(resolve => setTimeout(resolve, 250));
  if (!khanPracticeVariables || !khanPractice) throw new Error('A tarefa Khan não carregou. Atualize o exercício.');
  const taskData = await khanGraphQL(tab, 'getOrCreatePracticeTask', khanPracticeVariables);
  const task = taskData?.getOrCreatePracticeTask?.result?.userTask?.task;
  if (!task) throw new Error('Khan não retornou a prática atual.');
  khanPractice = task;
  const id = nextReservedItem(task);
  if (!id) return { status: task.isCompleted ? 'completed' : 'no_pending_question', completed_items: task.reservedItemsCompleted?.length || 0, exercise_length: task.exerciseLength };
  const exerciseId = khanPracticeVariables.input.exerciseId;
  const itemData = await khanGraphQL(tab, 'getAssessmentItemById', { exerciseId, itemId: id });
  const item = itemData?.assessmentItemById?.item;
  if (!item || item.id !== id) throw new Error('Khan não retornou a próxima questão reservada.');
  khanCurrentItem = item;
  return { status: 'question', ...presentQuestion(item), completed_items: task.reservedItemsCompleted?.length || 0, exercise_length: task.exerciseLength };
}

async function khanFastAnswer({ assessment_item_id, choice_id, value }) {
  const tab = khanTab();
  if (!tab || !khanPracticeVariables || !khanCurrentItem || khanCurrentItem.id !== assessment_item_id) throw new Error('Questão rápida desatualizada. Use khan_fast_question.');
  const taskData = await khanGraphQL(tab, 'getOrCreatePracticeTask', khanPracticeVariables);
  const task = taskData?.getOrCreatePracticeTask?.result?.userTask?.task;
  if (!task || nextReservedItem(task) !== assessment_item_id) throw new Error('O Khan mudou a questão atual. Leia-a novamente.');
  if (Boolean(choice_id) === Boolean(value)) throw new Error('Forneça somente choice_id ou value.');
  const input = choice_id
    ? radioAttemptInput({ task, practiceVariables: khanPracticeVariables, item: khanCurrentItem, choiceId: choice_id })
    : numericAttemptInput({ task, practiceVariables: khanPracticeVariables, item: khanCurrentItem, value });
  const response = await khanGraphQL(tab, 'attemptProblem', { input, ancestorIds: [] });
  const result = response?.attemptProblem?.result;
  if (!result?.updatedTask || result.error) throw new Error(`Khan não confirmou a resposta: ${result?.error || 'resultado ausente'}`);
  khanPractice = result.updatedTask;
  khanCurrentItem = undefined;
  khanCache = undefined;
  return { status: 'confirmed', correct: result.actionResults?.attemptCorrect ?? null, completed: !!result.updatedTask.isCompleted, completed_items: result.updatedTask.reservedItemsCompleted?.length ?? null, exercise_length: result.updatedTask.exerciseLength ?? null };
}

async function khanScan() {
  const tab = khanTab();
  if (!tab || new URL(tab.url()).hostname !== 'pt.khanacademy.org') throw new Error('Khan não conectado.');
  khanRevision += 1;
  khanMappedUrl = tab.url();
  const rows = await tab.evaluate(rev => {
    document.querySelectorAll('[data-sdf-khan-id]').forEach(el => el.removeAttribute('data-sdf-khan-id'));
    const nodes = [...document.querySelectorAll('button,input,textarea,select,a,[role="button"],[role="radio"],[role="checkbox"],[contenteditable="true"]')];
    return nodes.slice(0, 350).map((el, i) => {
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return null;
      const id = `k${rev}_${i}`;
      el.setAttribute('data-sdf-khan-id', id);
      return { id, tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), role: el.getAttribute('role'), text: (el.innerText || el.textContent || '').trim().slice(0, 250), label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || '', box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }, enabled: !el.disabled };
    }).filter(Boolean);
  }, khanRevision);
  khanTargets = new Map(rows.map(row => [row.id, row]));
  return { status: 'scanned', revision: khanRevision, origin: new URL(tab.url()).origin, pathname: new URL(tab.url()).pathname, text: (await tab.locator('body').innerText()).slice(0, 14000), interactive_elements: rows };
}

async function khanExecute({ revision: rev, actions }) {
  const tab = khanTab();
  if (!tab || rev !== khanRevision || tab.url() !== khanMappedUrl) throw new Error('Mapa Khan desatualizado. Use khan_scan.');
  const completed = [];
  for (const item of actions) {
    const row = khanTargets.get(item.target_id);
    if (!row || !row.enabled) throw new Error(`Alvo Khan indisponível: ${item.target_id}`);
    const locator = tab.locator(`[data-sdf-khan-id="${item.target_id}"]`);
    const href = await locator.getAttribute('href');
    if (href && new URL(href, tab.url()).hostname !== 'pt.khanacademy.org') throw new Error('Link fora da conta Khan não permitido nesta ferramenta.');
    if (item.action === 'click') {
      if (/^verificar$/i.test(row.text)) khanLastAttempt = undefined;
      await locator.click({ timeout: 10000 });
    }
    else if (item.action === 'fill') await locator.fill(item.value || '', { timeout: 10000 });
    else if (item.action === 'select') await locator.selectOption(item.value || '', { timeout: 10000 });
    else if (item.action === 'press') {
      const key = item.value || 'Enter';
      if (!['Enter', 'Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) throw new Error('Tecla não permitida.');
      await locator.press(key, { timeout: 10000 });
    }
    completed.push(item.target_id);
    if (new URL(tab.url()).hostname !== 'pt.khanacademy.org' || tab.url() !== khanMappedUrl) break;
  }
  return { completed, needs_rescan: true, origin: new URL(tab.url()).origin, pathname: new URL(tab.url()).pathname };
}

async function khanDrag({ revision: rev, from_x, from_y, to_x, to_y }) {
  const tab = khanTab();
  if (!tab || rev !== khanRevision || tab.url() !== khanMappedUrl) throw new Error('Mapa Khan desatualizado. Use khan_scan.');
  const size = tab.viewportSize();
  if (!size || ![from_x, from_y, to_x, to_y].every(Number.isFinite) || from_x < 0 || to_x < 0 || from_y < 0 || to_y < 0 || from_x > size.width || to_x > size.width || from_y > size.height || to_y > size.height) throw new Error('Coordenadas fora da tela Khan.');
  await tab.mouse.move(from_x, from_y);
  await tab.mouse.down();
  await tab.mouse.move(to_x, to_y, { steps: 12 });
  await tab.mouse.up();
  return { status: 'dragged', revision: rev, pathname: new URL(tab.url()).pathname, needs_capture: true };
}

setKhanAdapter({ connect: khanConnect, list: khanList, unit: khanOpenUnit });

async function switchMode(show) {
  if (!context) await openSession();
  await setWindowVisible(show);
  return { url: page.url(), title: await page.title(), mode: show ? 'visible_login' : 'background' };
}

async function navigate(args) {
  assertPage();
  const dest = new URL(args.url, ORIGIN);
  if (dest.origin !== ORIGIN || !['http:', 'https:'].includes(dest.protocol)) throw new Error('Destino fora da origem permitida.');
  await page.goto(dest.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await persistSessionStorage();
  targets.clear();
  revision += 1;
  return { url: page.url(), title: await page.title() };
}

async function scan() {
  assertPage();
  await persistSessionStorage();
  revision += 1;
  mappedUrl = page.url();
  const rows = await page.evaluate((rev) => {
    document.querySelectorAll('[data-sdf-agent-id]').forEach(el => el.removeAttribute('data-sdf-agent-id'));
    const nodes = [...document.querySelectorAll('body *')].filter(el => {
      const tag = el.tagName.toLowerCase();
      return ['button', 'input', 'textarea', 'select', 'a', 'label'].includes(tag) || el.hasAttribute('role') || el.hasAttribute('tabindex') || el.hasAttribute('onclick') || el.isContentEditable || getComputedStyle(el).cursor === 'pointer';
    });
    return nodes.slice(0, 500).map((el, i) => {
      const r = el.getBoundingClientRect();
      const label = el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') || '';
      const text = (el.innerText || el.textContent || '').trim().slice(0, 240);
      const visible = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      if (visible) el.setAttribute('data-sdf-agent-id', `r${rev}_${i}`);
      return { index: i, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: el.getAttribute('type'), text, label: label.slice(0, 240), box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }, visible, enabled: !el.disabled, checked: !!el.checked };
    }).filter(x => x.visible);
  }, revision);
  targets = new Map(rows.map((row) => {
    const id = `r${revision}_${row.index}`;
    return [id, { index: row.index, row }];
  }));
  return { revision, url: page.url(), title: await page.title(), interactive_elements: [...targets].map(([id, { row }]) => ({ element_id: id, ...row })), total_mapped: targets.size };
}

async function extract() {
  assertPage();
  await persistSessionStorage();
  return await page.evaluate(() => {
    const root = document.querySelector('main,[role="main"],article') || document.body;
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const questionCandidates = [...root.querySelectorAll('[class*="question"],[class*="questao"],[class*="pergunta"],[data-testid*="question"],fieldset')]
      .filter(visible).slice(0, 30).map(el => ({ text: (el.innerText || '').trim().slice(0, 6000), tag: el.tagName.toLowerCase() }))
      .filter(x => x.text.length > 10);
    const options = [...root.querySelectorAll('input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]')]
      .filter(visible).slice(0, 100).map(el => ({ type: el.getAttribute('type') || el.getAttribute('role'), label: (el.labels?.[0]?.innerText || el.closest('label')?.innerText || el.parentElement?.innerText || '').trim().slice(0, 500), checked: !!el.checked || el.getAttribute('aria-checked') === 'true' }));
    const media = [...root.querySelectorAll('img,video,canvas,svg')].filter(visible).slice(0, 30).map(el => ({ tag: el.tagName.toLowerCase(), alt: el.getAttribute('alt') || '', src: (el.getAttribute('src') || '').slice(0, 500), box: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })() }));
    const challenge = /captcha|verifique que voc[eê] [eé] humano|confirme que voc[eê] n[aã]o [eé] um rob[oô]/i.test((root.innerText || '').slice(0, 24000)) || !!document.querySelector('iframe[src*="captcha"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"]');
    return { url: location.href, text: (root.innerText || '').slice(0, 24000), question_candidates: questionCandidates, options, media, challenge_detected: challenge };
  });
}

async function targetLocator(id, rev) {
  assertPage();
  if (rev !== revision) throw new Error('Mapa desatualizado. Chame scan_environment.');
  if (page.url() !== mappedUrl) throw new Error('A página mudou. Chame scan_environment.');
  const entry = targets.get(id);
  if (!entry) throw new Error('ID desconhecido. Chame scan_environment.');
  const locator = page.locator(`[data-sdf-agent-id="${id}"]`);
  if (!await locator.isVisible()) throw new Error('Elemento não está visível. Remapeie a página.');
  return { locator, row: entry.row };
}

async function execute(args) {
  const { locator, row } = await targetLocator(args.target_id, args.revision);
  if (!row.enabled) throw new Error('Elemento desabilitado.');
  if (args.action === 'click') {
    if (/enviar|entregar|finalizar|concluir|submit/i.test(`${row.text} ${row.label}`)) throw new Error('Use submit_activity para envio.');
    const before = page.url();
    try { await locator.click({ timeout: 10000 }); }
    catch (error) { if (page.url() === before) throw error; }
  }
  else if (args.action === 'fill') {
    if (!['input', 'textarea'].includes(row.tag) && row.role !== 'textbox') throw new Error('Alvo não aceita texto.');
    if (typeof args.value !== 'string') throw new Error('value é obrigatório.');
    await locator.fill(args.value, { timeout: 10000 });
  } else if (args.action === 'select') {
    if (row.tag !== 'select') throw new Error('Alvo não é uma lista.');
    if (typeof args.value !== 'string') throw new Error('value é obrigatório.');
    await locator.selectOption(args.value, { timeout: 10000 });
  } else throw new Error('Ação inválida.');
  await persistSessionStorage();
  return { action: args.action, target_id: args.target_id, url: page.url(), needs_rescan: true };
}

async function submit(args) {
  const { locator, row } = await targetLocator(args.target_id, args.revision);
  if (!['button', 'input'].includes(row.tag)) throw new Error('O alvo de envio deve ser um botão.');
  if (!/enviar|entregar|finalizar|concluir|submit/i.test(`${row.text} ${row.label}`)) throw new Error('O alvo não parece ser um botão de envio.');
  lastSubmissionBefore = { url: page.url(), body: (await page.locator('body').innerText()).slice(0, 15000) };
  await locator.click({ timeout: 5000 });
  await page.waitForTimeout(1200);
  return await verify();
}

async function verify() {
  assertPage();
  const body = (await page.locator('body').innerText()).slice(0, 15000);
  const success = /atividade conclu[ií]da|enviad[ao] com sucesso|entrega realizada|conclu[ií]d[ao]/i.test(body);
  const error = /erro|campo obrigat[oó]rio|tente novamente|falha/i.test(body);
  const changed = !!lastSubmissionBefore && (page.url() !== lastSubmissionBefore.url || body !== lastSubmissionBefore.body);
  const freshSuccess = success && lastSubmissionBefore && (page.url() !== lastSubmissionBefore.url || !/atividade conclu[ií]da|enviad[ao] com sucesso|entrega realizada|conclu[ií]d[ao]/i.test(lastSubmissionBefore.body));
  return { url: page.url(), status: freshSuccess ? 'confirmed' : changed && error ? 'error_visible' : 'unconfirmed', evidence: changed ? (body.match(/.{0,80}(atividade conclu[ií]da|enviad[ao] com sucesso|entrega realizada|conclu[ií]d[ao]|erro|campo obrigat[oó]rio|tente novamente|falha).{0,80}/i) || [])[0] || null : null };
}

async function call(name, args) {
  if (name === 'open_dashboard') return openDashboard();
  if (name === 'dashboard_state') return dashboardState();
  if (name === 'wait_for_dashboard_login') return waitForDashboardLogin(args);
  if (name === 'list_open_tabs') {
    if (!context && !khanContext) return { status: 'no_portal_session', tabs: [] };
    return { status: 'listed', tabs: await Promise.all([...(context?.pages() || []), ...(khanContext?.pages() || [])].map(async (item, index) => {
      const url = new URL(item.url());
      return { index, origin: url.origin, pathname: url.pathname, title: await item.title().catch(() => '') };
    })) };
  }
  if (name === 'khan_connect') return khanConnect();
  if (name === 'khan_list_activities') return khanList(args);
  if (name === 'khan_open_unit') return khanOpenUnit(args);
  if (name === 'khan_open_item') return khanOpenItem(args);
  if (name === 'khan_scan') return khanScan();
  if (name === 'khan_execute_actions') return khanExecute(args);
  if (name === 'khan_drag') return khanDrag(args);
  if (name === 'khan_last_attempt') {
    for (let i = 0; i < 20 && !khanLastAttempt; i += 1) await new Promise(resolve => setTimeout(resolve, 500));
    return khanLastAttempt ? { status: 'observed', ...khanLastAttempt } : { status: 'none_observed' };
  }
  if (name === 'khan_fast_question') return khanFastQuestion();
  if (name === 'khan_fast_answer') return khanFastAnswer(args);
  if (name === 'khan_capture_view') {
    const tab = khanTab();
    if (!tab || new URL(tab.url()).hostname !== 'pt.khanacademy.org') throw new Error('Khan não conectado.');
    return { image: (await tab.screenshot({ type: 'png', fullPage: false })).toString('base64') };
  }
  if (name === 'close_local_sessions') {
    await taskApi.closeSession();
    if (context) await context.close();
    if (khanContext) await khanContext.close();
    context = undefined; page = undefined; khanContext = undefined; activeKhanAccountKey = undefined; portalPage = undefined; khanPage = undefined; khanCache = undefined; khanUnitItems = undefined; khanLastAttempt = undefined;
    resetKhanState();
    return { status: 'closed' };
  }
  if (name === 'login_and_list') {
    const list = await taskApi.exclusive(() => taskApi.loginAndList(args));
    rememberKhanCredentials(args);
    setDashboardList(list);
    return list;
  }
  if (name === 'list_activities') {
    const list = await taskApi.exclusive(() => taskApi.listActivities());
    setDashboardList(list);
    return list;
  }
  if (name === 'get_activity') return taskApi.exclusive(() => taskApi.getTask(args));
  if (name === 'answer_captcha') return taskApi.exclusive(() => taskApi.answerCaptcha(args));
  if (name === 'submit_answers') return taskApi.exclusive(() => taskApi.submitAnswers(args));
  if (name === 'open_session') return openSession();
  if (name === 'open_login_window') return switchMode(true);
  if (name === 'resume_background' || name === 'resume_headless') return switchMode(false);
  if (name === 'navigate_to') return navigate(args);
  if (name === 'scan_environment') return scan();
  if (name === 'extract_content') return extract();
  if (name === 'execute_action') return execute(args);
  if (name === 'submit_activity') return submit(args);
  if (name === 'verify_submission') return verify();
  if (name === 'capture_view') {
    assertPage();
    return { image: (await page.screenshot({ type: 'png', fullPage: false })).toString('base64') };
  }
  throw new Error('Ferramenta desconhecida.');
}

function send(id, result, error) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error: { code: -32000, message: error.message } } : { result }) }) + '\n');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const pos = buffer.indexOf('\n');
    const line = buffer.slice(0, pos).trim();
    buffer = buffer.slice(pos + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (!Object.hasOwn(msg, 'id')) continue;
    try {
      if (msg.method === 'initialize') send(msg.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'sala-do-futuro-local', version: '0.7.2' } });
      else if (msg.method === 'tools/list') send(msg.id, { tools });
      else if (msg.method === 'tools/call') {
        const data = await call(msg.params?.name, msg.params?.arguments || {});
        if (data?.image && msg.params?.name !== 'capture_view') {
          const { image, zoomed_image, mimeType, ...details } = data;
          send(msg.id, { content: [{ type: 'text', text: JSON.stringify(details) }, { type: 'image', data: zoomed_image || image, mimeType: mimeType || 'image/png' }, { type: 'image', data: image, mimeType: mimeType || 'image/png' }] });
        }
        else if (msg.params?.name === 'capture_view' || msg.params?.name === 'khan_capture_view') send(msg.id, { content: [{ type: 'image', data: data.image, mimeType: 'image/png' }] });
        else send(msg.id, { content: [{ type: 'text', text: JSON.stringify(data) }] });
      } else send(msg.id, null, new Error('Método desconhecido.'));
    } catch (e) { send(msg.id, null, e); }
  }
});
