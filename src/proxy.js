import { Readable } from 'node:stream';
import { request as undiciRequest } from 'undici';
import { matchRequestCategory } from './matcher.js';
import { applyActions } from './transform.js';

const DEFAULT_UPSTREAM = 'http://127.0.0.1:11434';
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
]);

function toNodeReadable(body) {
  if (!body) {
    return null;
  }

  if (typeof body.pipe === 'function') {
    return body;
  }

  return Readable.fromWeb(body);
}

function filterRequestHeaders(headers, contentLength) {
  const next = {};

  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined) {
      continue;
    }

    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'host' || lower === 'content-length') {
      continue;
    }

    next[key] = value;
  }

  if (contentLength !== undefined) {
    next['content-length'] = String(contentLength);
  }

  return next;
}

function filterResponseHeaders(headers) {
  const next = {};

  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined) {
      continue;
    }

    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) {
      continue;
    }

    next[key] = value;
  }

  return next;
}

function shouldInspectBody(req, categories) {
  if (!categories || categories.length === 0) {
    return false;
  }

  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return false;
  }

  const contentType = String(req.headers['content-type'] || '');
  return contentType.includes('application/json');
}

async function readRequestBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function safeJsonParse(raw) {
  try {
    return { value: JSON.parse(raw), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function shouldLogPayloads(logger) {
  if (!isTruthyEnv(process.env.LOG_PAYLOADS)) {
    return false;
  }

  if (typeof logger?.isLevelEnabled === 'function') {
    return logger.isLevelEnabled('debug');
  }

  const level = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return level === 'debug' || level === 'trace';
}

function getPayloadLogMaxBytes() {
  const value = Number(process.env.LOG_PAYLOAD_MAX_BYTES || 4096);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 4096;
}

function payloadPreviewFromBuffer(buffer, maxBytes) {
  if (!Buffer.isBuffer(buffer)) {
    return { text: '', bytes: 0, truncated: false };
  }

  if (buffer.byteLength <= maxBytes) {
    return {
      text: buffer.toString('utf8'),
      bytes: buffer.byteLength,
      truncated: false,
    };
  }

  return {
    text: buffer.subarray(0, maxBytes).toString('utf8'),
    bytes: buffer.byteLength,
    truncated: true,
  };
}

export async function proxyRequest({ req, res, logger, config }) {
  const upstreamBase = process.env.OLLAMA_UPSTREAM || DEFAULT_UPSTREAM;
  const upstreamUrl = new URL(req.url || '/', upstreamBase);
  const requestPath = upstreamUrl.pathname;
  const categories = config?.categories || [];

  const abortController = new AbortController();
  const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 60000);

  const onRequestAborted = () => {
    abortController.abort('client request aborted');
  };

  const onResponseClosed = () => {
    if (!res.writableEnded) {
      abortController.abort('client connection closed');
    }
  };

  req.on('aborted', onRequestAborted);
  res.on('close', onResponseClosed);

  try {
    let requestBodyStream = req;
    let requestBodyObject = null;
    let rawBodyText = '';
    let matchedCategory = null;
    let appliedActions = [];
    const payloadLoggingEnabled = shouldLogPayloads(logger);
    const payloadLogMaxBytes = payloadLoggingEnabled ? getPayloadLogMaxBytes() : 0;

    if (shouldInspectBody(req, categories)) {
      const rawBuffer = await readRequestBody(req);
      rawBodyText = rawBuffer.toString('utf8');

      if (rawBodyText.trim().length > 0) {
        const parsed = safeJsonParse(rawBodyText);
        if (parsed.error) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bad Request', message: 'Invalid JSON request body' }));
          return;
        }

        requestBodyObject = parsed.value;
      }

      matchedCategory = matchRequestCategory({
        categories,
        requestPath,
        requestBody: requestBodyObject,
        rawBodyText,
      });

      let outgoingBuffer = rawBuffer;

      if (matchedCategory && requestBodyObject && typeof requestBodyObject === 'object') {
        const transformed = applyActions({
          requestBody: requestBodyObject,
          category: matchedCategory,
        });
        requestBodyObject = transformed.requestBody;
        appliedActions = transformed.appliedActions;
        outgoingBuffer = Buffer.from(JSON.stringify(requestBodyObject), 'utf8');
      }

      requestBodyStream = outgoingBuffer;

      logger.info(
        {
          path: requestPath,
          matchedCategory: matchedCategory?.name || null,
          appliedActions,
        },
        'request classification complete',
      );

      if (payloadLoggingEnabled) {
        const incoming = payloadPreviewFromBuffer(rawBuffer, payloadLogMaxBytes);
        const outgoing = payloadPreviewFromBuffer(outgoingBuffer, payloadLogMaxBytes);

        logger.debug(
          {
            path: requestPath,
            payloadLogMaxBytes: payloadLogMaxBytes,
            incomingPayload: incoming.text,
            incomingPayloadBytes: incoming.bytes,
            incomingPayloadTruncated: incoming.truncated,
            outgoingPayload: outgoing.text,
            outgoingPayloadBytes: outgoing.bytes,
            outgoingPayloadTruncated: outgoing.truncated,
          },
          'request payload debug',
        );
      }
    }

    const contentLength = Buffer.isBuffer(requestBodyStream) ? requestBodyStream.byteLength : undefined;

    const upstreamRequestPromise = undiciRequest(upstreamUrl, {
      method: req.method,
      headers: filterRequestHeaders(req.headers, contentLength),
      body: requestBodyStream,
      signal: abortController.signal,
    });

    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        abortController.abort('upstream timeout');
        reject(new Error('UPSTREAM_TIMEOUT'));
      }, upstreamTimeoutMs);
      timeout.unref();
    });

    const upstreamResponse = await Promise.race([upstreamRequestPromise, timeoutPromise]);
    clearTimeout(timeout);

    res.writeHead(upstreamResponse.statusCode, filterResponseHeaders(upstreamResponse.headers));

    const responseBody = toNodeReadable(upstreamResponse.body);
    if (!responseBody) {
      res.end();
      return;
    }

    if (payloadLoggingEnabled) {
      let responsePayloadBytes = 0;
      let responsePreviewBytes = 0;
      const responsePreviewChunks = [];

      responseBody.on('data', (chunk) => {
        const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responsePayloadBytes += chunkBuffer.byteLength;

        if (responsePreviewBytes >= payloadLogMaxBytes) {
          return;
        }

        const remaining = payloadLogMaxBytes - responsePreviewBytes;
        const previewChunk =
          chunkBuffer.byteLength > remaining ? chunkBuffer.subarray(0, remaining) : chunkBuffer;

        responsePreviewChunks.push(previewChunk);
        responsePreviewBytes += previewChunk.byteLength;
      });

      responseBody.on('end', () => {
        const responsePreview = Buffer.concat(responsePreviewChunks).toString('utf8');

        logger.debug(
          {
            path: requestPath,
            statusCode: upstreamResponse.statusCode,
            payloadLogMaxBytes: payloadLogMaxBytes,
            responsePayload: responsePreview,
            responsePayloadBytes: responsePayloadBytes,
            responsePayloadTruncated: responsePayloadBytes > payloadLogMaxBytes,
          },
          'response payload debug',
        );
      });
    }

    responseBody.on('error', (error) => {
      logger.warn({ err: error }, 'upstream response stream error');
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: 'Bad Gateway', message: 'Upstream stream error' }));
      }
    });

    responseBody.pipe(res);
  } catch (error) {
    const reason = String(abortController.signal.reason || '');
    if (reason.includes('upstream timeout') || error?.message === 'UPSTREAM_TIMEOUT') {
      logger.warn({ reason }, 'upstream timed out');
      if (!res.headersSent) {
        res.writeHead(504, { 'content-type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: 'Gateway Timeout', message: 'Upstream request timed out' }));
      }
      return;
    }

    if (abortController.signal.aborted) {
      logger.info({ reason }, 'request aborted');
      return;
    }

    logger.error({ err: error }, 'proxy request failed');
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ error: 'Bad Gateway', message: 'Failed to reach upstream Ollama' }));
    }
  } finally {
    req.off('aborted', onRequestAborted);
    res.off('close', onResponseClosed);
  }
}
