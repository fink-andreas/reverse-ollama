import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSessionFilename,
  getSessionCleanupMaxAgeHours,
  getSessionCleanupIntervalMs,
  cleanupOldSessions,
} from '../src/session-log.js';

describe('parseSessionFilename', () => {
  it('parses a valid session filename', () => {
    const filename = 'session-2024-03-15-10-30-45-123-source.jsonl';
    const date = parseSessionFilename(filename);
    expect(date).not.toBeNull();
    expect(date.getUTCFullYear()).toBe(2024);
    expect(date.getUTCMonth()).toBe(2); // March is 2 (0-indexed)
    expect(date.getUTCDate()).toBe(15);
    expect(date.getUTCHours()).toBe(10);
    expect(date.getUTCMinutes()).toBe(30);
    expect(date.getUTCSeconds()).toBe(45);
    expect(date.getUTCMilliseconds()).toBe(123);
  });

  it('parses filename with hyphens in source', () => {
    const filename = 'session-2024-01-01-00-00-00-000-192-168-1-1.jsonl';
    const date = parseSessionFilename(filename);
    expect(date).not.toBeNull();
    expect(date.getUTCFullYear()).toBe(2024);
    expect(date.getUTCMonth()).toBe(0); // January is 0
    expect(date.getUTCDate()).toBe(1);
  });

  it('returns null for invalid filename format', () => {
    expect(parseSessionFilename('not-a-session-file.jsonl')).toBeNull();
    expect(parseSessionFilename('session-invalid-date.jsonl')).toBeNull();
    expect(parseSessionFilename('session-2024-03-15.jsonl')).toBeNull(); // missing parts
    expect(parseSessionFilename('session-2024-13-01-00-00-00-000-src.jsonl')).toBeNull(); // invalid month
  });

  it('returns null for non-jsonl files', () => {
    expect(parseSessionFilename('session-2024-03-15-00-00-00-000-src.json')).toBeNull();
    expect(parseSessionFilename('session-2024-03-15-00-00-00-000-src.txt')).toBeNull();
  });

  it('returns null for files without session- prefix', () => {
    expect(parseSessionFilename('2024-03-15-00-00-00-000-src.jsonl')).toBeNull();
  });
});

describe('getSessionCleanupMaxAgeHours', () => {
  afterEach(() => {
    delete process.env.SESSION_CLEANUP_MAX_AGE_HOURS;
  });

  it('returns default value when env var is not set', () => {
    delete process.env.SESSION_CLEANUP_MAX_AGE_HOURS;
    expect(getSessionCleanupMaxAgeHours()).toBe(48);
  });

  it('returns env value when valid', () => {
    process.env.SESSION_CLEANUP_MAX_AGE_HOURS = '72';
    expect(getSessionCleanupMaxAgeHours()).toBe(72);
  });

  it('floors decimal values', () => {
    process.env.SESSION_CLEANUP_MAX_AGE_HOURS = '24.9';
    expect(getSessionCleanupMaxAgeHours()).toBe(24);
  });

  it('returns default for invalid values', () => {
    process.env.SESSION_CLEANUP_MAX_AGE_HOURS = 'invalid';
    expect(getSessionCleanupMaxAgeHours()).toBe(48);

    process.env.SESSION_CLEANUP_MAX_AGE_HOURS = '-10';
    expect(getSessionCleanupMaxAgeHours()).toBe(48);

    process.env.SESSION_CLEANUP_MAX_AGE_HOURS = '0';
    expect(getSessionCleanupMaxAgeHours()).toBe(48);
  });
});

describe('getSessionCleanupIntervalMs', () => {
  afterEach(() => {
    delete process.env.SESSION_CLEANUP_INTERVAL_MS;
  });

  it('returns default value when env var is not set', () => {
    delete process.env.SESSION_CLEANUP_INTERVAL_MS;
    expect(getSessionCleanupIntervalMs()).toBe(3600000); // 1 hour
  });

  it('returns env value when valid', () => {
    process.env.SESSION_CLEANUP_INTERVAL_MS = '7200000';
    expect(getSessionCleanupIntervalMs()).toBe(7200000);
  });

  it('floors decimal values', () => {
    process.env.SESSION_CLEANUP_INTERVAL_MS = '60000.9';
    expect(getSessionCleanupIntervalMs()).toBe(60000);
  });

  it('returns default for invalid values', () => {
    process.env.SESSION_CLEANUP_INTERVAL_MS = 'invalid';
    expect(getSessionCleanupIntervalMs()).toBe(3600000);

    process.env.SESSION_CLEANUP_INTERVAL_MS = '-1000';
    expect(getSessionCleanupIntervalMs()).toBe(3600000);
  });
});

