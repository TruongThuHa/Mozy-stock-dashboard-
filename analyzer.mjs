// Decision Dashboard analyzer - asks Mozy AI for a structured JSON dashboard
// per ticker, mirroring the DSA dashboard schema, localized to Vietnam.
import { askMozy } from './mozy-ask.mjs';

function toFixed(n, d = 2) {
  if (n == null || Number.isNaN(Number(n))) return 'N/A';
  return Number(n).toFixed(d);
}

function fmtPrice(n) {
  if (n == null) return 'N/A';
  return Number(n).toLocaleString('vi-VN');
}

function fmtVolume(n) {
  if (n == null) return 'N/A';
  return Number(n).toLocaleString('vi-VN');
}

function fmtValue(n) {
  if (n == null) return 'N/A';
  return `${(Number(n) / 1e9).toFixed(2)} tỷ`;
}

function newsLine(items, max = 8) {
  if (!Array.isArray(items) || !items.length) return '(không có news)';
  return items.slice(0, max).map((n, i) => {
    const title = n.title || n.headline || n.name || '(no title)';
    const source = n.source || '';
    const date = (n.published_at || n.date || '').toString().slice(0, 16);
    return `${i + 1}. ${title}${source ? ` — ${source}` : ''}${date ? ` (${date})` : ''}`;
  }).join('\n');
}

function statsBlock(stats) {
  if (!stats) return '(không có)';
  const keys = ['pe', 'pb', 'roe', 'roa', 'eps', 'gross_margin_q1', 'market_cap', 'beta', 'dividend_yield'];
  const lines = [];
  for (const k of keys) {
    if (stats[k] != null) lines.push(`${k}: ${stats[k]}`);
  }
  if (!lines.length) {
    for (const [k, v] of Object.entries(stats)) {
      if (typeof v === 'object') continue;
      lines.push(`${k}: ${v}`);
    }
  }
  return lines.slice(0, 18).join('\n');
}

