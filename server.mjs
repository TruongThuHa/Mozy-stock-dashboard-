import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openDb, getAllLatest, getLatest, getHistory, lastRun } from './db.mjs';
import { safeFetch } from './mozyfin.mjs';

// ── Social posts helpers ──
let socialOverviewCache = { data: null, ts: 0 };
let socialSearchCache = {};
const SOCIAL_CACHE_TTL = 10 * 60 * 1000; // 10 min for overview
const SOCIAL_SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 min for search

function parseSocialPost(raw) {
  const posts = [];
  const sections = raw.split(/^---/gm);
  for (const sec of sections) {
    const lines = sec.trim().split('\n').filter(l => l.trim());
    if (!lines.length || !lines[0].startsWith('- started_at:')) continue;
    const post = {};
    for (const line of lines) {
      const m = line.match(/^- (\w+):\s*(.*)/);
      if (m) {
        const key = m[1];
        let val = m[2].trim();
        if (key === 'started_at') val = val.replace(/\.\d+Z$/, 'Z');
        post[key] = val;
      } else if (line.startsWith('- ') && !line.startsWith('- started_at:') && !line.startsWith('- sender_name:') && !line.startsWith('- headline:') && !line.startsWith('- summary_vi:')) {
        if (post.summary_vi) post.summary_vi += '\n' + line.slice(2);
      }
    }
    if (post.started_at) posts.push(post);
  }
  posts.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  return posts;
}

function filterLast24h(posts) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return posts.filter(p => new Date(p.started_at).getTime() > cutoff);
}

async function fetchTickerPosts(ticker, limit = 12) {
  const entity = ticker.includes('.VN') ? ticker : `${ticker}.VN`;
  try {
    const { raw } = await safeFetch(['social-post', '--entities', entity, '--limit', String(limit), '--md'], { timeoutMs: 30000 });
    return parseSocialPost(raw || '');
  } catch (e) {
    console.error(`[social] fetch for ${ticker} failed:`, e.message);
    return [];
  }
}

// ── AI Summary Generation (now local, no Mozy AI calls) ──

function generateTickerSummary(posts, ticker) {
  if (!posts.length) return null;

  // Extract ticker-relevant snippet from each post's summary_vi
  function extractTickerSnippet(p) {
    const text = p.summary_vi || p.headline || '';
    if (!text) return '—';
    const sentences = text.split(/(?<=[.!?])\s+|\n/);
    for (const s of sentences) {
      if (s.toUpperCase().includes(ticker.toUpperCase())) {
        return s.replace(/\*\*/g, '').trim().slice(0, 150);
      }
    }
    return text.replace(/\*\*/g, '').trim().slice(0, 120);
  }

  // Show góc nhìn của từng nguồn
  const rows = posts.slice(0, 10).map(p => {
    const d = (p.started_at || '').slice(5, 10).split('-').reverse().join('/');
    const view = extractTickerSnippet(p);
    return `| **${p.sender_name || '?'}** | ${d} | ${view} |`;
  }).join('\n');

  // Count sources
  const sources = {};
  for (const p of posts) {
    const name = p.sender_name || 'Khác';
    sources[name] = (sources[name] || 0) + 1;
  }
  const sourceList = Object.entries(sources)
    .sort((a, b) => b[1] - a[1])
    .map(s => `${s[0]} (${s[1]} bài)`).join(', ');

  return `**Góc nhìn về ${ticker}:** ${posts.length} post từ ${Object.keys(sources).length} nguồn: ${sourceList}.

| Nguồn | Ngày | Góc nhìn |
|---|---|---|
${rows}`;
}

