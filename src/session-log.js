import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SESSION_LOG_DIR = '/var/log/reverse-ollama/sessions';

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

const DEFAULT_CLEANUP_MAX_AGE_HOURS = 48;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

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
  await appendFile(filePath, `${JSON.stringify(entry)}
`, 'utf8');

  return filePath;
}

/**
 * Get the session cleanup maximum age in hours.
 * @returns {number} Maximum age in hours
 */
export function getSessionCleanupMaxAgeHours() {
  const value = Number(process.env.SESSION_CLEANUP_MAX_AGE_HOURS || DEFAULT_CLEANUP_MAX_AGE_HOURS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_CLEANUP_MAX_AGE_HOURS;
}

/**
 * Get the session cleanup interval in milliseconds.
 * @returns {number} Cleanup interval in ms
 */
export function getSessionCleanupIntervalMs() {
  const value = Number(process.env.SESSION_CLEANUP_INTERVAL_MS || DEFAULT_CLEANUP_INTERVAL_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_CLEANUP_INTERVAL_MS;
}

/**
 * Parse session filename to extract UTC timestamp.
 * Expected format: session-YYYY-MM-DD-HH-mm-ss-SSS-source.jsonl
 * Returns null if filename doesn't match the expected format.
 * @param {string} filename
 * @returns {Date | null}
 */
export function parseSessionFilename(filename) {
  // Match: session-YYYY-MM-DD-HH-mm-ss-SSS-source.jsonl
  // The source part can contain hyphens, so we match until the last .jsonl
  const pattern = /^session-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{3})-.+\.jsonl$/;
  const match = filename.match(pattern);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second, millis] = match;

  // Validate ranges
  const monthNum = Number(month);
  const dayNum = Number(day);
  const hourNum = Number(hour);
  const minNum = Number(minute);
  const secNum = Number(second);
  const millisNum = Number(millis);

  if (monthNum < 1 || monthNum > 12) return null;
  if (dayNum < 1 || dayNum > 31) return null;
  if (hourNum > 23) return null;
  if (minNum > 59) return null;
  if (secNum > 59) return null;
  if (millisNum > 999) return null;

  const date = new Date(Date.UTC(
    Number(year),
    monthNum - 1, // months are 0-indexed
    dayNum,
    hourNum,
    minNum,
    secNum,
    millisNum
  ));

  // Validate the date is valid
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

/**
 * Delete session files older than the configured maximum age.
 * @param {object} logger - Logger instance
 * @returns {Promise<{deleted: number, errors: number}>}
 */
export async function cleanupOldSessions(logger) {
  const dir = getSessionLogDir();
  const maxAgeHours = getSessionCleanupMaxAgeHours();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const cutoffTime = Date.now() - maxAgeMs;

  let files;
  try {
    files = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { deleted: 0, errors: 0 };
    }
    logger.warn({ err }, 'session cleanup: failed to read session directory');
    return { deleted: 0, errors: 1 };
  }

  let deleted = 0;
  let errors = 0;

  for (const file of files) {
    // Only process .jsonl files matching our naming convention
    if (!file.startsWith('session-') || !file.endsWith('.jsonl')) {
      continue;
    }

    const sessionDate = parseSessionFilename(file);
    if (!sessionDate) {
      // File doesn't match expected format, skip it
      continue;
    }

    if (sessionDate.getTime() < cutoffTime) {
      const filePath = path.join(dir, file);
      try {
        await unlink(filePath);
        deleted++;
      } catch (err) {
        logger.warn({ err, file }, 'session cleanup: failed to delete file');
        errors++;
      }
    }
  }

  return { deleted, errors };
}

/**
 * Start the session cleanup scheduler.
 * Runs cleanup immediately, then on the configured interval.
 * @param {object} logger - Logger instance
 * @param {number} [intervalMs] - Cleanup interval in ms (default from env or 1 hour)
 */
export async function startSessionCleanup(logger, intervalMs) {
  const interval = intervalMs || getSessionCleanupIntervalMs();

  const cleanup = async () => {
    const { deleted, errors } = await cleanupOldSessions(logger);
    if (deleted > 0 || errors > 0) {
      logger.info(
        { deleted, errors, maxAgeHours: getSessionCleanupMaxAgeHours(), dir: getSessionLogDir() },
        'session cleanup completed'
      );
    }
  };

  // Run immediately on startup
  await cleanup();

  // Schedule periodic cleanup
  setInterval(cleanup, interval).unref();
  logger.info(
    { intervalMs: interval, maxAgeHours: getSessionCleanupMaxAgeHours(), dir: getSessionLogDir() },
    'session cleanup scheduler started'
  );
}
