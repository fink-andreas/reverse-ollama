import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function getFreePort() {
  return new Promise((resolve) => {
    const probe = http.createServer((_, res) => res.end('ok'));
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

async function startViewerServer(env = {}) {
  const port = await getFreePort();
  const password = env.SESSION_VIEWER_PASSWORD ?? 'testpass';

  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['src/session-viewer-server.js'], {
      env: {
        ...process.env,
        SESSION_VIEWER_PORT: String(port),
        SESSION_VIEWER_PASSWORD: password,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolved = false;

    proc.stdout.on('data', (data) => {
      if (!resolved) {
        resolve({ proc, port, password });
      }
    });

    proc.stderr.on('data', (data) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Server failed: ${data}`));
      }
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Server start timeout'));
      }
    }, 5000);
  });
}

async function stopViewerServer(proc) {
  if (proc) {
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      proc.on('close', resolve);
      setTimeout(resolve, 1000);
    });
  }
}

function basicAuth(password) {
  return `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
}

function authedFetch(serverInfo, pathName, options = {}) {
  const headers = {
    ...(options.headers || {}),
    Authorization: basicAuth(serverInfo.password),
  };

  return fetch(`http://127.0.0.1:${serverInfo.port}${pathName}`, {
    ...options,
    headers,
  });
}

describe('session viewer server', () => {
  let tempDir;
  let server;
  let serverPort;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'session-viewer-test-'));
  });

  afterEach(async () => {
    if (server) {
      await stopViewerServer(server.proc);
      server = null;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('starts and serves session list', async () => {
    const session = {
      header: { type: 'session', version: 3, id: 'test-123', timestamp: '2026-03-10T10:00:00.000Z', cwd: '/test' },
      entries: [
        { type: 'model_change', id: 'abc', parentId: null, modelId: 'test-model' },
        { type: 'message', id: 'def', parentId: 'abc', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
        { type: 'message', id: 'ghi', parentId: 'def', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 } } },
      ],
      leafId: 'ghi',
      _proxy: {
        source: '192.168.1.1',
        method: 'POST',
        path: '/api/chat',
        matchedCategory: 'test-category',
        appliedActions: ['replace:model'],
        statusCode: 200,
        durationMs: 842,
        timestamp: '2026-03-10T10:00:00.000Z',
        request: { incomingBody: '{}', outgoingBody: '{}' },
        response: { body: '{}' },
      },
    };

    const sessionPath = path.join(tempDir, 'session-2026-03-10-test.jsonl');
    await writeFile(sessionPath, JSON.stringify(session) + '\n');

    server = await startViewerServer({ SESSION_LOG_DIR: tempDir });
    serverPort = server.port;

    const res = await authedFetch(server, '/api/sessions');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].source).toBe('192.168.1.1');
    expect(data.sessions[0].path).toBe('/api/chat');
    expect(data.sessions[0].inputTokens).toBe(3);
    expect(data.sessions[0].outputTokens).toBe(7);
    expect(data.sessions[0].durationMs).toBe(842);
  });

  it('serves individual session detail', async () => {
    const session = {
      header: { type: 'session', version: 3, id: 'detail-test-456', timestamp: '2026-03-10T11:00:00.000Z', cwd: '/test' },
      entries: [
        { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-03-10T11:00:00.000Z', modelId: 'qwen3.5:27b' },
        { type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-03-10T11:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Test message' }], timestamp: 1773132800000 } },
        { type: 'message', id: 'm3', parentId: 'm2', timestamp: '2026-03-10T11:00:00.001Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Response' }], timestamp: 1773132800001, model: 'qwen3.5:27b', usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 }, stopReason: 'stop' } },
      ],
      leafId: 'm3',
      _proxy: {
        source: '10.0.0.5',
        method: 'POST',
        path: '/v1/chat/completions',
        matchedCategory: 'rewrite',
        appliedActions: ['replace:model'],
        statusCode: 200,
        timestamp: '2026-03-10T11:00:00.000Z',
        request: { incomingBody: '{"model":"gpt-4"}', outgoingBody: '{"model":"qwen3.5:27b"}' },
        response: { body: '{"choices":[]}' },
      },
    };

    await writeFile(path.join(tempDir, 'session-detail.jsonl'), JSON.stringify(session) + '\n');

    server = await startViewerServer({ SESSION_LOG_DIR: tempDir });
    serverPort = server.port;

    const res = await authedFetch(server, '/api/sessions/session-detail.jsonl/0');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.session.header.id).toBe('detail-test-456');
    expect(data.session.entries).toHaveLength(3);
  });
  it('requires basic auth when password is set', async () => {
    const session = {
      header: { type: 'session', version: 3, id: 'auth-test', timestamp: '2026-03-10T12:00:00.000Z', cwd: '/test' },
      entries: [],
      leafId: null,
      _proxy: { source: '127.0.0.1', method: 'GET', path: '/api/tags', statusCode: 200 },
    };
    await writeFile(path.join(tempDir, 'session-auth.jsonl'), JSON.stringify(session) + '\n');

    server = await startViewerServer({ SESSION_LOG_DIR: tempDir, SESSION_VIEWER_PASSWORD: 'secret123' });
    serverPort = server.port;

    // Request without auth should fail
    let res1 = await fetch(`http://127.0.0.1:${serverPort}/api/sessions`);
    expect(res1.status).toBe(401);

    // Request with wrong auth should fail
    const wrongAuth = Buffer.from('admin:wrongpassword').toString('base64');
    let res2 = await fetch(`http://127.0.0.1:${serverPort}/api/sessions`, {
      headers: { Authorization: `Basic ${wrongAuth}` },
    });
    expect(res2.status).toBe(401);

    // Request with correct auth should succeed
    const correctAuth = Buffer.from('admin:secret123').toString('base64');
    let res3 = await fetch(`http://127.0.0.1:${serverPort}/api/sessions`, {
      headers: { Authorization: `Basic ${correctAuth}` },
    });
    expect(res3.status).toBe(200);
    const data = await res3.json();
    expect(data.sessions).toBeDefined();
  });
  it('fails to start without SESSION_VIEWER_PASSWORD', async () => {
    await expect(startViewerServer({ SESSION_LOG_DIR: tempDir, SESSION_VIEWER_PASSWORD: '' })).rejects.toThrow(
      /SESSION_VIEWER_PASSWORD must be set/,
    );
  });

  it('handles empty session directory', async () => {
    server = await startViewerServer({ SESSION_LOG_DIR: tempDir });
    serverPort = server.port;

    const res = await authedFetch(server, '/api/sessions');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.sessions).toEqual([]);
  });
  it('handles non-existent session', async () => {
    await writeFile(path.join(tempDir, 'session.jsonl'), JSON.stringify({ header: { type: 'session' }, entries: [] }) + '\n');

    server = await startViewerServer({ SESSION_LOG_DIR: tempDir });
    serverPort = server.port;

    const res = await authedFetch(server, '/api/sessions/nonexistent.jsonl/0');
    expect(res.status).toBe(404);
  });
  it('rejects path traversal attempts', async () => {
    await writeFile(path.join(tempDir, 'session.jsonl'), JSON.stringify({ header: { type: 'session' }, entries: [] }) + '\n');

    server = await startViewerServer({ SESSION_LOG_DIR: tempDir });
    serverPort = server.port;

    const res = await authedFetch(server, '/api/sessions/%2e%2e%2f%2e%2e%2fetc%2fpasswd.jsonl/0');
    expect(res.status).toBe(400);
  });
  it('serves HTML viewer for root path', async () => {
    server = await startViewerServer({ SESSION_LOG_DIR: tempDir });
    serverPort = server.port;

    const res = await authedFetch(server, '/');
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('Session Viewer');
    expect(html).toContain('.message-content');
    expect(html).toContain('white-space: pre-wrap');
    expect(html).toContain('function renderMessageText');
    expect(html).not.toContain('.message-content h1');
  });
});
