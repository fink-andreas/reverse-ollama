import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeRequestHash,
  readCacheEntry,
  writeCacheEntry,
  shouldCacheResponse,
  getCacheFilePath,
} from '../src/request-cache.js';

describe('computeRequestHash', () => {
  it('produces a hex string', () => {
    const hash = computeRequestHash(Buffer.from('hello'));
    expect(typeof hash).toBe('string');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const buf = Buffer.from('{"model":"llama3","prompt":"hello"}');
    const h1 = computeRequestHash(buf);
    const h2 = computeRequestHash(buf);
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different inputs', () => {
    const h1 = computeRequestHash(Buffer.from('hello'));
    const h2 = computeRequestHash(Buffer.from('world'));
    expect(h1).not.toBe(h2);
  });

  it('throws if passed a non-Buffer', () => {
    expect(() => computeRequestHash('hello')).toThrow();
    expect(() => computeRequestHash(null)).toThrow();
  });
});

describe('shouldCacheResponse', () => {
  it('returns false for non-200 status codes', () => {
    const result = shouldCacheResponse('/api/chat', { model: 'llama3' }, 500, {
      'content-type': 'application/json',
    });
    expect(result).toBe(false);
  });

  it('returns false when stream:true in request', () => {
    const result = shouldCacheResponse('/api/chat', { model: 'llama3', stream: true }, 200, {
      'content-type': 'application/json',
    });
    expect(result).toBe(false);
  });

  it('returns false for text/event-stream content-type', () => {
    const result = shouldCacheResponse('/api/chat', { model: 'llama3' }, 200, {
      'content-type': 'text/event-stream',
    });
    expect(result).toBe(false);
  });

  it('returns false for application/x-ndjson content-type', () => {
    const result = shouldCacheResponse('/api/chat', { model: 'llama3' }, 200, {
      'content-type': 'application/x-ndjson',
    });
    expect(result).toBe(false);
  });

  it('returns false for non-JSON content-type', () => {
    const result = shouldCacheResponse('/api/chat', { model: 'llama3' }, 200, {
      'content-type': 'text/plain',
    });
    expect(result).toBe(false);
  });

  it('returns true for 200 with JSON content-type and non-streaming request', () => {
    const result = shouldCacheResponse('/api/chat', { model: 'llama3', stream: false }, 200, {
      'content-type': 'application/json',
    });
    expect(result).toBe(true);
  });

  it('returns true for 200 with JSON content-type when stream is absent (default false)', () => {
    const result = shouldCacheResponse('/api/generate', { model: 'llama3' }, 200, {
      'content-type': 'application/json',
    });
    expect(result).toBe(true);
  });

  it('returns false when stream:false is explicitly false', () => {
    const result = shouldCacheResponse('/api/chat', { model: 'llama3', stream: false }, 200, {
      'content-type': 'text/plain',
    });
    expect(result).toBe(false);
  });

  it('returns false for empty response headers', () => {
    const result = shouldCacheResponse('/api/chat', { model: 'llama3' }, 200, {});
    expect(result).toBe(false);
  });
});

describe('getCacheFilePath', () => {
  it('returns a path ending with <hash>.json', () => {
    const hash = 'a'.repeat(64);
    const path = getCacheFilePath(hash);
    expect(path).toContain(`${hash}.json`);
  });
});

describe('writeCacheEntry / readCacheEntry', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reverse-ollama-cache-test-'));
    process.env.REQUEST_CACHE_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.REQUEST_CACHE_DIR;
  });

  it('writes and reads back a cache entry', async () => {
    const hash = computeRequestHash(Buffer.from('test body'));
    await writeCacheEntry(hash, {
      requestBody: '{"model":"llama3","prompt":"hello"}',
      statusCode: 200,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: '{"response":"hi"}',
      cacheSource: 'upstream',
    });

    const entry = await readCacheEntry(hash);
    expect(entry).not.toBeNull();
    expect(entry.hash).toBe(hash);
    expect(entry.requestBody).toBe('{"model":"llama3","prompt":"hello"}');
    expect(entry.statusCode).toBe(200);
    expect(entry.responseBody).toBe('{"response":"hi"}');
    expect(entry.cacheSource).toBe('upstream');
    expect(typeof entry.createdAt).toBe('number');
    expect(typeof entry.expiryAt).toBe('number');
    expect(entry.expiryAt).toBeGreaterThan(entry.createdAt);
  });

  it('readCacheEntry returns null for non-existent hash', async () => {
    const hash = computeRequestHash(Buffer.from('this does not exist'));
    const entry = await readCacheEntry(hash);
    expect(entry).toBeNull();
  });

  it('does not overwrite a valid existing entry on write', async () => {
    const hash = computeRequestHash(Buffer.from('immutable body'));
    await writeCacheEntry(hash, {
      requestBody: '{"model":"llama3","prompt":"first"}',
      statusCode: 200,
      responseHeaders: {},
      responseBody: '{"response":"first"}',
    });

    // Try writing again with different data
    await writeCacheEntry(hash, {
      requestBody: '{"model":"llama3","prompt":"second"}',
      statusCode: 200,
      responseHeaders: {},
      responseBody: '{"response":"second"}',
    });

    const entry = await readCacheEntry(hash);
    // Should keep original entry (first write wins)
    expect(entry.responseBody).toBe('{"response":"first"}');
  });

  it('expired entry returns null and leaves no file', async () => {
    // Temporarily reduce TTL to 1ms
    const originalTtl = process.env.REQUEST_CACHE_TTL_MS;
    process.env.REQUEST_CACHE_TTL_MS = '1';

    const hash = computeRequestHash(Buffer.from('expiring body'));
    await writeCacheEntry(hash, {
      requestBody: '{}',
      statusCode: 200,
      responseHeaders: {},
      responseBody: '{}',
    });

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 10));

    const entry = await readCacheEntry(hash);
    expect(entry).toBeNull();

    process.env.REQUEST_CACHE_TTL_MS = originalTtl;
  });
});
