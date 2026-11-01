# Mozy Stock Dashboard

Live local dashboard for VN stock watchlist using [Mozyfin](https://mozy.vn) as data source and Mozy AI for EOD decisions.

## Prerequisites

- **Node.js** >= 18
- **Mozyfin CLI** — installed and authenticated

### Setup Mozyfin CLI

Mozyfin CLI is the data source for this dashboard. It provides real-time quotes, OHLCV, stats, news, TA, and AI-powered analysis for Vietnam stocks.

```bash
# 1. Install Mozyfin CLI globally
npm install -g mozyfin-cli

# 2. Get an API key from https://mozy.vn and login
mozyfin login --api-key <YOUR_API_KEY>

# 3. Or set key as env var (for Mozy AI features)
export MOZYFIN_API_KEY=<YOUR_API_KEY>

# 4. Verify it works
mozyfin quote VCB.VN
```

See [Mozyfin docs](https://docs.mozy.vn) for full CLI reference.

## Quick Start

```bash
# 1. Run setup check (tự kiểm tra Node, mozyfin, API key, config...)
bash setup.sh

# 2. Fix any issues setup.sh reports, then:
npm install

# 3. Create your config (setup.sh tự làm bước này nếu thấy thiếu)
cp config.example.json config.json
# Edit config.json with your watchlist tickers

# 4. Fetch latest data
npm run pipeline:eod

# 5. Start dashboard
npm start
# Open http://127.0.0.1:7878
```

## Pipeline modes

| Mode | Command | What it does |
|------|---------|-------------|
| `intraday` | `npm run pipeline:intraday` | Quote + TA (light, every 5 min) |
| `eod` | `npm run pipeline:eod` | Stats + OHLCV + News + Risk + Mozy AI Decision (once/day after close) |
| `all` | `npm run pipeline:all` | Both intraday + eod |

## Social Posts Tab 💬

The dashboard includes a Social Posts tab for market sentiment analysis from social media sources:

**Overview view (default):**
- 🔥 **Chủ đề nóng** — topic-based market assessment from 20 latest posts
  - Detects themes: Ngân hàng, Bất động sản, Chứng khoán, Thép, Vĩ mô, Dòng tiền, etc.
  - Per topic: Nhận định (who said what) + Khuyến nghị (MUA/BÁN/GIỮ per source)
  - Instant, local keyword analysis — zero AI credits
- 📊 **Nhận định theo mã** — per-ticker source-by-source góc nhìn
- 📋 **20 post mới nhất** — raw, no filter

**Search:** Enter any ticker (e.g. HPG, VCB) → AI-powered summary + source viewpoints

**Refresh:** Click 🔄 Làm mới to clear cache and fetch fresh data

| Endpoint | Description |
|----------|-------------|
| `GET /api/social-overview` | Market assessment + per-ticker summaries + raw posts |
| `GET /api/social-posts?search=HPG` | AI summary for a specific ticker |
| `POST /api/social-cache-clear` | Clear social posts cache |

## Cron suggestion

```
*/5 9-15 * * 1-5  cd /path/to/mozy-stock-dashboard && npm run pipeline:intraday
0   16   * * 1-5  cd /path/to/mozy-stock-dashboard && npm run pipeline:eod
```

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Server health + ticker list |
| `GET /api/overview` | All watchlist data + last pipeline run |
| `GET /api/stock/:ticker` | Full data for one ticker |
| `GET /api/stock/:ticker/history/:kind?limit=60` | Snapshot history |
| `POST /api/refresh { mode: 'intraday' \| 'eod' \| 'all' }` | Trigger pipeline |

## Architecture

```
mozy-stock-dashboard/
├── server.mjs          # Express server @ 127.0.0.1:7878
├── pipeline.mjs        # Data pipeline worker
├── db.mjs              # SQLite helpers (better-sqlite3)
├── mozyfin.mjs         # Mozyfin CLI wrapper
├── mozy-ask.mjs        # Mozy AI ask wrapper
├── mozyfin-ask.cjs     # Mozy AI agent script
├── technicals.mjs      # TA indicators (SMA, RSI, MACD, etc.)
├── analyzer.mjs        # Decision Dashboard builder (prompt → AI → JSON)
├── market-review.mjs   # Watchlist review via AI
├── public/index.html   # Dashboard UI (Chart.js)
├── config.json         # Your watchlist + settings (gitignored)
└── config.example.json # Template config
```

## License

MIT
