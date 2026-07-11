#!/usr/bin/env node
// Pipeline worker for stock dashboard (DSA-style decision dashboard)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, saveLatest, recordRun, finishRun, getLatest } from './db.mjs';
import { safeFetch } from './mozyfin.mjs';
import { buildDataPerspective } from './technicals.mjs';
import { generateDecisionDashboard } from './analyzer.mjs';
import { generateMarketReview } from './market-review.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const mode = (process.argv[2] || 'intraday').toLowerCase();

// Parse --tickers flag for targeted runs (comma-separated, e.g. --tickers VCB,FPT)
const tickersArgIdx = process.argv.indexOf('--tickers');
const targetTickers = tickersArgIdx >= 0 && process.argv[tickersArgIdx + 1]
  ? process.argv[tickersArgIdx + 1].split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  : null;
const tickers = targetTickers || config.tickers;
const isTargeted = !!targetTickers;

function hasError(result) {
  return !result || result.error != null;
}

async function fetchIntraday(db, ticker) {
  const sym = `${ticker}.VN`;
  console.log(`[intraday] ${ticker}: quote + ohlcv + ta`);
  const results = {};
  results.quote = await safeFetch(['quote', sym, '--limit', '1']);
  results.intraday_ohlcv = await safeFetch(['ohlcv', sym, '--timeframe', '1d', '--limit', '5']);
  results.ta = await safeFetch(['ta', sym, '--rsi', '14', '--macd', '--sma', '5,10,20']);

  for (const [kind, result] of Object.entries(results)) {
    saveLatest(db, ticker, kind, result);
  }
  return results;
}

async function fetchEod(db, ticker) {
  const sym = `${ticker}.VN`;
  console.log(`[eod] ${ticker}: stats + ohlcv + news + risk`);
  const results = {};
  results.stats = await safeFetch(['stats', sym]);
  results.ohlcv = await safeFetch(['ohlcv', sym, '--timeframe', '1d', '--limit', '90']);
  results.news = await safeFetch(['news', '--query', sym, '--limit', '15']);
  results.risk = await safeFetch(['risk', sym]);

  for (const [kind, result] of Object.entries(results)) {
    saveLatest(db, ticker, kind, result);
  }
  return results;
}

function getRows(node) {
  return node?.data?.rows || node?.rows || [];
}

async function generateDecision(db, ticker) {
  console.log(`[eod] ${ticker}: building Decision Dashboard via Mozy AI`);
  const quoteRows = getRows(getLatest(db, ticker, 'quote'));
  const ohlcvRows = getRows(getLatest(db, ticker, 'ohlcv'));
  const newsRows = getRows(getLatest(db, ticker, 'news'));
  const statsRows = getRows(getLatest(db, ticker, 'stats'));
  const riskRows = getRows(getLatest(db, ticker, 'risk'));

  // Check if any data kind already has a fresh error from this run
  const dataKinds = [
    getLatest(db, ticker, 'quote'),
    getLatest(db, ticker, 'ohlcv'),
    getLatest(db, ticker, 'stats'),
  ];
  const hasDataErrors = dataKinds.some(k => k?.data?.error != null);
  if (hasDataErrors) {
    console.log(`[eod] ${ticker}: skipping decision — data fetch errors detected`);
    saveLatest(db, ticker, 'decision', { error: 'API data unavailable — không thể tạo phân tích', _data_error: true });
    return;
  }

  const today = quoteRows[quoteRows.length - 1] || {};
  const stats = statsRows[0] || {};

  const dataPerspective = buildDataPerspective(ohlcvRows);
  saveLatest(db, ticker, 'data_perspective', dataPerspective || { error: 'insufficient ohlcv' });

  const ohlcvTail = ohlcvRows.slice(-10);
  if (today.close == null && ohlcvTail.length) today.close = ohlcvTail[ohlcvTail.length - 1].close;

  try {
    const dashboard = await generateDecisionDashboard({
      ticker,
      name: ticker,
      today,
      dataPerspective,
      ohlcvTail,
      stats,
      news: newsRows,
      riskRows
    });
    saveLatest(db, ticker, 'decision', dashboard);
    console.log(`[eod] ${ticker}: dashboard score=${dashboard.sentiment_score} advice=${dashboard.operation_advice}`);
  } catch (e) {
    console.error(`[eod] ${ticker} decision failed:`, e.message);
    saveLatest(db, ticker, 'decision', { error: e.message });
  }
}

async function runMarketReview(db) {
  console.log('[eod] generating market review');
  try {
    const review = await generateMarketReview();
    db.prepare(`
      INSERT INTO latest (ticker, kind, ts, payload)
      VALUES ('_MARKET', 'review', ?, ?)
      ON CONFLICT(ticker, kind) DO UPDATE SET ts=excluded.ts, payload=excluded.payload
    `).run(Date.now(), JSON.stringify(review));
  } catch (e) {
    console.error('[eod] market review failed:', e.message);
    db.prepare(`
      INSERT INTO latest (ticker, kind, ts, payload)
      VALUES ('_MARKET', 'review', ?, ?)
      ON CONFLICT(ticker, kind) DO UPDATE SET ts=excluded.ts, payload=excluded.payload
    `).run(Date.now(), JSON.stringify({ error: e.message }));
  }
}

async function run() {
  const db = openDb();
  const runId = recordRun(db, mode);
  let status = 'ok';
  let message = '';
  try {
    for (const ticker of tickers) {
      const tickerErrors = [];
      try {
        if (mode === 'intraday' || mode === 'all' || mode === 'eod') {
          const intraResults = await fetchIntraday(db, ticker);
          for (const [kind, r] of Object.entries(intraResults)) {
            if (hasError(r)) tickerErrors.push(`${kind}: ${r.error}`);
          }
        }
        if (mode === 'eod' || mode === 'all') {
          const eodResults = await fetchEod(db, ticker);
          for (const [kind, r] of Object.entries(eodResults)) {
            if (hasError(r)) tickerErrors.push(`${kind}: ${r.error}`);
          }
          await generateDecision(db, ticker);
        }
      } catch (e) {
        console.error(`[${mode}] ${ticker} error:`, e.message);
        tickerErrors.push(`pipeline: ${e.message}`);
        message += `${ticker}:${e.message}; `;
      }
      // Save per-ticker pipeline status
      saveLatest(db, ticker, '_pipeline_status', {
        ok: tickerErrors.length === 0,
        mode,
        ts: Date.now(),
        errors: tickerErrors.length > 0 ? tickerErrors : undefined,
      });
    }
    if ((mode === 'eod' || mode === 'all') && !isTargeted) {
      await runMarketReview(db);
    }
  } catch (e) {
    status = 'error';
    message = e.message;
  } finally {
    finishRun(db, runId, status, message || null);
    db.close();
    console.log(`[${mode}] done: ${status}`);
  }
}

run().catch(err => { console.error('pipeline crashed:', err); process.exit(1); });
