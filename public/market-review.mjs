// Watchlist Review — focus on configured tickers only (DGC, MSN, SCS)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askMozy } from './mozy-ask.mjs';
import { safeFetch } from './mozyfin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

export async function generateMarketReview() {
  // Pull data for each watchlist ticker
  const watchlist = config.tickers;
  const tickerData = {};

  for (const t of watchlist) {
    const sym = `${t}.VN`;
    try {
      const [q, ohlcv, news] = await Promise.all([
        safeFetch(['quote', sym], { timeoutMs: 15000 }),
        safeFetch(['ohlcv', sym, '--timeframe', '1d', '--limit', '10'], { timeoutMs: 15000 }),
        safeFetch(['news', '--query', sym, '--limit', '5'], { timeoutMs: 15000 }),
      ]);
      tickerData[t] = {
        quote: q?.rows?.[q.rows.length - 1] || q?.data?.rows?.[0] || {},
        ohlcv: ohlcv?.rows || ohlcv?.data?.rows || [],
        news: news?.rows || news?.data?.rows || [],
      };
    } catch (_) {
      tickerData[t] = { error: 'fetch failed' };
    }
  }

  const prompt = `Bạn là trợ lý phân tích. NHIỆM VỤ: Phân tích ${watchlist.length} cổ phiếu trong watchlist dựa trên dữ liệu thực bên dưới.

⚠️ QUAN TRỌNG: Đây là "Phân tích Watchlist", KHÔNG phải "Market Review". KHÔNG viết về VN-Index, HNX-Index, UPCOM. KHÔNG dùng schema có "indices", "breadth", "sectors", "foreign_flow", "highlights".

# Dữ liệu thực:
${JSON.stringify(tickerData, null, 2)}

# Output JSON (CHÍNH XÁC schema này, không thêm bớt key ngoài danh sách):
{
  "headline": "tóm tắt watchlist",
  "watchlist": [{
    "ticker": "MÃ",
    "price": "giá",
    "change": "+/-x%",
    "sentiment": "tích cực|tiêu cực|trung lập",
    "key_signals": ["tín hiệu"],
    "news_headlines": ["tin"],
    "recommendation": "khuyến nghị"
  }],
  "overall_sentiment": "tổng quan",
  "risk_alerts": ["rủi ro"],
  "outlook": "nhận định"
}

KHÔNG markdown. KHÔNG thêm text ngoài JSON. Chỉ JSON, không gì khác. Tiếng Việt.`;

  let out;
  try {
    out = await askMozy(prompt, { mode: 'simple_chat', timeoutSec: 420 });
  } catch (err) {
    const msg = String(err?.message || err);
    if (!/timed out|status=thinking/i.test(msg)) throw err;
    out = await askMozy(prompt, { mode: 'auto', timeoutSec: 900 });
  }

  const clean = out.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/m, '').trim();
  const m = clean.match(/\{[\s\S]*\}\s*$/);
  if (!m) throw new Error('Mozy did not return JSON for watchlist review');
  return JSON.parse(m[0]);
}
