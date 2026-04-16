/**
 * Dashboard Grupo ATM — SQLite persistence server
 * Node.js + Express + better-sqlite3
 *
 * Endpoints:
 *   GET    /api/storage          → { key: value, ... }
 *   GET    /api/storage/:key     → { value: ... }
 *   PUT    /api/storage/:key     → body: { value: ... }
 *   DELETE /api/storage/:key     → 204
 *   POST   /api/migrate          → body: { data: { key: value, ... } }
 *   GET    /api/sync-clickup     → trigger manual sync
 *   GET    /api/sync-status      → last sync info
 */

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const https    = require('https');
const fs       = require('fs');
const vm       = require('vm');
const Database = require('better-sqlite3');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT || 3333;
const DB_PATH       = process.env.DB_PATH || path.join(__dirname, 'atm_dashboard.db');
const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN;

// IDs das listas de turmas no ClickUp
const TURMAS_LISTS = ['901103166181', '901103299950']; // Formô + YZ
const VALOR_PROJETO_FIELD = 'f232bcb7-7e91-42b8-9a45-b12c7dccc61b';

// Mapeamento status ClickUp → etapa do funil
const FUNIL_STAGE_MAP = {
  'prospectar':            { nome: 'Prospectar',              cor: '#666666' },
  'prospectado':           { nome: 'Prospectar',              cor: '#666666' },
  'em atendimento':        { nome: 'Em Atendimento',          cor: '#185FA5' },
  'elaboração de projeto': { nome: 'Elaboração de Projeto',   cor: '#854F0B' },
  'elaboracao de projeto': { nome: 'Elaboração de Projeto',   cor: '#854F0B' },
  'assembleia':            { nome: 'Assembleia',              cor: '#993556' },
  'assinatura/fechamento': { nome: 'Assinatura / Fechamento', cor: '#3B6D11' },
  'pós venda':             { nome: 'Pós Venda',               cor: '#3C3489' },
  'pos venda':             { nome: 'Pós Venda',               cor: '#3C3489' },
  'formô':                 { nome: 'Formô',                   cor: '#0F6E56' },
  'formo':                 { nome: 'Formô',                   cor: '#0F6E56' },
};

const STAGE_ORDER = [
  'Prospectar','Em Atendimento','Elaboração de Projeto',
  'Assembleia','Assinatura / Fechamento','Pós Venda','Formô'
];