export function buildPrompt({ ticker, name, today, dataPerspective, ohlcvTail, stats, news, riskRows }) {
  const dp = dataPerspective || {};
  const trend = dp.trend_status || {};
  const pp = dp.price_position || {};
  const ind = dp.indicators || {};

  const ohlcvLines = (ohlcvTail || []).map(r =>
    `${(r.timestamp || '').toString().slice(0, 10)} | O ${fmtPrice(r.open)} | H ${fmtPrice(r.high)} | L ${fmtPrice(r.low)} | C ${fmtPrice(r.close)} | V ${fmtVolume(r.volume)}`
  ).join('\n');

  return `Bạn là analyst chứng khoán tại Việt Nam. Hãy viết một Decision Dashboard ngắn gọn, có cấu trúc, cho cổ phiếu ${ticker} (${name || ticker}) trên thị trường Việt Nam, dựa trên dữ liệu sau.

# Bối cảnh

## Phiên gần nhất
- Mã: ${ticker}
- Giá đóng cửa: ${fmtPrice(today?.close ?? pp.current_price)} đồng
- Tổng KL: ${fmtVolume(today?.total_volume)} cp
- Tổng giá trị: ${fmtValue(today?.total_value)}
- Mua nước ngoài: ${fmtVolume(today?.buy_foreign_quantity)}
- Bán nước ngoài: ${fmtVolume(today?.sell_foreign_quantity)}

## Phân tích kỹ thuật (đã tính sẵn)
- MA5: ${fmtPrice(pp.ma5)} | MA10: ${fmtPrice(pp.ma10)} | MA20: ${fmtPrice(pp.ma20)}
- Trạng thái MA: ${trend.ma_alignment || 'N/A'} (${trend.is_bullish === true ? 'multi đầu' : trend.is_bullish === false ? 'đa đầu giảm' : 'không rõ'})
- Trend score: ${trend.trend_score ?? 'N/A'}/100
- Bias MA5: ${toFixed(pp.bias_ma5)}% (${pp.bias_status})
- Hỗ trợ: ${fmtPrice(pp.support_level)} | Kháng cự: ${fmtPrice(pp.resistance_level)}
- RSI(14): ${toFixed(ind.rsi_14)}
- MACD: ${toFixed(ind.macd)} | Signal: ${toFixed(ind.macd_signal)} | Histogram: ${toFixed(ind.macd_histogram)}

## Định giá / chỉ số
${statsBlock(stats)}

## OHLCV 10 phiên gần nhất
${ohlcvLines || '(không có)'}

## News gần nhất
${newsLine(news)}

# Yêu cầu output

Hãy trả về DUY NHẤT một JSON object (không có markdown fence, không text ngoài JSON), theo schema sau:

{
  "stock_name": "tên doanh nghiệp",
  "sentiment_score": 0-100,
  "trend_prediction": "tăng mạnh | tăng | đi ngang | giảm | giảm mạnh",
  "operation_advice": "mua | tích lũy | giữ | giảm tỷ trọng | bán | quan sát",
  "decision_type": "buy | hold | sell",
  "confidence_level": "cao | trung bình | thấp",
  "dashboard": {
    "core_conclusion": {
      "one_sentence": "1 câu dưới 30 chữ chốt nên làm gì",
      "signal_type": "🟢 mua | 🟡 quan sát | 🔴 bán | ⚠️ rủi ro",
      "time_sensitivity": "ngay hôm nay | trong tuần | không gấp",
      "position_advice": {
        "no_position": "đang trống vị thế nên làm gì",
        "has_position": "đang nắm giữ nên làm gì"
      }
    },
    "data_perspective": {
      "trend_summary": "đánh giá xu hướng dựa trên MA + RSI + MACD",
      "volume_meaning": "ý nghĩa của thanh khoản phiên gần đây",
      "chip_health": "khoẻ | bình thường | cảnh báo",
      "valuation_view": "đắt | hợp lý | rẻ"
    },
    "intelligence": {
      "latest_news": "1 câu tin nóng nhất",
      "risk_alerts": ["risk 1", "risk 2"],
      "positive_catalysts": ["catalyst 1", "catalyst 2"],
      "earnings_outlook": "triển vọng KQKD",
      "sentiment_summary": "1 câu cảm nhận thị trường"
    },
    "battle_plan": {
      "sniper_points": {
        "ideal_buy": "vùng giá mua lý tưởng (đồng)",
        "secondary_buy": "vùng giá mua thứ cấp",
        "stop_loss": "ngưỡng cắt lỗ",
        "take_profit": "vùng giá chốt lời"
      },
      "position_strategy": {
        "suggested_position": "% tài khoản đề xuất",
        "entry_plan": "kế hoạch vào lệnh ngắn",
        "risk_control": "cách kiểm soát rủi ro"
      },
      "action_checklist": [
        "✅/⚠️/❌ điểm 1",
        "✅/⚠️/❌ điểm 2",
        "✅/⚠️/❌ điểm 3",
        "✅/⚠️/❌ điểm 4",
        "✅/⚠️/❌ điểm 5"
      ]
    }
  },
  "analysis_summary": "tóm tắt phân tích 80-120 chữ",
  "risk_warning": "rủi ro đáng chú ý nhất",
  "buy_reason": "lý do hành động chính",
  "news_summary": "1-2 câu tóm news"
}

Yêu cầu nghiêm ngặt:
- DUY NHẤT JSON, tiếng Việt, không markdown fence.
- Số thì là số (price, score), tỷ lệ % thì kèm "%" trong chuỗi nếu cần.
- Không bịa, nếu thiếu data thì ghi "không đủ dữ liệu".
- Không thêm trường khác ngoài schema.`;
}

export async function generateDecisionDashboard(ctx) {
  const prompt = buildPrompt(ctx);
  const out = await askMozy(prompt, { mode: 'simple_chat', timeoutSec: 240 });
  // Strip code fences if model leaks
  const clean = out.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/m, '').trim();
  const m = clean.match(/\{[\s\S]*\}\s*$/);
  if (!m) throw new Error('Mozy did not return JSON: ' + clean.slice(0, 200));
  return JSON.parse(m[0]);
}
