const form = document.querySelector('#login-form');
const message = document.querySelector('#message');
const loginView = document.querySelector('#login-view');
const dashboardView = document.querySelector('#dashboard-view');
const summary = document.querySelector('#summary');
const lists = document.querySelector('#activity-lists');
const refreshStatus = document.querySelector('#refresh-status');
const spTab = document.querySelector('#tab-sp');
const khanTab = document.querySelector('#tab-khan');
const tasksPanel = document.querySelector('#tasks-panel');
const khanPanel = document.querySelector('#khan-panel');
const khanStatus = document.querySelector('#khan-status');
const khanConnect = document.querySelector('#khan-connect');
const khanRefresh = document.querySelector('#khan-refresh');
const khanSummary = document.querySelector('#khan-summary');
const khanLists = document.querySelector('#khan-lists');

function platform(which) {
  const khan = which === 'khan';
  tasksPanel.hidden = khan;
  khanPanel.hidden = !khan;
  spTab.classList.toggle('active', !khan);
  khanTab.classList.toggle('active', khan);
  spTab.setAttribute('aria-pressed', String(!khan));
  khanTab.setAttribute('aria-pressed', String(khan));
  if (khan) fetch('/api/khan/state').then(response => response.json()).then(renderKhan).catch(() => {});
}

function renderKhan(data) {
  if (data.status === 'connecting') { khanStatus.textContent = 'Conectando pelo portal oficial…'; return; }
  if (data.status === 'error') { khanStatus.textContent = data.message || 'Não foi possível conectar.'; return; }
  if (data.status !== 'connected') return;
  khanStatus.textContent = data.coverage?.course_progress === false ? 'Conta conectada. Progresso do curso indisponível nesta atualização.' : 'Conta conectada. Atribuições e progresso atualizados.';
  khanConnect.hidden = true;
  khanRefresh.hidden = false;
  khanSummary.hidden = false;
  khanSummary.replaceChildren();
  for (const [key, label] of [['assignments', 'Atribuições'], ['goals', 'Metas'], ['courses', 'Cursos'], ['incomplete_units', 'Unidades incompletas']]) {
    const box = document.createElement('div');
    const count = document.createElement('b');
    count.textContent = data.counts?.[key] ?? 0;
    const name = document.createElement('span');
    name.textContent = label;
    box.append(count, name);
    khanSummary.append(box);
  }
  khanLists.replaceChildren();
  const items = [...(data.assignments || []), ...(data.goals || [])];
  if (!items.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Nenhuma atribuição ou meta ativa no momento.'; khanLists.append(empty); }
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'activity';
    const title = document.createElement('strong'); title.textContent = item.title || item.name || item.description || 'Atividade Khan';
    row.append(title); khanLists.append(row);
  }
  (data.courses || []).forEach((course, courseIndex) => {
    const group = document.createElement('section'); group.className = 'activity-group';
    const heading = document.createElement('h3'); heading.textContent = course.title || 'Curso'; group.append(heading);
    (course.units || []).forEach((unit, unitIndex) => {
      const row = document.createElement('div'); row.className = 'activity';
      const title = document.createElement('strong'); title.textContent = unit.title || 'Unidade';
      const progress = document.createElement('small'); progress.textContent = unit.percent === null ? 'Progresso indisponível' : `${unit.percent}% · ${unit.skills_proficient ?? 0}/${unit.skills_total ?? 0} habilidades proficientes`;
      const button = document.createElement('button'); button.className = 'unit-detail-button'; button.type = 'button'; button.textContent = 'Ver atividades';
      const detail = document.createElement('div'); detail.className = 'unit-detail'; detail.hidden = true;
      button.addEventListener('click', async () => {
        if (!detail.hidden && button.textContent === 'Ocultar atividades') { detail.hidden = true; button.textContent = 'Ver atividades'; return; }
        button.disabled = true; button.textContent = 'Carregando…';
        try {
          const response = await fetch('/api/khan/unit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ course_index: courseIndex, unit_index: unitIndex }) });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Não foi possível carregar a unidade.');
          detail.replaceChildren();
          for (const item of data.items || []) {
            const line = document.createElement('p'); line.textContent = `${item.title} · ${item.type === 'exercise' ? 'Exercício' : item.type === 'quiz' ? 'Teste' : 'Teste da unidade'}${item.status ? ` · ${item.status === 'unfamiliar' ? 'Não iniciado' : item.status}` : ''}`;
            detail.append(line);
          }
          detail.hidden = false;
          button.textContent = 'Ocultar atividades';
        } catch (error) { detail.textContent = error.message; detail.hidden = false; button.textContent = 'Tentar novamente'; }
        finally { button.disabled = false; }
      });
      row.append(title, progress, button, detail); group.append(row);
    });
    khanLists.append(group);
  });
}