describe('cleanupOldSessions', () => {
  let tmpDir;
  let mockLogger;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reverse-ollama-session-test-'));
    process.env.SESSION_LOG_DIR = tmpDir;
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SESSION_LOG_DIR;
    vi.restoreAllMocks();
  });

  it('returns 0,0 when directory does not exist', async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    const result = await cleanupOldSessions(mockLogger);
    expect(result).toEqual({ deleted: 0, errors: 0 });
  });

  it('deletes files older than max age', async () => {
    const now = Date.now();
    const hour = 60 * 60 * 1000;

    // Create a file that's 50 hours old (older than 48h threshold)
    const oldDate = new Date(now - 50 * hour);
    const oldFilename = `session-${oldDate.getUTCFullYear()}-${String(oldDate.getUTCMonth() + 1).padStart(2, '0')}-${String(oldDate.getUTCDate()).padStart(2, '0')}-${String(oldDate.getUTCHours()).padStart(2, '0')}-${String(oldDate.getUTCMinutes()).padStart(2, '0')}-${String(oldDate.getUTCSeconds()).padStart(2, '0')}-${String(oldDate.getUTCMilliseconds()).padStart(3, '0')}-old.jsonl`;
    writeFileSync(join(tmpDir, oldFilename), '{}');

    // Create a file that's 24 hours old (within 48h threshold)
    const recentDate = new Date(now - 24 * hour);
    const recentFilename = `session-${recentDate.getUTCFullYear()}-${String(recentDate.getUTCMonth() + 1).padStart(2, '0')}-${String(recentDate.getUTCDate()).padStart(2, '0')}-${String(recentDate.getUTCHours()).padStart(2, '0')}-${String(recentDate.getUTCMinutes()).padStart(2, '0')}-${String(recentDate.getUTCSeconds()).padStart(2, '0')}-${String(recentDate.getUTCMilliseconds()).padStart(3, '0')}-recent.jsonl`;
    writeFileSync(join(tmpDir, recentFilename), '{}');

    const result = await cleanupOldSessions(mockLogger);
    expect(result.deleted).toBe(1);
    expect(result.errors).toBe(0);

    // Verify only the recent file remains
    const remaining = readdirSync(tmpDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(recentFilename);
  });

  it('skips files that do not match session naming convention', async () => {
    // Create a file with non-standard name
    writeFileSync(join(tmpDir, 'other-file.jsonl'), '{}');
    writeFileSync(join(tmpDir, 'session-old.json'), '{}'); // wrong extension

    const result = await cleanupOldSessions(mockLogger);
    expect(result.deleted).toBe(0);
    expect(result.errors).toBe(0);

    const remaining = readdirSync(tmpDir);
    expect(remaining).toHaveLength(2);
  });

  it('logs warning when delete fails', async () => {
    // Test with a file path that's a directory (should fail)
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const oldDate = new Date(now - 50 * hour);
    const oldFilename = `session-${oldDate.getUTCFullYear()}-${String(oldDate.getUTCMonth() + 1).padStart(2, '0')}-${String(oldDate.getUTCDate()).padStart(2, '0')}-${String(oldDate.getUTCHours()).padStart(2, '0')}-${String(oldDate.getUTCMinutes()).padStart(2, '0')}-${String(oldDate.getUTCSeconds()).padStart(2, '0')}-${String(oldDate.getUTCMilliseconds()).padStart(3, '0')}-old.jsonl`;
    const filePath = join(tmpDir, oldFilename);
    writeFileSync(filePath, '{}');

    // Remove read permission to cause readdir failure
    const { chmodSync } = await import('node:fs');
    chmodSync(tmpDir, 0o000);

    try {
      const result = await cleanupOldSessions(mockLogger);
      // Should have errors due to permission issues
      expect(result.errors).toBeGreaterThan(0);
      expect(mockLogger.warn).toHaveBeenCalled();
    } finally {
      // Restore permissions for cleanup
      chmodSync(tmpDir, 0o755);
    }
  });

  it('respects custom max age from env', async () => {
    // Set max age to 72 hours
    process.env.SESSION_CLEANUP_MAX_AGE_HOURS = '72';

    const now = Date.now();
    const hour = 60 * 60 * 1000;

    // Create a file that's 50 hours old - should NOT be deleted with 72h threshold
    const recentDate = new Date(now - 50 * hour);
    const recentFilename = `session-${recentDate.getUTCFullYear()}-${String(recentDate.getUTCMonth() + 1).padStart(2, '0')}-${String(recentDate.getUTCDate()).padStart(2, '0')}-${String(recentDate.getUTCHours()).padStart(2, '0')}-${String(recentDate.getUTCMinutes()).padStart(2, '0')}-${String(recentDate.getUTCSeconds()).padStart(2, '0')}-${String(recentDate.getUTCMilliseconds()).padStart(3, '0')}-recent.jsonl`;
    writeFileSync(join(tmpDir, recentFilename), '{}');

    const result = await cleanupOldSessions(mockLogger);
    expect(result.deleted).toBe(0);

    const remaining = readdirSync(tmpDir);
    expect(remaining).toHaveLength(1);
  });
});
