import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { logger as defaultLogger } from './logger.js';
import { loadConfig } from './config.js';
import { proxyRequest } from './proxy.js';

const DEFAULT_HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_PORT = Number(process.env.PORT || 11435);

export async function createReverseOllamaServer({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  logger = defaultLogger,
} = {}) {
  let loadedConfig = await loadConfig();
  logger.info({ configPath: loadedConfig.configPath }, 'configuration loaded');

  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const start = Date.now();

    req.headers['x-request-id'] = req.headers['x-request-id'] || requestId;

    res.on('finish', () => {
      logger.info(
        {
          requestId,
          method: req.method,
          path: req.url,
          statusCode: res.statusCode,
          durationMs: Date.now() - start,
        },
        'request completed',
      );
    });

    await proxyRequest({
      req,
      res,
      logger: logger.child({ requestId }),
      config: loadedConfig.config,
    });
  });

  server.on('error', (error) => {
    logger.error({ err: error }, 'server error');
  });

  const reloadConfig = async () => {
    loadedConfig = await loadConfig();
    logger.info({ configPath: loadedConfig.configPath }, 'configuration reloaded');
  };

  const start = () =>
    new Promise((resolve) => {
      server.listen(port, host, () => {
        logger.info({ host, port }, 'reverse-ollama server listening');
        resolve();
      });
    });

  const stop = () =>
    new Promise((resolve) => {
      server.close(() => {
        logger.info('server closed');
        resolve();
      });
    });

  return {
    server,
    start,
    stop,
    reloadConfig,
  };
}

export async function bootstrap() {
  const { start, stop, reloadConfig } = await createReverseOllamaServer();
  await start();

  process.on('SIGHUP', async () => {
    try {
      await reloadConfig();
    } catch (error) {
      defaultLogger.error({ err: error }, 'failed to reload configuration');
    }
  });

  const shutdown = (signal) => {
    defaultLogger.info({ signal }, 'shutting down');

    stop().then(() => process.exit(0));

    setTimeout(() => {
      defaultLogger.warn('forcing shutdown after timeout');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const modulePath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (entryPath && modulePath === entryPath) {
  bootstrap().catch((error) => {
    defaultLogger.error({ err: error }, 'failed to start server');
    process.exit(1);
  });
}
