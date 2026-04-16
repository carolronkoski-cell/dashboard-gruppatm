/**
 * Dashboard Grupo ATM — SQLite persistence server
 * Node.js + Express + better-sqlite3
 *
 * Endpoints:
 *   GET    /api/storage          → { key: value, ... }  (all entries)
 *   GET    /api/storage/:key     → { value: ... }
 *   PUT    /api/storage/:key     → body: { value: ... }
 *   DELETE /api/storage/:key     → 204
 *   POST   /api/migrate          → body: { data: { key: value, ... } }
 *
 * Run: node server.js   (default port 3333)
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const Database = require('better-sqlite3');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT   = process.env.PORT || 3333;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'atm_dashboard.db');

// ── DB setup ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS storage (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Prepared statements for performance
const stmtGetAll    = db.prepare('SELECT key, value FROM storage');
const stmtGetOne    = db.prepare('SELECT value FROM storage WHERE key = ?');
const stmtUpsert    = db.prepare('INSERT INTO storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const stmtDelete    = db.prepare('DELETE FROM storage WHERE key = ?');
const stmtCount     = db.prepare('SELECT COUNT(*) as n FROM storage');

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// Serve the dashboard static files
app.use(express.static(__dirname));

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/storage
 * Returns all key-value pairs as an object { key: parsedValue, ... }
 */
app.get('/api/storage', (req, res) => {
  try {
    const rows = stmtGetAll.all();
    const result = {};
    for (const row of rows) {
      try { result[row.key] = JSON.parse(row.value); }
      catch { result[row.key] = row.value; }
    }
    res.json(result);
  } catch (err) {
    console.error('GET /api/storage error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/storage/:key
 * Returns { value: parsedValue } or 404
 */
app.get('/api/storage/:key', (req, res) => {
  try {
    const row = stmtGetOne.get(req.params.key);
    if (!row) return res.status(404).json({ error: 'Not found' });
    let value;
    try { value = JSON.parse(row.value); } catch { value = row.value; }
    res.json({ value });
  } catch (err) {
    console.error(`GET /api/storage/${req.params.key} error:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/storage/:key
 * Body: { value: anything }
 * Upserts the key.
 */
app.put('/api/storage/:key', (req, res) => {
  try {
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'Missing value' });
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    stmtUpsert.run(req.params.key, serialized);
    res.json({ ok: true });
  } catch (err) {
    console.error(`PUT /api/storage/${req.params.key} error:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/storage/:key
 * Removes the key. Returns 204.
 */
app.delete('/api/storage/:key', (req, res) => {
  try {
    stmtDelete.run(req.params.key);
    res.status(204).end();
  } catch (err) {
    console.error(`DELETE /api/storage/${req.params.key} error:`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/migrate
 * Body: { data: { key: stringValue, ... } }
 * Bulk-inserts keys that don't already exist (no overwrite).
 * Returns { migrated: N }
 */
app.post('/api/migrate', (req, res) => {
  try {
    const { data } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Body must be { data: { key: value } }' });
    }

    const { n } = stmtCount.get();
    if (n > 0) {
      // DB already has data — skip migration to avoid overwriting user changes
      return res.json({ migrated: 0, skipped: true, reason: 'DB already has data' });
    }

    const insertMany = db.transaction((entries) => {
      let count = 0;
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO storage (key, value) VALUES (?, ?)'
      );
      for (const [key, value] of entries) {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        const info = stmt.run(key, serialized);
        count += info.changes;
      }
      return count;
    });

    const migrated = insertMany(Object.entries(data));
    console.log(`Migration complete: ${migrated} keys imported.`);
    res.json({ migrated });
  } catch (err) {
    console.error('POST /api/migrate error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/health
 * Simple health check.
 */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: DB_PATH });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Dashboard Grupo ATM — Storage Server`);
  console.log(`  ────────────────────────────────────`);
  console.log(`  Listening on  http://localhost:${PORT}`);
  console.log(`  SQLite DB     ${DB_PATH}`);
  console.log(`  API base      http://localhost:${PORT}/api/storage\n`);
});
