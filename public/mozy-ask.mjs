import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const askScript = path.resolve(__dirname, 'mozyfin-ask.cjs');

export function askMozy(prompt, { mode = 'simple_chat', timeoutSec = 240 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'node',
      [askScript, prompt, '--mode', mode, '--timeout', String(timeoutSec), '--quiet', '--no-refs'],
      { timeout: (timeoutSec + 30) * 1000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`mozyfin-ask failed: ${stderr?.toString().trim() || err.message}`));
        resolve(stdout.toString().trim());
      }
    );
  });
}