// ── DB setup ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS storage (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const stmtGetAll = db.prepare('SELECT key, value FROM storage');
const stmtGetOne = db.prepare('SELECT value FROM storage WHERE key = ?');
const stmtUpsert = db.prepare('INSERT INTO storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const stmtDelete = db.prepare('DELETE FROM storage WHERE key = ?');
const stmtCount  = db.prepare('SELECT COUNT(*) as n FROM storage');

// ── ClickUp Sync ──────────────────────────────────────────────────────────────

// Mapeamento de status ClickUp → Dashboard
const STATUS_MAP = {
  'em andamento':      'EM ANDAMENTO',
  'em desenvolvimento':'EM ANDAMENTO',
  'em producao':       'EM ANDAMENTO',
  'em produção':       'EM ANDAMENTO',
  'em aprovação':      'EM ANDAMENTO',
  'em aprovacao':      'EM ANDAMENTO',
  'em revisão':        'EM ANDAMENTO',
  'em revisao':        'EM ANDAMENTO',
  'envio final':       'EM ANDAMENTO',
  'não iniciado':      'NÃO INICIADO',
  'nao iniciado':      'NÃO INICIADO',
  'concluído':         'CONCLUÍDO',
  'concluido':         'CONCLUÍDO',
  'complete':          'CONCLUÍDO',
  'done':              'CONCLUÍDO',
  'stand by':          'STAND BY',
  'standby':           'STAND BY',
  'blocked':           'STAND BY',
};

// Mapeamento de nomes do ClickUp → nomes curtos do dashboard
const ASSIGNEE_MAP = {
  'nana penkal':                   'Nana',
  'marines':                       'Marines',
  'maria carolina ronkoski':       'Carol',
  'ana leticia s':                 'Ana',
  'paloma armentano':              'Paloma',
  'abner bergman':                 'Abner',
  'felipe do amaral tomasoni':     'Felipe',
  'vitor pacifico de moraes neto': 'Vitor',
  'andreone cidactha':             'Andreone',
  'alisson':                       'Alisson',
};

const MONTHS_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

function normalizeStr(s) {
  return (s || '').toLowerCase().trim().normalize('NFC');
}

function mapStatus(cuTask) {
  const raw = normalizeStr(cuTask.status?.status);
  const doneStatuses = ['concluído','concluido','complete','done'];
  if (!doneStatuses.includes(raw) && cuTask.due_date && parseInt(cuTask.due_date) < Date.now()) {
    return 'EM ATRASO';
  }
  return STATUS_MAP[raw] || null;
}

function mapAssignees(assignees) {
  if (!assignees || assignees.length === 0) return null;
  const names = assignees.map(a => {
    const key = normalizeStr(a.username);
    return ASSIGNEE_MAP[key] || a.username.split(' ')[0];
  });
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} e ${names[1]}`;
  return names.slice(0, 2).join(', ');
}

function formatDue(timestamp) {
  if (!timestamp) return null;
  const date = new Date(parseInt(timestamp));
  return `${date.getDate()} ${MONTHS_PT[date.getMonth()]}`;
}

function fetchClickUpTask(taskId) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'api.clickup.com',
      path: `/api/v2/task/${taskId}`,
      headers: { 'Authorization': CLICKUP_TOKEN },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function parseProjectsFromHTML() {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const start = html.indexOf('const PROJECTS = [');
    const end   = html.indexOf('\nconst FUNNEL_STAGES', start);
    if (start === -1 || end === -1) return [];
    const code = html.slice(start + 'const PROJECTS = '.length, end).trim().replace(/;$/, '');
    const ctx = {};
    vm.runInNewContext(`result = ${code}`, ctx);
    return ctx.result || [];
  } catch(e) {
    console.error('Falha ao ler PROJECTS do HTML:', e.message);
    return [];
  }
}

function formatBRLFull(num) {
  if (!num) return '—';
  return 'R$ ' + Math.round(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function formatBRLM(num) {
  if (!num) return '—';
  if (num >= 1000000) return `R$ ${(num / 1000000).toFixed(1).replace('.', ',')}M`;
  return formatBRLFull(num);
}

async function fetchAllListTasks(listId) {
  const tasks = [];
  let page = 0;
  while (true) {
    const result = await new Promise((resolve) => {
      const req = https.get({
        hostname: 'api.clickup.com',
        path: `/api/v2/list/${listId}/task?archived=false&page=${page}`,
        headers: { 'Authorization': CLICKUP_TOKEN },
        timeout: 20000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
    if (!result || !result.tasks) break;
    tasks.push(...result.tasks);
    if (result.tasks.length < 100) break;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }
  return tasks;
}

async function syncFunil() {
  if (!CLICKUP_TOKEN) return;
  console.log('  Sincronizando funil comercial...');

  const allTasks = [];
  for (const listId of TURMAS_LISTS) {
    const tasks = await fetchAllListTasks(listId);
    allTasks.push(...tasks);
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`  ${allTasks.length} turmas carregadas`);

  // Inicializar etapas
  const stageData = {};
  for (const nome of STAGE_ORDER) {
    const cor = Object.values(FUNIL_STAGE_MAP).find(s => s.nome === nome)?.cor || '#666';
    stageData[nome] = { nome, cor, turmas: [], totalNum: 0 };
  }

  let pipeline = 0, contratos = 0, turmasAtivas = 0;

  for (const t of allTasks) {
    const statusRaw = normalizeStr(t.status?.status || '');
    const stageInfo = FUNIL_STAGE_MAP[statusRaw];
    if (!stageInfo) continue; // pula "perdidas" e desconhecidos

    const stageName = stageInfo.nome;

    // Valor do projeto
    let valor = 0;
    for (const cf of (t.custom_fields || [])) {
      if (cf.id === VALOR_PROJETO_FIELD && cf.value) {
        valor = parseFloat(String(cf.value).replace(',', '.')) || 0;
        break;
      }
    }

    // Responsável (primeiro + sobrenome)
    const assignees = t.assignees || [];
    const resp = assignees.length > 0
      ? assignees.map(a => {
          const parts = (a.username || '').split(' ');
          return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : parts[0];
        }).join(', ')
      : '—';

    if (stageData[stageName]) {
      stageData[stageName].turmas.push({
        nome: t.name,
        valor: valor ? formatBRLFull(valor) : '—',
        resp,
        link: `https://app.clickup.com/t/${t.id}`
      });
      stageData[stageName].totalNum += valor;
    }

    pipeline += valor;
    turmasAtivas++;
    if (['Assinatura / Fechamento', 'Pós Venda', 'Formô'].includes(stageName)) {
      contratos += valor;
    }
  }

  const stages = STAGE_ORDER
    .filter(nome => stageData[nome]?.turmas.length > 0)
    .map(nome => ({
      ...stageData[nome],
      total: formatBRLFull(stageData[nome].totalNum),
      count: stageData[nome].turmas.length
    }));

  const funil = {
    pipelineNum: pipeline,
    pipeline: formatBRLM(pipeline),
    contratosNum: contratos,
    contratos: formatBRLM(contratos),
    turmasAtivas,
    ultimoSync: new Date().toISOString(),
    stages
  };

  stmtUpsert.run('atm_funil_data', JSON.stringify(funil));
  console.log(`  Funil: ${turmasAtivas} turmas · pipeline ${funil.pipeline} · contratos ${funil.contratos}`);
}

