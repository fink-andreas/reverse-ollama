import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SESSION_LOG_DIR = '/var/log/reverse-ollama/sessions';

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

export function isSessionLogEnabled() {
  return isTruthyEnv(process.env.SESSION_LOG_ENABLED);
}

export function getSessionLogDir() {
  return process.env.SESSION_LOG_DIR || DEFAULT_SESSION_LOG_DIR;
}

function sanitizeSourceForFilename(source) {
  return String(source || 'unknown')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function getSessionLogFilePath({ now = new Date(), source = 'unknown' } = {}) {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const min = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  const msec = String(now.getUTCMilliseconds()).padStart(3, '0');
  const safeSource = sanitizeSourceForFilename(source);

  return path.join(getSessionLogDir(), `session-${yyyy}-${mm}-${dd}-${hh}-${min}-${ss}-${msec}-${safeSource}.jsonl`);
}

export async function appendSessionLogEntry(entry, { source = 'unknown' } = {}) {
  const dir = getSessionLogDir();
  await mkdir(dir, { recursive: true });

  const filePath = getSessionLogFilePath({ source });
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');

  return filePath;
}