function generateOverallSummary(posts, tickers, globalPosts) {
  // Use ONLY global 20 posts (no ticker filter)
  const all = (globalPosts.length >= 5 ? globalPosts : posts).slice(0, 20);
  if (!all.length) return null;

  // Topic definitions with detection patterns
  const topicDefs = [
    { id: 'banking', label: 'Nhóm Ngân hàng', re: /ngân hàng|bank|acb|vcb|bid|ctg|mbb|stb|tpb|ocb|shb|vpb|hdb|tcb|vib|msb/i },
    { id: 'realestate', label: 'Nhóm Bất động sản', re: /bất động sản|bđs|vinhomes|novaland|dxg|nvl|pdr|khang điền|vhm|vic/i },
    { id: 'securities', label: 'Nhóm Chứng khoán', re: /chứng khoán|ctck|ssi|hcm|vnd|shs|vci|mbs|fpt|ors|vix/i },
    { id: 'steel', label: 'Nhóm Thép', re: /thép|steel|hpg|hsg|nkg|tlh/i },
    { id: 'macro', label: 'Vĩ mô & CPI', re: /cpi|lạm phát|fed|lãi suất|vĩ mô|kinh tế|usd|dxy/i },
    { id: 'bottom', label: 'Tạo đáy & Đảo chiều', re: /bull.?trap|bẫy|bắt đáy|tạo đáy|đảo chiều|phục hồi|bottom/i },
    { id: 'flow', label: 'Dòng tiền & Thanh khoản', re: /dòng tiền|khối ngoại|thanh khoản|khớp lệnh|volume/i },
    { id: 'oilgas', label: 'Dầu khí & Năng lượng', re: /dầu khí|oil|gas|plx|pvs|bsr|pvd/i },
    { id: 'retail', label: 'Bán lẻ & Tiêu dùng', re: /bán lẻ|tiêu dùng|retail|mwg|frt|pnj|msn|vnm/i },
  ];

  // Match posts to topics
  const topics = {};
  for (const p of all) {
    const h = (p.headline || '') + ' ' + (p.summary_vi || '').slice(0, 400);
    for (const td of topicDefs) {
      if (td.re.test(h)) {
        if (!topics[td.id]) topics[td.id] = { ...td, posts: [] };
        topics[td.id].posts.push(p);
      }
    }
  }

  // Sort by post count
  const sorted = Object.values(topics).sort((a, b) => b.posts.length - a.posts.length).slice(0, 5);
  if (!sorted.length) return '🔥 Chủ đề nóng:\n\n• Chưa phát hiện chủ đề nổi bật.';

  // Build output
  let out = '🔥 Chủ đề nóng:\n\n';
  for (const t of sorted) {
    // Build Nhận định — use summary_vi (Vietnamese) not headline (often English)
    const sources = t.posts.slice(0, 3).map(p => {
      const name = p.sender_name || '?';
      const viText = (p.summary_vi || p.headline || '').replace(/\*\*/g, '').slice(0, 150);
      return `**${name}**: ${viText}`;
    });

    // Determine dominant sentiment for Khuyến nghị
    let bull = 0, bear = 0, hold = 0;
    const recs = t.posts.slice(0, 5).map(p => {
      const h = ((p.headline || '') + ' ' + (p.summary_vi || '').slice(0, 300)).toLowerCase();
      const bullish = /tăng|tích cực|bứt phá|cơ hội mua|mua vào|khả quan|đà tăng|giải ngân/i.test(h);
      const bearish = /giảm|bán ra|thoát hàng|cắt lỗ|áp lực|lao dốc|rủi ro|bull.?trap|bẫy tăng|thận trọng/i.test(h);
      if (bullish && !bearish) { bull++; return `${p.sender_name || '?'} → MUA`; }
      else if (bearish && !bullish) { bear++; return `${p.sender_name || '?'} → BÁN`; }
      else { hold++; return `${p.sender_name || '?'} → GIỮ`; }
    });

    const action = bull > bear ? 'Phần lớn khuyến nghị mua'
      : bear > bull ? 'Đa số khuyên bán/chốt lời'
      : 'Nhiều ý kiến trái chiều';

    out += `• ${t.label}\n`;
    out += `─ Nhận định: ${sources.join(' | ')}\n`;
    out += `─ Khuyến nghị: ${action} (${recs.join(', ')})\n`;
    out += '\n';
  }

  return out.trim();
}

