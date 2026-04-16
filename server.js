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
  return MONTHS_PT[date.getMonth()];
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

    // 5. Buscar e atualizar cada tarefa
    let updated = 0;
    for (let i = 0; i < ids.length; i++) {
      const cuId       = ids[i];
      const occurrences = cuIds[cuId];
      const cuTask     = await fetchClickUpTask(cuId);
      if (!cuTask || cuTask.err) continue;

      const newStatus = mapStatus(cuTask);
      const newResp   = mapAssignees(cuTask.assignees);
      const newPrazo  = formatDue(cuTask.due_date);

      // Atualiza todas as ocorrências do mesmo link (pode existir em mais de um projeto)
      for (const { key, idx } of occurrences) {
        const task    = allTasks[key][idx];
        let   changed = false;

        if (newStatus && task.status !== newStatus) { task.status = newStatus; changed = true; }
        if (newResp   && task.resp   !== newResp)   { task.resp   = newResp;   changed = true; }
        if (newPrazo  && task.prazo  !== newPrazo)  { task.prazo  = newPrazo;  changed = true; }

        if (changed) updated++;
      }

      // Pausa pequena para não estourar rate limit
      if (i < ids.length - 1) await new Promise(r => setTimeout(r, 120));
    }

    // 6. Salvar no DB se houve mudanças
    stmtUpsert.run('atm_all_tasks', JSON.stringify(allTasks));

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
