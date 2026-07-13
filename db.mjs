import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'data', 'stock-dashboard.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export function openDb() {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      ticker TEXT NOT NULL,
      kind   TEXT NOT NULL,
      ts     INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (ticker, kind, ts)
    );

    CREATE TABLE IF NOT EXISTS latest (
      ticker TEXT NOT NULL,
      kind   TEXT NOT NULL,
      ts     INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (ticker, kind)
    );

    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT,
      message TEXT
    );
  `);
  return db;
}

export function saveLatest(db, ticker, kind, payload) {
  const ts = Date.now();
  const json = JSON.stringify(payload);
  db.prepare(`
    INSERT INTO latest (ticker, kind, ts, payload)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(ticker, kind) DO UPDATE SET ts=excluded.ts, payload=excluded.payload
  `).run(ticker, kind, ts, json);
  db.prepare(`
    INSERT OR IGNORE INTO snapshots (ticker, kind, ts, payload) VALUES (?, ?, ?, ?)
  `).run(ticker, kind, ts, json);
}

export function getLatest(db, ticker, kind) {
  const row = db.prepare(`SELECT ts, payload FROM latest WHERE ticker=? AND kind=?`).get(ticker, kind);
  if (!row) return null;
  return { ts: row.ts, data: JSON.parse(row.payload) };
}

export function getAllLatest(db, ticker) {
  const rows = db.prepare(`SELECT kind, ts, payload FROM latest WHERE ticker=?`).all(ticker);
  const out = {};
  for (const r of rows) out[r.kind] = { ts: r.ts, data: JSON.parse(r.payload) };
  return out;
}

export function getHistory(db, ticker, kind, limit = 60) {
  const rows = db.prepare(`
    SELECT ts, payload FROM snapshots WHERE ticker=? AND kind=? ORDER BY ts DESC LIMIT ?
  `).all(ticker, kind, limit);
  return rows.map(r => ({ ts: r.ts, data: JSON.parse(r.payload) })).reverse();
}

export function recordRun(db, mode) {
  const info = db.prepare(`
    INSERT INTO pipeline_runs (mode, started_at) VALUES (?, ?)
  `).run(mode, Date.now());
  return info.lastInsertRowid;
}

export function finishRun(db, id, status, message = null) {
  db.prepare(`
    UPDATE pipeline_runs SET finished_at=?, status=?, message=? WHERE id=?
  `).run(Date.now(), status, message, id);
}

export function lastRun(db, mode = null) {
  if (mode) {
    return db.prepare(`SELECT * FROM pipeline_runs WHERE mode=? ORDER BY started_at DESC LIMIT 1`).get(mode);
  }
  return db.prepare(`SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT 1`).get();
}
