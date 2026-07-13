#!/usr/bin/env node
/**
 * mozyfin-ask
 *
 * Hỏi Mozyfin AI Agent qua Partner API và trả về kết quả Markdown + citations.
 *
 * Usage:
 *   node tools/mozyfin-ask.cjs "câu hỏi của bro" [--mode <mode>] [--timeout <s>] [--json] [--no-refs]
 *
 *   --mode      auto | flash_chat | simple_chat | deep_research   (default: auto)
 *   --timeout   max wait seconds (default: 900 = 15p; deep_research có thể đặt 1500 trở lên)
 *   --json      In ra JSON đầy đủ thay vì markdown (cho tool consumer)
 *   --no-refs   Bỏ qua phần citations/refs ở cuối
 *   --quiet     Không in dòng status/progress lên stderr
 *
 * API key được đọc theo thứ tự:
 *   1. MOZYFIN_API_KEY env
 *   2. ~/.config/mozyfin-cli/config.json (do `mozyfin login` tạo)
 *   3. <workspace>/data/secrets/mozyfin.json
 *
 * Exit codes:
 *   0  -> ok (status completed)
 *   1  -> usage error / missing key
 *   2  -> API error / status failed | cancelled
 *   3  -> timeout (vẫn còn đang thinking khi hết giờ)
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ----------------------------------------------------------------------------
// Args
// ----------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    prompt: '',
    mode: 'auto',
    timeoutSec: 900,
    json: false,
    noRefs: false,
    quiet: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode') {
      opts.mode = argv[++i];
    } else if (arg === '--timeout') {
      opts.timeoutSec = Number(argv[++i]);
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--no-refs') {
      opts.noRefs = true;
    } else if (arg === '--quiet') {
      opts.quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        readHelpFromHeader() + '\n'
      );
      process.exit(0);
    } else {
      rest.push(arg);
    }
  }
  opts.prompt = rest.join(' ').trim();
  return opts;
}

function readHelpFromHeader() {
  // Print the JSDoc header of this file as help.
  const src = fs.readFileSync(__filename, 'utf8');
  const m = src.match(/^\/\*\*([\s\S]*?)\*\//);
  return m ? m[1].replace(/^\s*\*\s?/gm, '').trim() : 'mozyfin-ask';
}

// ----------------------------------------------------------------------------
// Config / API key
// ----------------------------------------------------------------------------

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function loadApiKey() {
  if (process.env.MOZYFIN_API_KEY) return process.env.MOZYFIN_API_KEY;

  const cliCfg = readJsonSafe(path.join(os.homedir(), '.config', 'mozyfin-cli', 'config.json'));
  if (cliCfg && cliCfg.apiKey) return cliCfg.apiKey;

  const wsRoot = process.env.OPENCLAW_WORKSPACE
    || path.resolve(__dirname, '..');
  const wsSecret = readJsonSafe(path.join(wsRoot, 'data', 'secrets', 'mozyfin.json'));
  if (wsSecret && wsSecret.api_key) return wsSecret.api_key;

  return null;
}

const DEFAULT_BASE = 'https://api.mozyfin.com';
function loadBaseUrl() {
  const cliCfg = readJsonSafe(path.join(os.homedir(), '.config', 'mozyfin-cli', 'config.json'));
  if (cliCfg && cliCfg.baseUrl) return cliCfg.baseUrl;
  return DEFAULT_BASE;
}

// ----------------------------------------------------------------------------
// HTTP
// ----------------------------------------------------------------------------

async function apiRequest({ baseUrl, apiKey, method, path: subpath, body }) {
  const url = baseUrl.replace(/\/+$/, '') + subpath;
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'X-API-Key': apiKey,
      authorization: `Bearer ${apiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  if (!res.ok) {
    const msg = payload?.message || payload?.detail || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

async function createChat(ctx, mode) {
  const r = await apiRequest({
    ...ctx,
    method: 'POST',
    path: '/api/v1/chat',
    body: { title: 'fishbot-ask', mode },
  });
  const id = r?.data?.id;
  if (!id) throw new Error('createChat: missing chat id in response');
  return id;
}

async function sendMessage(ctx, chatId, content) {
  const r = await apiRequest({
    ...ctx,
    method: 'POST',
    path: `/api/v1/chat/${chatId}/message`,
    body: { content },
  });
  const id = r?.data?.id;
  if (!id) throw new Error('sendMessage: missing message id in response');
  return r.data;
}

async function getMessage(ctx, messageId) {
  const r = await apiRequest({
    ...ctx,
    method: 'GET',
    path: `/api/v1/chat/messages/${messageId}`,
  });
  return r?.data ?? null;
}

// ----------------------------------------------------------------------------
// Polling
// ----------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

async function pollUntilDone(ctx, messageId, deadline, onProgress) {
  let last = null;
  let lastStepKey = '';
  const intervalMs = 1500;
  while (Date.now() < deadline) {
    last = await getMessage(ctx, messageId);
    const status = last?.status;

    if (onProgress && last) {
      const steps = Array.isArray(last.thinking_steps) ? last.thinking_steps : [];
      const lastStep = steps[steps.length - 1];
      const stepLabel = lastStep
        ? (lastStep.title || lastStep.name || lastStep.label || lastStep.tool || JSON.stringify(lastStep).slice(0, 80))
        : '';
      const progressKey = `${status}|${steps.length}|${stepLabel}`;
      if (progressKey !== lastStepKey) {
        lastStepKey = progressKey;
        onProgress({ status, stepCount: steps.length, lastStep: stepLabel });
      }
    }

    if (status && TERMINAL_STATUSES.has(status)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last; // timed out
}

// ----------------------------------------------------------------------------
// Render
// ----------------------------------------------------------------------------

function renderRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return '';
  const lines = ['', '---', '**Nguồn / References:**'];
  refs.forEach((ref, i) => {
    const title = ref.title || ref.name || ref.source || ref.url || `ref-${i + 1}`;
    const url = ref.url || ref.link || ref.source_url;
    lines.push(`${i + 1}. ${url ? `[${title}](${url})` : title}`);
  });
  return lines.join('\n');
}

function renderMarkdown(message, opts) {
  const content = (message && message.content) ? message.content : '(rỗng)';
  if (opts.noRefs) return content;
  const refs = renderRefs(message && message.refs);
  return refs ? `${content}\n${refs}` : content;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.prompt) {
    process.stderr.write('mozyfin-ask: missing prompt. Use --help for usage.\n');
    process.exit(1);
  }

  const validModes = ['auto', 'flash_chat', 'simple_chat', 'deep_research'];
  if (!validModes.includes(opts.mode)) {
    process.stderr.write(`mozyfin-ask: invalid --mode "${opts.mode}". Allowed: ${validModes.join(', ')}\n`);
    process.exit(1);
  }
  if (!Number.isFinite(opts.timeoutSec) || opts.timeoutSec < 5) {
    process.stderr.write('mozyfin-ask: --timeout must be >= 5 seconds\n');
    process.exit(1);
  }

  const apiKey = loadApiKey();
  if (!apiKey) {
    process.stderr.write(
      'mozyfin-ask: no API key found.\n  Try: export MOZYFIN_API_KEY=... or run `mozyfin login --api-key ...`\n'
    );
    process.exit(1);
  }
  const baseUrl = loadBaseUrl();
  const ctx = { baseUrl, apiKey };

  const log = (...a) => { if (!opts.quiet) process.stderr.write(a.join(' ') + '\n'); };

  try {
    log(`[mozyfin] base=${baseUrl} mode=${opts.mode} timeout=${opts.timeoutSec}s`);
    log('[mozyfin] creating chat...');
    const chatId = await createChat(ctx, opts.mode);
    log(`[mozyfin] chat_id=${chatId}`);

    log('[mozyfin] sending message...');
    const initial = await sendMessage(ctx, chatId, opts.prompt);
    const messageId = initial.id;
    log(`[mozyfin] message_id=${messageId}, polling...`);

    const deadline = Date.now() + opts.timeoutSec * 1000;
    const final = await pollUntilDone(
      ctx,
      messageId,
      deadline,
      (p) => log(`[mozyfin] status=${p.status} steps=${p.stepCount}${p.lastStep ? ` :: ${p.lastStep}` : ''}`)
    );

    if (!final) {
      process.stderr.write('mozyfin-ask: empty response\n');
      process.exit(2);
    }

    const status = final.status;

    if (opts.json) {
      const out = {
        chat_id: chatId,
        message_id: messageId,
        status,
        mode: opts.mode,
        content: final.content || '',
        refs: final.refs || [],
        thinking_steps: final.thinking_steps || [],
        created_at: final.created_at,
        timed_out: !TERMINAL_STATUSES.has(status),
      };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    } else {
      process.stdout.write(renderMarkdown(final, opts) + '\n');
    }

    if (status === 'completed') process.exit(0);
    if (status === 'failed' || status === 'cancelled') process.exit(2);
    // still thinking -> timed out
    process.stderr.write(`mozyfin-ask: timed out after ${opts.timeoutSec}s (status=${status})\n`);
    process.exit(3);
  } catch (err) {
    process.stderr.write(`mozyfin-ask error: ${err.message}\n`);
    if (err.payload) {
      process.stderr.write(JSON.stringify(err.payload) + '\n');
    }
    process.exit(2);
  }
})();
