import { execFile } from 'node:child_process';

const MOZY_SETUP_HINT = '\n💡 Setup: bash setup.sh (kiểm tra cài đặt) | Docs: https://docs.mozy.vn';

export function runMozyfin(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('mozyfin', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        let msg = stderr?.toString().trim() || err.message || '';

        // Detect common setup issues
        if (err.code === 'ENOENT') {
          msg = `mozyfin CLI chưa được cài.\n👉 Cài: npm install -g mozyfin-cli\n👉 Rồi: mozyfin login --api-key <KEY>\n👉 Lấy key: https://mozy.vn${MOZY_SETUP_HINT}`;
        } else if (/unauthorized|401|403|invalid.*key|api.?key/i.test(msg)) {
          msg = `API key không hợp lệ hoặc hết hạn.\n👉 Login lại: mozyfin login --api-key <KEY>\n👉 Hoặc set env: export MOZYFIN_API_KEY=<KEY>\n👉 Lấy key: https://mozy.vn${MOZY_SETUP_HINT}`;
        } else if (/ENOTFOUND|ECONNREFUSED|network|timeout/i.test(msg)) {
          msg = `Không kết nối được tới Mozyfin API. Kiểm tra mạng.${MOZY_SETUP_HINT}`;
        }

        return reject(new Error(`mozyfin ${args[0]} thất bại: ${msg}`));
      }
      resolve(stdout.toString());
    });
  });
}

// Parse a Markdown pipe-table into [{col: value, ...}]
export function parseMarkdownTable(text) {
  const rawLines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('|') && l.endsWith('|'));
  if (rawLines.length < 2) return [];
  const splitRow = (l) => l.slice(1, -1).split('|').map(c => c.trim());
  const header = splitRow(rawLines[0]);
  // Find separator row (---|---), data rows are everything except header + separator
  const dataLines = rawLines.slice(1).filter(l => !/^\s*\|?\s*[-: ]+\s*(\|\s*[-: ]+\s*)+\|?\s*$/.test(l));
  const rows = dataLines.map(l => {
    const cells = splitRow(l);
    const obj = {};
    header.forEach((h, i) => {
      const v = cells[i];
      obj[h] = autoCast(v);
    });
    return obj;
  });
  return rows;
}

function autoCast(v) {
  if (v == null) return null;
  if (v === '' || v === '—' || v === '-' || v === 'N/A') return null;
  // ISO date
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return v;
  // Pure number (bỏ dấu phẩy phân cách và ký hiệu %) → trả về số
  const stripped = v.replace(/[, ]/g, '').replace(/%$/, '');
  if (/^-?\d+(\.\d+)?$/.test(stripped)) {
    return Number(stripped);
  }
  return v;
}

export async function mozyfinTable(args, { timeoutMs = 60000 } = {}) {
  const out = await runMozyfin(args, { timeoutMs });
  const rows = parseMarkdownTable(out);
  return { rows, raw: out };
}

export async function safeFetch(args, opts) {
  try {
    return await mozyfinTable(args, opts);
  } catch (e) {
    return { error: e.message, rows: [] };
  }
}
