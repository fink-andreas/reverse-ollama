import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReverseOllamaServer } from '../src/server.js';

function listen(server, host = '127.0.0.1', port = 0) {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

async function getFreePort() {
  const probe = http.createServer((_, res) => res.end('ok'));
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 1500) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function createMemoryLogger({ debugEnabled = false } = {}) {
  const entries = [];

  const createLogger = (bindings = {}) => ({
    entries,
    isLevelEnabled: (level) => {
      if (level === 'debug' || level === 'trace') {
        return debugEnabled;
      }
      return true;
    },
    child: (childBindings = {}) => createLogger({ ...bindings, ...childBindings }),
    info: (obj = {}, msg = '') => entries.push({ level: 'info', obj: { ...bindings, ...obj }, msg }),
    warn: (obj = {}, msg = '') => entries.push({ level: 'warn', obj: { ...bindings, ...obj }, msg }),
    error: (obj = {}, msg = '') => entries.push({ level: 'error', obj: { ...bindings, ...obj }, msg }),
    debug: (obj = {}, msg = '') => entries.push({ level: 'debug', obj: { ...bindings, ...obj }, msg }),
  });

  return createLogger();
}

describe('proxy integration', () => {
  const servers = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      if (typeof server.stop === 'function') {
        await server.stop();
      } else {
        await new Promise((resolve) => server.close(resolve));
      }
    }

    delete process.env.REVERSE_OLLAMA_CONFIG;
    delete process.env.OLLAMA_UPSTREAM;
    delete process.env.UPSTREAM_TIMEOUT_MS;
    delete process.env.LOG_PAYLOADS;
    delete process.env.LOG_PAYLOAD_MAX_BYTES;
  });

  it('forwards request transparently and supports streaming', async () => {
    const upstream = http.createServer(async (req, res) => {
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('chunk-1\n');
        setTimeout(() => {
          res.write('chunk-2\n');
          res.end();
        }, 50);
        return;
      }

      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          body,
        }),
      );
    });

    const upstreamPort = await listen(upstream);
    servers.push(upstream);

    const tempDir = await mkdtemp(path.join(tmpdir(), 'reverse-ollama-test-'));
    const configPath = path.join(tempDir, 'categories.json');
    await writeFile(configPath, JSON.stringify({ categories: [] }), 'utf8');

    const proxyPort = await getFreePort();
    process.env.REVERSE_OLLAMA_CONFIG = configPath;
    process.env.OLLAMA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;

    const proxy = await createReverseOllamaServer({ host: '127.0.0.1', port: proxyPort });
    await proxy.start();
    servers.push(proxy);

    const echoResponse = await fetchWithTimeout(`http://127.0.0.1:${proxyPort}/echo?q=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const echoJson = await echoResponse.json();

    expect(echoJson.method).toBe('POST');
    expect(echoJson.url).toBe('/echo?q=1');
    expect(echoJson.body).toBe('{"hello":"world"}');

    const streamResponse = await fetchWithTimeout(`http://127.0.0.1:${proxyPort}/stream`, {}, 4000);
    const streamText = await streamResponse.text();
    expect(streamText).toContain('chunk-1');
    expect(streamText).toContain('chunk-2');
  });

  it('applies category-based model replacement', async () => {
    const upstream = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.concat(chunks).toString('utf8'));
    });

    const upstreamPort = await listen(upstream);
    servers.push(upstream);

    const tempDir = await mkdtemp(path.join(tmpdir(), 'reverse-ollama-test-'));
    const configPath = path.join(tempDir, 'categories.json');
    await writeFile(
      configPath,
      JSON.stringify({
        categories: [
          {
            name: 'coding',
            endpoints: ['/api/chat'],
            match: { messagesRegex: 'debug', flags: 'i' },
            actions: { model: 'codellama:latest', num_ctx: 4096 },
          },
        ],
      }),
      'utf8',
    );

    const proxyPort = await getFreePort();
    process.env.REVERSE_OLLAMA_CONFIG = configPath;
    process.env.OLLAMA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;

    const proxy = await createReverseOllamaServer({ host: '127.0.0.1', port: proxyPort });
    await proxy.start();
    servers.push(proxy);

    const response = await fetchWithTimeout(`http://127.0.0.1:${proxyPort}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2', messages: [{ content: 'please debug this' }] }),
    });

    const body = await response.json();
    expect(body.model).toBe('codellama:latest');
    expect(body.options.num_ctx).toBe(4096);
  });

  it('emits payload debug logs only when enabled', async () => {
    const upstream = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.concat(chunks).toString('utf8'));
    });

    const upstreamPort = await listen(upstream);
    servers.push(upstream);

    const tempDir = await mkdtemp(path.join(tmpdir(), 'reverse-ollama-test-'));
    const configPath = path.join(tempDir, 'categories.json');
    await writeFile(
      configPath,
      JSON.stringify({
        categories: [
          {
            name: 'coding',
            endpoints: ['/api/chat'],
            match: { rawRegex: '.*' },
            actions: { model: 'codellama:latest' },
          },
        ],
      }),
      'utf8',
    );

    const proxyPort = await getFreePort();
    process.env.REVERSE_OLLAMA_CONFIG = configPath;
    process.env.OLLAMA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
    process.env.LOG_PAYLOADS = 'true';
    process.env.LOG_PAYLOAD_MAX_BYTES = '24';

    const logger = createMemoryLogger({ debugEnabled: true });
    const proxy = await createReverseOllamaServer({ host: '127.0.0.1', port: proxyPort, logger });
    await proxy.start();
    servers.push(proxy);

    const response = await fetchWithTimeout(`http://127.0.0.1:${proxyPort}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2', prompt: 'debug this very long payload please' }),
    });

    expect(response.status).toBe(200);

    const payloadLog = logger.entries.find((entry) => entry.level === 'debug' && entry.msg === 'request payload debug');

    expect(payloadLog).toBeDefined();
    expect(payloadLog.obj.incomingPayloadBytes).toBeGreaterThan(24);
    expect(payloadLog.obj.incomingPayloadTruncated).toBe(true);
    expect(payloadLog.obj.outgoingPayloadBytes).toBeGreaterThan(24);
    expect(payloadLog.obj.outgoingPayloadTruncated).toBe(true);
    expect(payloadLog.obj.outgoingPayload).toContain('codellama');
  });

  it('returns 400 for invalid JSON body when inspection is required', async () => {
    const upstream = http.createServer(async (_, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    const upstreamPort = await listen(upstream);
    servers.push(upstream);

    const tempDir = await mkdtemp(path.join(tmpdir(), 'reverse-ollama-test-'));
    const configPath = path.join(tempDir, 'categories.json');
    await writeFile(
      configPath,
      JSON.stringify({
        categories: [
          {
            name: 'json-only',
            endpoints: ['/api/chat'],
            match: { rawRegex: '.*' },
            actions: { model: 'codellama:latest' },
          },
        ],
      }),
      'utf8',
    );

    const proxyPort = await getFreePort();
    process.env.REVERSE_OLLAMA_CONFIG = configPath;
    process.env.OLLAMA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;

    const proxy = await createReverseOllamaServer({ host: '127.0.0.1', port: proxyPort });
    await proxy.start();
    servers.push(proxy);

    const response = await fetchWithTimeout(`http://127.0.0.1:${proxyPort}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{invalid',
    });

    expect(response.status).toBe(400);
  });

  it('returns 502 when upstream connection fails', async () => {
    const flakyUpstream = http.createServer((req) => {
      req.socket.destroy();
    });

    const upstreamPort = await listen(flakyUpstream);
    servers.push(flakyUpstream);

    const tempDir = await mkdtemp(path.join(tmpdir(), 'reverse-ollama-test-'));
    const configPath = path.join(tempDir, 'categories.json');
    await writeFile(configPath, JSON.stringify({ categories: [] }), 'utf8');

    const proxyPort = await getFreePort();

    process.env.REVERSE_OLLAMA_CONFIG = configPath;
    process.env.OLLAMA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;

    const proxy = await createReverseOllamaServer({ host: '127.0.0.1', port: proxyPort });
    await proxy.start();
    servers.push(proxy);

    const response = await fetchWithTimeout(`http://127.0.0.1:${proxyPort}/api/tags`, {}, 4000);
    expect(response.status).toBe(502);
  });
});