// ── Main fetch functions ──
async function fetchSocialOverview() {
  const now = Date.now();
  if (socialOverviewCache.data && (now - socialOverviewCache.ts) < SOCIAL_CACHE_TTL) {
    return socialOverviewCache.data;
  }

  const tickers = config.tickers || [];
  if (!tickers.length) return { overall_summary: null, ticker_summaries: [], raw_posts: [] };

  // Step 1: Fetch posts for all tickers in parallel (for AI summaries)
  const perTickerPosts = {};
  const allPosts = [];
  const seen = new Set();

  const fetchAll = tickers.map(async (ticker) => {
    const posts = await fetchTickerPosts(ticker, 15);
    perTickerPosts[ticker] = posts;
    for (const p of posts) {
      const dedupKey = `${p.started_at}|${p.sender_name || ''}|${(p.headline || '').slice(0, 40)}`;
      if (!seen.has(dedupKey)) {
        seen.add(dedupKey);
        allPosts.push(p);
      }
    }
  });

  // Also fetch global latest 20 posts (no filter) for raw display
  let globalPosts = [];
  const fetchGlobal = (async () => {
    try {
      const { raw } = await safeFetch(['social-post', '--limit', '20', '--md'], { timeoutMs: 30000 });
      globalPosts = parseSocialPost(raw || '');
    } catch (e) {
      console.error('[social] global fetch failed:', e.message);
    }
  })();

  await Promise.all([...fetchAll, fetchGlobal]);

  // Sort + filter last 24h for stats
  allPosts.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  const recent24h = filterLast24h(allPosts);

  // Step 2: Generate summaries locally
  const overallSummary = generateOverallSummary(allPosts, tickers, globalPosts);
  const tickerSummaries = tickers.map(ticker => ({
    ticker,
    summary: generateTickerSummary(perTickerPosts[ticker] || [], ticker)
  }));

  // Raw posts: 20 post mới nhất từ global (không filter)
  const rawTop20 = globalPosts.slice(0, 20);

  const result = {
    overall_summary: overallSummary,
    ticker_summaries: tickerSummaries,
    raw_posts: rawTop20,
    total_fetched: allPosts.length,
    total_24h: recent24h.length
  };

  socialOverviewCache = { data: result, ts: now };
  return result;
}

async function searchSocialPosts(query) {
  const now = Date.now();
  const cacheKey = query.toLowerCase().trim();
  const cached = socialSearchCache[cacheKey];
  if (cached && (now - cached.ts) < SOCIAL_SEARCH_CACHE_TTL) {
    return cached.data;
  }

  // Find entity
  let entityId = null;
  let entityName = query;
  try {
    const { rows } = await safeFetch(['search', '--query', query, '--md'], { timeoutMs: 30000 });
    if (rows?.length > 0) {
      entityId = rows[0].id || rows[0].symbol;
      entityName = rows[0].symbol || query;
    }
  } catch (e) {
    console.error('[social] search failed:', e.message);
  }

  if (!entityId) {
    const result = { posts: [], summary: null, entity: query };
    socialSearchCache[cacheKey] = { data: result, ts: now };
    return result;
  }

  // Fetch posts + generate summary
  try {
    const posts = await fetchTickerPosts(entityId, 20);
    const summary = generateTickerSummary(posts, entityName);
    const result = { posts, summary, entity: entityName };
    socialSearchCache[cacheKey] = { data: result, ts: now };
    return result;
  } catch (e) {
    console.error('[social] search fetch failed:', e.message);
    return { posts: [], summary: null, entity: entityName };
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, 'config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

let config = loadConfig();
let configChangeDebounce = null;
const CONFIG_DEBOUNCE_MS = 800; // debounce file watcher for rapid saves

const app = express();
app.use(express.json());

// API
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), tickers: config.tickers });
});