function render(data) {
  if (data.status !== 'authenticated') return;
  loginView.hidden = true;
  dashboardView.hidden = false;
  summary.replaceChildren();
  for (const [key, label] of [['pending', 'Pendentes'], ['expired', 'Expiradas'], ['drafts', 'Rascunhos']]) {
    const box = document.createElement('div');
    const number = document.createElement('b');
    number.textContent = data.counts?.[key] ?? 0;
    const name = document.createElement('span');
    name.textContent = label;
    box.append(number, name);
    summary.append(box);
  }
  lists.replaceChildren();
  for (const [key, label] of [['pending', 'Pendentes'], ['expired', 'Expiradas'], ['drafts', 'Rascunhos']]) {
    const items = data.activities?.[key] || [];
    if (!items.length) continue;
    const group = document.createElement('section');
    group.className = 'activity-group';
    const h = document.createElement('h3');
    h.textContent = label;
    group.append(h);
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'activity';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const date = document.createElement('small');
      date.textContent = item.expire_at ? `Prazo: ${new Date(item.expire_at).toLocaleString('pt-BR')}` : 'Sem prazo informado';
      row.append(title, date);
      group.append(row);
    }
    lists.append(group);
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  message.textContent = 'Entrando e carregando atividades…';
  const values = Object.fromEntries(new FormData(form));
  values.ra = String(values.ra).trim();
  values.digit = String(values.digit).trim();
  values.uf = String(values.uf).trim().toUpperCase();
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error || 'Login não confirmado.');
    form.elements.password.value = '';
    message.textContent = '';
    render(data);
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector('#show-password').addEventListener('click', () => {
  const field = form.elements.password;
  field.type = field.type === 'password' ? 'text' : 'password';
});

document.querySelector('#refresh').addEventListener('click', async () => {
  refreshStatus.textContent = 'Atualizando…';
  try {
    const response = await fetch('/api/refresh', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível atualizar.');
    render(data);
    refreshStatus.textContent = 'Atualizado';
  } catch (error) { refreshStatus.textContent = error.message; }
});

spTab.addEventListener('click', () => platform('sp'));
khanTab.addEventListener('click', () => platform('khan'));
khanConnect.addEventListener('click', async () => {
  khanConnect.disabled = true;
  khanStatus.textContent = 'Conectando pelo portal oficial…';
  try {
    const response = await fetch('/api/khan/connect', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error || 'Conexão não confirmada.');
    renderKhan(data);
  } catch (error) { khanStatus.textContent = error.message; }
  finally { khanConnect.disabled = false; }
});
khanRefresh.addEventListener('click', async () => {
  khanRefresh.disabled = true;
  khanStatus.textContent = 'Atualizando atribuições…';
  try {
    const response = await fetch('/api/khan/refresh', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Atualização não confirmada.');
    renderKhan(data);
  } catch (error) { khanStatus.textContent = error.message; }
  finally { khanRefresh.disabled = false; }
});

fetch('/api/state').then(response => response.json()).then(render).catch(() => {});
