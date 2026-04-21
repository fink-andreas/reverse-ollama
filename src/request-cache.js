/**
 * Request/Response Cache
 *
 * Optional on-disk cache for LLM request/response pairs.
 * Uses SHA-256 of the final outgoing request body as the cache key.
 * Cache entries expire after 4 hours (configurable via environment variable).
 *
 * Environment variables:
 *   - REQUEST_CACHE_ENABLED: Enable caching (default: true)
 *   - REQUEST_CACHE_DIR: Cache directory (default: /var/cache/reverse-ollama/request-cache)
 *   - REQUEST_CACHE_TTL_MS: Cache TTL in milliseconds (default: 14400000 = 4 hours)
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { stat } from 'node:fs/promises';

const DEFAULT_CACHE_DIR = '/var/cache/reverse-ollama/request-cache';
const DEFAULT_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function isRequestCacheEnabled() {
  const value = process.env.REQUEST_CACHE_ENABLED;
  // Default to enabled; explicitly disable with "0", "false", "no", "off"
  if (value === undefined || value === '') {
    return true;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function getCacheDir() {
  return process.env.REQUEST_CACHE_DIR || DEFAULT_CACHE_DIR;
}

export function getCacheTtlMs() {
  const value = Number(process.env.REQUEST_CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_CACHE_TTL_MS;
}

/**
 * Compute SHA-256 hex digest of a buffer.
 */
export function computeRequestHash(bodyBuffer) {
  if (!Buffer.isBuffer(bodyBuffer)) {
    throw new Error('cache hash requires a Buffer');
  }
  return createHash('sha256').update(bodyBuffer).digest('hex');
}

/**
 * Return the absolute path to the cache file for a given hash.
 */
export function getCacheFilePath(hash) {
  return join(getCacheDir(), `${hash}.json`);
}

/**
 * Read and validate a cache entry by hash.
 * Returns null if the file does not exist, is expired, or is corrupt.
 */
export async function readCacheEntry(hash) {
  const filePath = getCacheFilePath(hash);

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return null;
  }

  // Validate required fields
  if (
    typeof entry !== 'object' ||
    entry === null ||
    typeof entry.hash !== 'string' ||
    typeof entry.createdAt !== 'number' ||
    typeof entry.expiryAt !== 'number' ||
    entry.hash !== hash
  ) {
    return null;
  }

  // Check TTL
  const now = Date.now();
  if (now >= entry.expiryAt) {
    return null;
  }

  return entry;
}

/**
 * Write a cache entry atomically (write to temp file then rename).
 * Silently skips writing if the entry already exists and is valid.
 */
export async function writeCacheEntry(hash, entry) {
  const dir = getCacheDir();
  const targetPath = getCacheFilePath(hash);

  // Ensure directory exists
  await mkdir(dir, { recursive: true });

  // Check if already cached and valid
  let existing;
  try {
    existing = await readCacheEntry(hash);
  } catch (_err) {
    // File unreadable or does not exist — will write below
  }

  if (existing !== null) {
    // Already cached and valid
    return;
  }

  const ttlMs = getCacheTtlMs();
  const now = Date.now();

  const fullEntry = {
    hash,
    createdAt: now,
    expiryAt: now + ttlMs,
    requestBody: entry.requestBody,
    statusCode: entry.statusCode,
    responseHeaders: entry.responseHeaders,
    responseBody: entry.responseBody,
    cacheSource: entry.cacheSource || 'upstream',
  };

  const content = JSON.stringify(fullEntry);

  // Atomic write: write to temp file then rename
  const tmpPath = `${targetPath}.tmp.${process.pid}.${now}`;
  try {
    await writeFile(tmpPath, content, 'utf8');
    await renameFile(tmpPath, targetPath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      const { unlink: unlinkSync } = await import('node:fs/promises');
      await unlinkSync(tmpPath);
    } catch (_cleanupErr) {
      // ignore
    }
    throw err;
  }
}

/**
 * Rename a file (cross-filesystem safe on Linux via rename(2)).
 */
async function renameFile(src, dest) {
  const { rename } = await import('node:fs/promises');
  await rename(src, dest);
}

/**
 * Serve a cached response to the client.
 * Writes directly to the HTTP response object.
 *
 * @param {object} res - Node.js HTTP response object
 * @param {object} entry - Cache entry
 */
export function serveCachedResponse(res, entry) {
  res.writeHead(entry.statusCode, entry.responseHeaders);
  res.end(entry.responseBody);
}

/**
 * Filter response headers to only replayable safe headers.
 * Excludes hop-by-hop headers and content-length (will be set from actual body).
 */
const REPLAYABLE_HEADERS = new Set([
  'content-type',
  'content-encoding',
  'cache-control',
  'etag',
  'last-modified',
  'date',
  'server',
  'x-request-id',
]);

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'expect',
  'host',
]);

export function filterReplayableHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null) {
      continue;
    }
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'content-length') {
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * Determine whether a response should be cached based on request and response metadata.
 * Only caches non-streaming JSON responses.
 *
 * @param {string} requestPath - The request path
 * @param {object} requestBody - Parsed request body object (or null)
 * @param {number} statusCode - HTTP status code
 * @param {object} responseHeaders - Response headers
 * @returns {boolean}
 */
export function shouldCacheResponse(requestPath, requestBody, statusCode, responseHeaders) {
  // Only cache successful responses
  if (statusCode !== 200) {
    return false;
  }

  // Skip streaming requests
  const streamParam = requestBody?.stream;
  if (streamParam === true) {
    return false;
  }

  // Also check via content-type of response (Ollama sets text/event-stream for streaming)
  const contentType = String(responseHeaders?.['content-type'] || '').toLowerCase();
  if (contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson')) {
    return false;
  }

  // Only cache JSON responses
  if (!contentType.includes('application/json')) {
    return false;
  }

  return true;
}

/**
 * Periodically clean up expired cache entries.
 * Call once at startup; runs forever.
 * @param {object} logger - Logger instance
 * @param {number} intervalMs - Cleanup interval (default: 1 hour)
 */
export async function startCacheCleanup(logger, intervalMs = 60 * 60 * 1000) {
  const cleanup = async () => {
    const dir = getCacheDir();
    let files;
    try {
      files = await readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return;
      }
      logger.warn({ err }, 'cache cleanup: failed to read cache directory');
      return;
    }

    const now = Date.now();
    let cleaned = 0;
    let errors = 0;

    for (const file of files) {
      if (!file.endsWith('.json') || file.includes('.tmp.')) {
        continue;
      }

      const filePath = join(dir, file);
      try {
        const raw = await readFile(filePath, 'utf8');
        const entry = JSON.parse(raw);
        if (entry?.expiryAt && now >= Number(entry.expiryAt)) {
          await unlink(filePath);
          cleaned++;
        }
      } catch {
        errors++;
      }
    }

    if (cleaned > 0 || errors > 0) {
      logger.info({ cleaned, errors, dir }, 'cache cleanup completed');
    }
  };

  // Run immediately, then on interval
  await cleanup();
  setInterval(cleanup, intervalMs).unref();
  logger.info({ intervalMs, dir: getCacheDir() }, 'cache cleanup scheduler started');
}