app.get('/api/overview', (_req, res) => {
  const db = openDb();
  try {
    const tickers = config.tickers.map(t => {
      const all = getAllLatest(db, t);
      return {
        ticker: t,
        quote: all.quote?.data,
        ta_latest: all.ta?.data,
        intraday_ohlcv: all.intraday_ohlcv?.data,
        data_perspective: all.data_perspective?.data,
        decision: all.decision?.data,
        pipeline_status: all._pipeline_status?.data,
        last_quote_ts: all.intraday_ohlcv?.ts || all.quote?.ts || null,
        last_decision_ts: all.decision?.ts || null,
      };
    });
    const review = db.prepare(`SELECT ts, payload FROM latest WHERE ticker='_MARKET' AND kind='review'`).get();
    res.json({
      tickers,
      market_review: review ? { ts: review.ts, data: JSON.parse(review.payload) } : null,
      pipeline: {
        last_intraday: lastRun(db, 'intraday'),
        last_eod: lastRun(db, 'eod'),
      }
    });
  } finally {
    db.close();
  }
});

app.get('/api/stock/:ticker', (req, res) => {
  const t = req.params.ticker.toUpperCase();
  if (!config.tickers.includes(t)) return res.status(404).json({ error: 'unknown ticker' });
  const db = openDb();
  try {
    res.json({
      ticker: t,
      ...getAllLatest(db, t)
    });
  } finally {
    db.close();
  }
});

app.get('/api/stock/:ticker/history/:kind', (req, res) => {
  const t = req.params.ticker.toUpperCase();
  if (!config.tickers.includes(t)) return res.status(404).json({ error: 'unknown ticker' });
  const limit = Math.min(parseInt(req.query.limit) || 60, 500);
  const db = openDb();
  try {
    res.json({ history: getHistory(db, t, req.params.kind, limit) });
  } finally {
    db.close();
  }
});

let refreshing = false;
function startPipeline(mode, tickers = null) {
  if (refreshing) return false;
  refreshing = true;
  const args = [path.join(__dirname, 'pipeline.mjs'), mode];
  if (tickers && tickers.length) args.push('--tickers', tickers.join(','));
  const child = spawn('node', args, {
    cwd: __dirname,
    stdio: 'ignore',
    detached: true
  });
  child.unref();
  child.on('error', (err) => {
    console.error('[scheduler] pipeline spawn error:', err.message);
    refreshing = false;
  });
  child.on('exit', () => { refreshing = false; });
  console.log(`[scheduler] started pipeline: ${mode}${tickers ? ` (${tickers.join(',')})` : ''}`);
  return true;
}

app.post('/api/refresh', (req, res) => {
  const mode = (req.body?.mode || 'intraday').toLowerCase();
  if (!['intraday', 'eod', 'all'].includes(mode)) return res.status(400).json({ error: 'invalid mode' });
  if (!startPipeline(mode)) return res.status(429).json({ error: 'refresh already running' });
  res.json({ ok: true, mode, started: true });
});

// ── Social Posts API ──
app.get('/api/social-overview', async (_req, res) => {
  try {
    const data = await fetchSocialOverview();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, overall_summary: null, ticker_summaries: [], raw_posts: [] });
  }
});

app.get('/api/social-posts', async (req, res) => {
  const search = (req.query.search || '').trim();
  try {
    const result = await searchSocialPosts(search);
    res.json({
      posts: result.posts || [],
      summary: result.summary || null,
      entity: result.entity || search,
      count: (result.posts || []).length,
      search: search || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message, posts: [], summary: null });
  }
});

app.post('/api/social-cache-clear', (_req, res) => {
  socialOverviewCache = { data: null, ts: 0 };
  socialSearchCache = {};
  res.json({ ok: true, message: 'Social cache cleared' });
});

