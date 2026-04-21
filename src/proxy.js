import { Readable } from 'node:stream';
import { request as undiciRequest } from 'undici';
import { matchRequestCategory } from './matcher.js';
import { applyActions } from './transform.js';
import { applyPreprocessing } from './preprocessing.js';
import { appendSessionLogEntry, isSessionLogEnabled } from './session-log.js';
import { buildPiSession } from './pi-session-format.js';
import {
  isRequestCacheEnabled,
  computeRequestHash,
  readCacheEntry,
  writeCacheEntry,
  serveCachedResponse,
  filterReplayableHeaders,
  shouldCacheResponse,
} from './request-cache.js';

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

function bufferToUtf8(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return null;
  }

  return buffer.toString('utf8');
}

function getRequestSource(req) {
  const xForwardedFor = req.headers['x-forwarded-for'];
  const xForwarded = req.headers['x-forwarded'];

  const forwardedValue = Array.isArray(xForwardedFor)
    ? xForwardedFor[0]
    : xForwardedFor || (Array.isArray(xForwarded) ? xForwarded[0] : xForwarded);

  if (forwardedValue) {
    return String(forwardedValue).split(',')[0].trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

export async function proxyRequest({ req, res, logger, config }) {
  const upstreamBase = process.env.OLLAMA_UPSTREAM || DEFAULT_UPSTREAM;
  const upstreamUrl = new URL(req.url || '/', upstreamBase);
  const requestPath = upstreamUrl.pathname;
  const categories = config?.categories || [];

  const abortController = new AbortController();
  const upstreamTimeoutMs = Number(process.env.UPSTREAM_TIMEOUT_MS || 60000);
  const sessionLogEnabled = isSessionLogEnabled();
  const requestSource = getRequestSource(req);
  const requestStartMs = Date.now();

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

  let requestBodyStream = req;
  let requestBodyObject = null;
  let rawBodyText = '';
  let matchedCategory = null;
  let appliedActions = [];
  let sessionIncomingRequestBuffer = null;
  let sessionOutgoingRequestBuffer = null;
  let sessionResponseBuffer = null;
  let sessionStatusCode = null;
  let sessionError = null;
  let sessionSource = 'upstream';
  let sessionCacheHit = false;
  let sessionCacheEntry = null;
  const payloadLoggingEnabled = shouldLogPayloads(logger);
  const payloadLogMaxBytes = payloadLoggingEnabled ? getPayloadLogMaxBytes() : 0;
  const requestCacheEnabled = isRequestCacheEnabled();

  const logSessionPair = async () => {
    if (!sessionLogEnabled) {
      return;
    }

    try {
      const piSession = buildPiSession({
        requestId: req.headers['x-request-id'] || null,
        source: requestSource,
        method: req.method,
        path: req.url,
        matchedCategory: matchedCategory?.name || null,
        appliedActions,
        incomingBody: bufferToUtf8(sessionIncomingRequestBuffer),
        outgoingBody: bufferToUtf8(sessionOutgoingRequestBuffer),
        responseBody: bufferToUtf8(sessionResponseBuffer),
        statusCode: sessionStatusCode,
        error: sessionError,
        durationMs: Date.now() - requestStartMs,
        cacheHit: sessionCacheHit,
      });

      await appendSessionLogEntry(piSession, { source: requestSource });
    } catch (error) {
      logger.warn({ err: error }, 'failed to write session log');
    }
  };

  try {
    if (shouldInspectBody(req, categories)) {
      const rawBuffer = await readRequestBody(req);
      rawBodyText = rawBuffer.toString('utf8');

      if (rawBodyText.trim().length > 0) {
        const parsed = safeJsonParse(rawBodyText);
        if (parsed.error) {
          const responseBody = JSON.stringify({ error: 'Bad Request', message: 'Invalid JSON request body' });
          sessionSource = 'proxy';
          sessionStatusCode = 400;
          sessionError = 'INVALID_JSON_REQUEST_BODY';
          sessionResponseBuffer = Buffer.from(responseBody, 'utf8');

          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(responseBody);
          await logSessionPair();
          return;
        }

        requestBodyObject = parsed.value;
      }

      // Apply preprocessing (message content replacement) before category matching
      let appliedPreprocessingRules = [];
      if (requestBodyObject && typeof requestBodyObject === 'object' && config?.preprocessing) {
        const preprocessingResult = applyPreprocessing(requestBodyObject, config.preprocessing);
        if (preprocessingResult.appliedRules.length > 0) {
          requestBodyObject = preprocessingResult.requestBody;
          appliedPreprocessingRules = preprocessingResult.appliedRules;
          rawBodyText = JSON.stringify(requestBodyObject);
          // Add preprocessing to appliedActions for logging
          appliedActions = appliedPreprocessingRules.map((rule) => `preprocessing:${rule}`);
        }
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
        // Prepend preprocessing actions, then add category actions
        appliedActions = [...appliedActions, ...transformed.appliedActions];
        outgoingBuffer = Buffer.from(JSON.stringify(requestBodyObject), 'utf8');
      }

      requestBodyStream = outgoingBuffer;

      if (sessionLogEnabled) {
        sessionIncomingRequestBuffer = rawBuffer;
        sessionOutgoingRequestBuffer = outgoingBuffer;
      }

      logger.info(
        {
          path: requestPath,
          matchedCategory: matchedCategory?.name || null,
          appliedActions,
          appliedPreprocessingRules,
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

      // Cache lookup: check cache after all transforms are applied
      if (requestCacheEnabled && Buffer.isBuffer(outgoingBuffer)) {
        const cacheHash = computeRequestHash(outgoingBuffer);
        const cachedEntry = await readCacheEntry(cacheHash);

        if (cachedEntry !== null) {
          // Cache hit — serve from cache, skip upstream
          sessionCacheHit = true;
          sessionSource = 'cache';
          sessionStatusCode = cachedEntry.statusCode;
          sessionResponseBuffer = Buffer.from(cachedEntry.responseBody, 'utf8');

          logger.info(
            {
              path: requestPath,
              matchedCategory: matchedCategory?.name || null,
              appliedActions,
              appliedPreprocessingRules,
              cacheHash,
            },
            'cache hit — serving cached response (15s delay)',
          );

          // Simulate thinking time by delaying 15 seconds before serving cached response
          await new Promise((resolve) => setTimeout(resolve, 15000));

          serveCachedResponse(res, cachedEntry);
          await logSessionPair();
          return;
        }

        // Cache miss — store metadata for cache write after upstream response
        sessionCacheEntry = { hash: cacheHash, requestBody: bufferToUtf8(outgoingBuffer) };

        logger.debug(
          {
            path: requestPath,
            cacheHash,
          },
          'cache miss — proceeding to upstream',
        );
      }
    } else if (sessionLogEnabled) {
      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        const rawBuffer = await readRequestBody(req);
        requestBodyStream = rawBuffer;
        sessionIncomingRequestBuffer = rawBuffer;
        sessionOutgoingRequestBuffer = rawBuffer;
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

    sessionStatusCode = upstreamResponse.statusCode;
    const upstreamHeaders = upstreamResponse.headers;

    res.writeHead(upstreamResponse.statusCode, filterResponseHeaders(upstreamHeaders));

    const responseBody = toNodeReadable(upstreamResponse.body);
    if (!responseBody) {
      sessionStatusCode = upstreamResponse.statusCode;
      sessionResponseBuffer = Buffer.from('', 'utf8');
      await logSessionPair();
      res.end();
      return;
    }

    const responseCaptureEnabled = payloadLoggingEnabled || sessionLogEnabled;
    let responsePayloadBytes = 0;
    let responsePreviewBytes = 0;
    const responsePreviewChunks = [];
    const responseChunks = [];

    if (responseCaptureEnabled) {
      responseBody.on('data', (chunk) => {
        const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responsePayloadBytes += chunkBuffer.byteLength;

        if (sessionLogEnabled) {
          responseChunks.push(chunkBuffer);
        }

        if (!payloadLoggingEnabled || responsePreviewBytes >= payloadLogMaxBytes) {
          return;
        }

        const remaining = payloadLogMaxBytes - responsePreviewBytes;
        const previewChunk =
          chunkBuffer.byteLength > remaining ? chunkBuffer.subarray(0, remaining) : chunkBuffer;

        responsePreviewChunks.push(previewChunk);
        responsePreviewBytes += previewChunk.byteLength;
      });
    }

    responseBody.on('end', async () => {
      if (sessionLogEnabled) {
        sessionResponseBuffer = Buffer.concat(responseChunks);
      }

      // Persist response to cache if eligible (non-streaming, successful JSON)
      if (
        requestCacheEnabled &&
        sessionCacheEntry !== null &&
        shouldCacheResponse(requestPath, requestBodyObject, upstreamResponse.statusCode, upstreamHeaders)
      ) {
        const responseText = Buffer.concat(responseChunks).toString('utf8');
        void writeCacheEntry(sessionCacheEntry.hash, {
          requestBody: sessionCacheEntry.requestBody,
          statusCode: upstreamResponse.statusCode,
          responseHeaders: filterReplayableHeaders(upstreamHeaders),
          responseBody: responseText,
          cacheSource: 'upstream',
        })
          .then(() => {
            logger.debug({ cacheHash: sessionCacheEntry.hash }, 'response cached');
          })
          .catch((err) => {
            logger.warn({ err, cacheHash: sessionCacheEntry.hash }, 'failed to write cache entry');
          });
      }

      if (payloadLoggingEnabled) {
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
      }

      await logSessionPair();
    });

    responseBody.on('error', (error) => {
      sessionSource = 'upstream';
      sessionError = error?.message || 'UPSTREAM_STREAM_ERROR';
      if (sessionLogEnabled && !sessionResponseBuffer) {
        sessionResponseBuffer = Buffer.concat(responseChunks);
        void logSessionPair();
      }

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
      const responseBody = JSON.stringify({ error: 'Gateway Timeout', message: 'Upstream request timed out' });
      sessionSource = 'proxy';
      sessionStatusCode = 504;
      sessionError = 'UPSTREAM_TIMEOUT';
      sessionResponseBuffer = Buffer.from(responseBody, 'utf8');

      if (!res.headersSent) {
        res.writeHead(504, { 'content-type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(responseBody);
      }
      await logSessionPair();
      return;
    }

    if (abortController.signal.aborted) {
      logger.info({ reason }, 'request aborted');
      return;
    }

    logger.error({ err: error }, 'proxy request failed');
    const responseBody = JSON.stringify({ error: 'Bad Gateway', message: 'Failed to reach upstream Ollama' });
    sessionSource = 'proxy';
    sessionStatusCode = 502;
    sessionError = error?.message || 'PROXY_REQUEST_FAILED';
    sessionResponseBuffer = Buffer.from(responseBody, 'utf8');

    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    if (!res.writableEnded) {
      res.end(responseBody);
    }
    await logSessionPair();
  } finally {
    req.off('aborted', onRequestAborted);
    res.off('close', onResponseClosed);
  }
}