let lastSync       = null;
let syncInProgress = false;

async function syncClickUp() {
  if (!CLICKUP_TOKEN) {
    console.log('CLICKUP_TOKEN não configurado, sync ignorado');
    return { updated: 0, error: 'Token não configurado' };
  }
  if (syncInProgress) return { updated: 0, error: 'Sync em andamento' };

  syncInProgress = true;
  console.log(`[${new Date().toLocaleTimeString()}] Iniciando sync com ClickUp...`);

  try {
    // 1. Carregar tarefas do DB
    const dbRow   = stmtGetOne.get('atm_all_tasks');
    const dbTasks = dbRow ? JSON.parse(dbRow.value) : {};

    // 2. Carregar projetos padrão do HTML
    const projects = parseProjectsFromHTML();

    // 3. Mesclar: DB tem prioridade sobre HTML
    const allTasks = {};
    for (const proj of projects) {
      const key = String(proj.id);
      allTasks[key] = dbTasks[key] !== undefined ? dbTasks[key] : (proj.tarefas || []);
    }
    for (const [k, v] of Object.entries(dbTasks)) {
      if (!allTasks[k]) allTasks[k] = v;
    }

    // 4. Coletar IDs do ClickUp em tarefas com link (suporta duplicatas entre projetos)
    const cuIds = {}; // cuId → [{ key, idx }, ...]
    for (const [key, tasks] of Object.entries(allTasks)) {
      for (let i = 0; i < tasks.length; i++) {
        const match = tasks[i].link?.match(/clickup\.com\/t\/([a-z0-9]+)/i);
        if (match) {
          const id = match[1];
          if (!cuIds[id]) cuIds[id] = [];
          cuIds[id].push({ key, idx: i });
        }
      }
    }

    const ids = Object.keys(cuIds);
    console.log(`  ${ids.length} tarefas com link ClickUp encontradas`);

    // 5. Buscar dados do ClickUp para cada tarefa (sem modificar DB ainda)
    const clickupUpdates = {}; // cuId → { status, resp, prazo }
    for (let i = 0; i < ids.length; i++) {
      const cuId   = ids[i];
      const cuTask = await fetchClickUpTask(cuId);
      if (!cuTask || cuTask.err) continue;

      clickupUpdates[cuId] = {
        status: mapStatus(cuTask),
        resp:   mapAssignees(cuTask.assignees),
        prazo:  formatDue(cuTask.due_date),
      };

      // Pausa pequena para não estourar rate limit
      if (i < ids.length - 1) await new Promise(r => setTimeout(r, 120));
    }

    // 6. Ler estado MAIS RECENTE do DB (pode ter mudado durante as chamadas acima)
    //    para não sobrescrever alterações feitas pelo usuário durante o sync
    const freshRow   = stmtGetOne.get('atm_all_tasks');
    const freshTasks = freshRow ? JSON.parse(freshRow.value) : dbTasks;

    // Reconstruir allTasks com base no estado fresco
    const freshAll = {};
    for (const proj of projects) {
      const key = String(proj.id);
      freshAll[key] = freshTasks[key] !== undefined ? freshTasks[key] : (proj.tarefas || []);
    }
    for (const [k, v] of Object.entries(freshTasks)) {
      if (!freshAll[k]) freshAll[k] = v;
    }

    // Aplicar atualizações do ClickUp sobre o estado fresco
    let updated = 0;
    for (const [cuId, updates] of Object.entries(clickupUpdates)) {
      const occurrences = cuIds[cuId];
      for (const { key, idx } of occurrences) {
        // Encontrar tarefa pelo link no estado fresco (índice pode ter mudado)
        const freshTaskArr = freshAll[key];
        if (!freshTaskArr) continue;
        const task = freshTaskArr.find(t => t.link && t.link.includes(cuId));
        if (!task) continue;
        let changed = false;
        if (updates.status && task.status !== updates.status) { task.status = updates.status; changed = true; }
        if (updates.resp   && task.resp   !== updates.resp)   { task.resp   = updates.resp;   changed = true; }
        if (updates.prazo  && task.prazo  !== updates.prazo)  { task.prazo  = updates.prazo;  changed = true; }
        if (changed) updated++;
      }
    }

    // 7. Salvar estado fresco + atualizações ClickUp
    stmtUpsert.run('atm_all_tasks', JSON.stringify(freshAll));

    // 7. Sincronizar funil comercial
    await syncFunil();

    lastSync = new Date().toISOString();
    console.log(`  Sync concluído: ${updated} tarefa(s) atualizada(s)`);
    return { updated, total: ids.length, lastSync };

  } catch(e) {
    console.error('Erro no sync ClickUp:', e);
    return { updated: 0, error: e.message };
  } finally {
    syncInProgress = false;
  }
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/storage', (req, res) => {
  try {
    const rows   = stmtGetAll.all();
    const result = {};
    for (const row of rows) {
      try { result[row.key] = JSON.parse(row.value); }
      catch { result[row.key] = row.value; }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/storage/:key', (req, res) => {
  try {
    const row = stmtGetOne.get(req.params.key);
    if (!row) return res.status(404).json({ error: 'Not found' });
    let value;
    try { value = JSON.parse(row.value); } catch { value = row.value; }
    res.json({ value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/storage/:key', (req, res) => {
  try {
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'Missing value' });
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    stmtUpsert.run(req.params.key, serialized);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/storage/:key', (req, res) => {
  try {
    stmtDelete.run(req.params.key);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/migrate', (req, res) => {
  try {
    const { data } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Body must be { data: { key: value } }' });
    }
    const { n } = stmtCount.get();
    if (n > 0) {
      return res.json({ migrated: 0, skipped: true, reason: 'DB already has data' });
    }
    const insertMany = db.transaction((entries) => {
      let count = 0;
      const stmt = db.prepare('INSERT OR IGNORE INTO storage (key, value) VALUES (?, ?)');
      for (const [key, value] of entries) {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        const info = stmt.run(key, serialized);
        count += info.changes;
      }
      return count;
    });
    const migrated = insertMany(Object.entries(data));
    res.json({ migrated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: DB_PATH });
});

/** Dispara sync manual */
app.get('/api/sync-clickup', async (req, res) => {
  const result = await syncClickUp();
  res.json(result);
});

/** Status do último sync */
app.get('/api/sync-status', (req, res) => {
  res.json({
    lastSync,
    syncInProgress,
    hasToken: !!CLICKUP_TOKEN
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Dashboard Grupo ATM — Storage Server`);
  console.log(`  ────────────────────────────────────`);
  console.log(`  Listening on  http://localhost:${PORT}`);
  console.log(`  SQLite DB     ${DB_PATH}`);
  console.log(`  ClickUp sync  ${CLICKUP_TOKEN ? 'ativo (a cada 15 min)' : 'inativo (sem token)'}\n`);
});

// ── Auto sync ─────────────────────────────────────────────────────────────────
if (CLICKUP_TOKEN) {
  setTimeout(() => syncClickUp(), 5000);                // sync inicial após 5s
  setInterval(() => syncClickUp(), 15 * 60 * 1000);    // a cada 15 minutos
}