// --- Auto-refresh scheduler (timezone-aware, no external deps) ---
const TZ = config.eodTimezone || 'Asia/Saigon';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function tzNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value;
  return {
    weekday: get('weekday'),
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`
  };
}

// Parse "m h * * dow" — only minute+hour are honored (matches config format)
function parseEodCron(expr) {
  const f = (expr || '0 16 * * 1-5').trim().split(/\s+/);
  return { minute: parseInt(f[0], 10) || 0, hour: parseInt(f[1], 10) || 16 };
}
const eodTime = parseEodCron(config.eodCronExpr);
const intradayMs = config.intradayIntervalMs || 300000;

function isMarketHours(n) {
  if (!WEEKDAYS.includes(n.weekday)) return false;
  const mins = n.hour * 60 + n.minute;
  return mins >= 9 * 60 && mins <= 15 * 60; // 09:00–15:00 VN
}

// Intraday refresh during market hours
setInterval(() => {
  const n = tzNow();
  if (isMarketHours(n)) startPipeline('intraday');
}, intradayMs);

// EOD refresh: fire once when local time hits the configured weekday cron slot
let lastEodDate = null;
setInterval(() => {
  const n = tzNow();
  if (!WEEKDAYS.includes(n.weekday)) return;
  if (n.hour === eodTime.hour && n.minute === eodTime.minute && lastEodDate !== n.dateKey) {
    lastEodDate = n.dateKey;
    startPipeline('eod');
  }
}, 60000);

console.log(`[scheduler] intraday every ${Math.round(intradayMs / 1000)}s during market hours; EOD ${String(eodTime.hour).padStart(2, '0')}:${String(eodTime.minute).padStart(2, '0')} ${TZ} on weekdays`);

// Static dashboard (no cache for dev)
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}}));

const port = process.env.PORT || config.port || 7878;
const host = process.env.HOST || config.host || '127.0.0.1';

if (host !== '127.0.0.1' && host !== 'localhost') {
  console.warn(`[security] ⚠️  Server đang bind ${host} — dashboard KHÔNG có auth, mọi máy trong mạng đều truy cập & trigger được pipeline. Chỉ nên dùng 127.0.0.1 trừ khi bro tự thêm lớp bảo vệ (reverse proxy + auth).`);
}

// ── Config hot-reload ──
// Watches config.json for changes; on change, diffs ticker list and auto-triggers
// pipeline for newly added tickers (intraday + eod data). Dashboard API picks up
// the new config immediately without server restart.

function diffTickers(oldList, newList) {
  const oldSet = new Set(oldList);
  const newSet = new Set(newList);
  const added = [...newSet].filter(t => !oldSet.has(t));
  const removed = [...oldSet].filter(t => !newSet.has(t));
  return { added, removed };
}

function onConfigChanged() {
  let newConfig;
  try {
    newConfig = loadConfig();
  } catch (e) {
    console.error('[config-watch] failed to parse config.json:', e.message);
    return;
  }

  const oldTickers = config.tickers || [];
  const newTickers = newConfig.tickers || [];
  const { added, removed } = diffTickers(oldTickers, newTickers);

  if (added.length === 0 && removed.length === 0) {
    console.log('[config-watch] config changed but tickers unchanged, reloading config');
    config = newConfig;
    return;
  }

  console.log(`[config-watch] tickers changed | added: [${added.join(',')}] | removed: [${removed.join(',')}]`);
  config = newConfig;

  if (added.length > 0) {
    console.log(`[config-watch] auto-triggering pipeline (all) for new tickers: ${added.join(',')}`);
    // Dùng chung guard `refreshing` với /api/refresh; nếu đang chạy thì thử lại sau.
    if (!startPipeline('all', added)) {
      console.log('[config-watch] pipeline đang bận, sẽ thử lại sau 5s cho:', added.join(','));
      setTimeout(() => startPipeline('all', added), 5000);
    }
  }
}

// fs.watchFile (polling) ổn định hơn fs.watch trên Linux/WSL, tránh mất watch khi
// editor lưu kiểu atomic-rename. Debounce chống trigger dồn dập.
fs.watchFile(configPath, { interval: 1000 }, (curr, prev) => {
  if (curr.mtimeMs === prev.mtimeMs) return;
  clearTimeout(configChangeDebounce);
  configChangeDebounce = setTimeout(onConfigChanged, CONFIG_DEBOUNCE_MS);
});

console.log('[config-watch] watching config.json for changes');

app.listen(port, host, () => {
  console.log(`stock-dashboard server: http://${host}:${port}`);
});
