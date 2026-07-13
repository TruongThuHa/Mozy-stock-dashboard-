// Technical indicators computed from OHLCV rows
// Each row: { timestamp, open, high, low, close, volume }

export function lastClose(rows) {
  if (!rows?.length) return null;
  return rows[rows.length - 1].close ?? null;
}

export function pctChange(rows) {
  if (!rows || rows.length < 2) return null;
  const a = rows[rows.length - 2].close;
  const b = rows[rows.length - 1].close;
  if (a == null || b == null) return null;
  return ((b - a) / a) * 100;
}

export function sma(rows, period, key = 'close') {
  if (!rows || rows.length < period) return null;
  const slice = rows.slice(-period);
  const sum = slice.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
  return sum / period;
}

export function smaSeries(rows, period, key = 'close') {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    const slice = rows.slice(i - period + 1, i + 1);
    const sum = slice.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
    out.push(sum / period);
  }
  return out;
}

export function emaSeries(values, period) {
  const out = [];
  if (!values?.length) return out;
  const k = 2 / (period + 1);
  // Seed EMA với SMA của `period` giá trị đầu (chuẩn hơn seed bằng values[0]).
  // Trước khi đủ `period` điểm thì trả null để không bịa số.
  if (values.length < period) {
    // Không đủ dữ liệu: seed tạm bằng giá trị đầu để chuỗi vẫn có độ dài đúng.
    let prev = values[0];
    out.push(prev);
    for (let i = 1; i < values.length; i++) {
      const v = values[i] ?? prev;
      prev = v * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }
  let seed = 0;
  for (let i = 0; i < period; i++) seed += Number(values[i]) || 0;
  seed /= period;
  for (let i = 0; i < period - 1; i++) out.push(null);
  let prev = seed;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    const v = values[i] ?? prev;
    prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function rsi(rows, period = 14, key = 'close') {
  if (!rows || rows.length < period + 1) return null;
  const closes = rows.map(r => Number(r[key]) || 0);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(rows, fast = 12, slow = 26, signal = 9, key = 'close') {
  if (!rows || rows.length < slow + signal) return null;
  const closes = rows.map(r => Number(r[key]) || 0);
  const fastE = emaSeries(closes, fast);
  const slowE = emaSeries(closes, slow);
  // MACD line chỉ hợp lệ khi cả 2 EMA đã có giá trị (slow EMA xuất hiện muộn hơn)
  const macdLine = closes.map((_, i) =>
    (fastE[i] == null || slowE[i] == null) ? null : fastE[i] - slowE[i]
  );
  // Lấy phần đuôi liên tục không null để tính signal EMA
  const firstValid = macdLine.findIndex(v => v != null);
  if (firstValid < 0) return null;
  const validMacd = macdLine.slice(firstValid);
  const signalTail = emaSeries(validMacd, signal);
  const last = validMacd.length - 1;
  const macdVal = validMacd[last];
  const signalVal = signalTail[last];
  if (macdVal == null || signalVal == null) return null;
  return {
    macd: macdVal,
    signal: signalVal,
    histogram: macdVal - signalVal
  };
}

export function maAlignment(rows) {
  const ma5 = sma(rows, 5);
  const ma10 = sma(rows, 10);
  const ma20 = sma(rows, 20);
  if (ma5 == null || ma10 == null || ma20 == null) return { ma5, ma10, ma20, alignment: 'unknown', is_bullish: null };
  let alignment = 'mixed';
  let is_bullish = null;
  if (ma5 > ma10 && ma10 > ma20) { alignment = 'bullish'; is_bullish = true; }
  else if (ma5 < ma10 && ma10 < ma20) { alignment = 'bearish'; is_bullish = false; }
  return { ma5, ma10, ma20, alignment, is_bullish };
}

export function biasMa(rows, period = 5) {
  const ma = sma(rows, period);
  const close = lastClose(rows);
  if (ma == null || close == null) return null;
  return ((close - ma) / ma) * 100;
}

export function biasStatus(bias) {
  if (bias == null) return 'unknown';
  if (bias > 8) return 'nguy_hiem';
  if (bias > 5) return 'canh_giac';
  if (bias < -8) return 'qua_ban';
  if (bias < -5) return 'chiet_khau';
  return 'an_toan';
}

export function trendScore({ ma5, ma10, ma20, rsi14, macd }) {
  let score = 50;
  if (ma5 != null && ma10 != null && ma20 != null) {
    if (ma5 > ma10 && ma10 > ma20) score += 20;
    else if (ma5 < ma10 && ma10 < ma20) score -= 20;
    else if (ma5 > ma10 || ma10 > ma20) score += 5;
    else score -= 5;
  }
  if (rsi14 != null) {
    if (rsi14 > 70) score -= 8;
    else if (rsi14 < 30) score += 8;
    else if (rsi14 > 55) score += 5;
    else if (rsi14 < 45) score -= 5;
  }
  if (macd?.histogram != null) {
    if (macd.histogram > 0) score += 5;
    else score -= 5;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function supportResistance(rows, lookback = 30) {
  if (!rows?.length) return { support: null, resistance: null };
  const slice = rows.slice(-lookback);
  let support = Infinity, resistance = -Infinity;
  for (const r of slice) {
    if (r.low != null && r.low < support) support = r.low;
    if (r.high != null && r.high > resistance) resistance = r.high;
  }
  return {
    support: support === Infinity ? null : support,
    resistance: resistance === -Infinity ? null : resistance
  };
}

export function buildDataPerspective(rows) {
  if (!rows?.length) return null;
  const ma = maAlignment(rows);
  const rsi14 = rsi(rows, 14);
  const macdVal = macd(rows);
  const bias5 = biasMa(rows, 5);
  const sr = supportResistance(rows, 30);
  const close = lastClose(rows);
  const score = trendScore({ ma5: ma.ma5, ma10: ma.ma10, ma20: ma.ma20, rsi14, macd: macdVal });
  return {
    trend_status: {
      ma_alignment: ma.alignment,
      is_bullish: ma.is_bullish,
      trend_score: score
    },
    price_position: {
      current_price: close,
      ma5: ma.ma5,
      ma10: ma.ma10,
      ma20: ma.ma20,
      bias_ma5: bias5,
      bias_status: biasStatus(bias5),
      support_level: sr.support,
      resistance_level: sr.resistance
    },
    indicators: {
      rsi_14: rsi14,
      macd: macdVal?.macd ?? null,
      macd_signal: macdVal?.signal ?? null,
      macd_histogram: macdVal?.histogram ?? null
    }
  };
}
