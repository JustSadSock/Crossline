const http = require('http');
const fs = require('fs');
const path = require('path');
const cluster = require('cluster');
const { promisify } = require('util');
const WebSocket = require('ws');
const {
  createRoom,
  getRoom,
  listRooms,
  pruneRooms,
  ensureDefaultRooms,
} = require('./functions/roomManager');
const config = require('./config');
const logger = require('./logger');
const monitoring = require('./monitoring');

const readFile = promisify(fs.readFile);
const access = promisify(fs.access);

const ROOT_DIR = path.resolve(__dirname, '..');
const STATIC_DIRS = new Set(['styles', 'scripts', 'assets']);
const PING_INTERVAL_MS = Math.max(5000, parseInt(process.env.CROSSLINE_PING_INTERVAL_MS, 10) || 15000);
const SECURITY_CONFIG = config.security;
const CORS_ALLOWED_ORIGINS = SECURITY_CONFIG.cors.allowedOrigins;
const CORS_ALLOW_SAME_HOST = SECURITY_CONFIG.cors.allowSameHost;
const CORS_ALLOW_ANY = SECURITY_CONFIG.cors.allowAny;
const WS_ALLOWED_ORIGINS = SECURITY_CONFIG.websocket.allowedOrigins;
const WS_ALLOW_SAME_HOST = SECURITY_CONFIG.websocket.allowSameHost;
const WS_ALLOW_ANY = SECURITY_CONFIG.websocket.allowAny;
const MAX_BODY_BYTES = SECURITY_CONFIG.http.maxBodyBytes;

bootstrap();

function bootstrap() {
  const clusterEnabled = config.cluster.enabled;
  if (clusterEnabled && cluster.isPrimary) {
    const workerCount = config.cluster.workers;
    logger.info({ workerCount, pid: process.pid }, 'cluster primary launching workers');
    for (let index = 0; index < workerCount; index += 1) {
      cluster.fork();
    }

    cluster.on('online', (worker) => {
      logger.info({ worker: worker.process.pid }, 'cluster worker online');
    });

    cluster.on('exit', (worker, code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      logger.warn({ worker: worker.process.pid, reason }, 'cluster worker exited');
      if (code !== 0 && !signal) {
        logger.warn('cluster restarting worker');
        cluster.fork();
      }
    });
    return;
  }

  if (!clusterEnabled && cluster.isPrimary) {
    logger.info('cluster disabled; running in single-process mode');
  }

  startServer();
}

function startServer() {
  const DEFAULT_PORT = 3000;
  const requestedPort = parsePort(process.env.PORT, DEFAULT_PORT);
  const candidatePorts = buildPortList(requestedPort, DEFAULT_PORT);
  let booting = true;
  let lastPortAttempted = null;

  if (cluster.isWorker) {
    logger.info({ pid: process.pid }, 'cluster worker starting game server');
  }

  ensureDefaultRooms();
  setInterval(() => pruneRooms(), 60 * 1000);

  const server = http.createServer(async (req, res) => {
    const start = process.hrtime.bigint();
    const requestMeta = {
      method: req.method,
      url: req.url,
      remoteAddress: req.socket && req.socket.remoteAddress,
    };
    let completed = false;
    const logCompletion = () => {
      if (completed) {
        return;
      }
      completed = true;
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const statusCode = typeof res.statusCode === 'number' ? res.statusCode : Number(res.statusCode) || 0;
      monitoring.trackRequest(requestMeta.method, statusCode, durationMs);
      logger.info({ ...requestMeta, statusCode, durationMs }, 'http request');
    };
    const logError = (error) => {
      monitoring.trackError('http');
      logger.error({ ...requestMeta, err: error }, 'http request error');
    };

    res.on('finish', logCompletion);
    res.on('close', logCompletion);
    res.on('error', logError);

    if (applyCors(req, res)) {
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/rooms') {
      const rooms = listRooms();
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(rooms));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/rooms') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body || '{}');
        const name = typeof payload.name === 'string' ? payload.name : '';
        const room = createRoom({ name: sanitizeName(name).slice(0, 24) });
        const info = room.getLobbyInfo();
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(201);
        res.end(JSON.stringify(info));
      } catch (error) {
        logError(error);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (error && error.code === 'LIMIT_BODY') {
          res.writeHead(413);
          res.end('Превышен размер запроса');
        } else {
          res.writeHead(400);
          res.end('Не удалось создать комнату');
        }
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(
        JSON.stringify({
          status: 'ok',
          metrics: monitoring.snapshot(),
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      try {
        const payload = await monitoring.collect();
        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.writeHead(200);
        res.end(payload);
      } catch (error) {
        logError(error);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.writeHead(503);
        res.end('Не удалось собрать метрики');
      }
      return;
    }

    serveStatic(url.pathname, res);
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  const wss = new WebSocket.Server({
    server,
    verifyClient: (info, done) => {
      if (allowWebSocketConnection(info)) {
        done(true);
        return;
      }

      const origin = info.origin || (info.req && info.req.headers && info.req.headers.origin) || '';
      logger.warn({ origin }, 'blocked websocket handshake due to origin');
      done(false, 403, 'Forbidden');
    },
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const roomId = url.searchParams.get('room');
    const playerName = sanitizeName(url.searchParams.get('name') || '');
    const connectionLog = logger.child({
      roomId,
      remoteAddress: req.socket && req.socket.remoteAddress,
    });

    if (!roomId) {
      sendAndClose(ws, 'Комната не указана', 1008);
      return;
    }

    const room = getRoom(roomId);
    if (!room) {
      sendAndClose(ws, 'Комната не найдена', 1008);
      return;
    }

    if (room.isFull()) {
      sendAndClose(ws, 'Комната заполнена', 1008);
      return;
    }

    let playerId;
    try {
      playerId = room.attachClient(ws, playerName);
      ws.__playerId = playerId;
      connectionLog.info({ playerId }, 'websocket client attached');
    } catch (error) {
      connectionLog.error({ err: error }, 'websocket attach error');
      sendAndClose(ws, 'Не удалось присоединиться', 1011);
      return;
    }

    const pingState = {
      timer: null,
      lastSentAt: 0,
    };

    const sendPing = () => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      pingState.lastSentAt = Date.now();
      const buffer = Buffer.allocUnsafe(8);
      buffer.writeDoubleBE(pingState.lastSentAt, 0);
      try {
        ws.ping(buffer, false);
      } catch (error) {
        connectionLog.warn({ err: error }, 'failed to send websocket ping');
      }
    };

    pingState.timer = setInterval(sendPing, PING_INTERVAL_MS);
    sendPing();

    ws.on('message', (data) => {
      room.handleMessage(playerId, data);
    });

    ws.on('close', () => {
      if (pingState.timer) {
        clearInterval(pingState.timer);
      }
      connectionLog.info({ playerId }, 'websocket client disconnected');
      room.detachClient(playerId);
    });

    ws.on('error', (error) => {
      if (pingState.timer) {
        clearInterval(pingState.timer);
      }
      monitoring.trackError('websocket');
      connectionLog.error({ err: error, playerId }, 'websocket error');
      room.detachClient(playerId);
    });

    ws.on('pong', (data) => {
      const sentAt =
        Buffer.isBuffer(data) && data.length >= 8 ? data.readDoubleBE(0) : pingState.lastSentAt;
      if (sentAt) {
        const latency = Date.now() - sentAt;
        monitoring.recordLatency(latency);
        connectionLog.debug({ playerId, latency }, 'websocket latency sample');
      }
    });
  });

  server.on('clientError', (error, socket) => {
    logIssue('HTTP client error', error);
    if (socket && !socket.destroyed) {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch (socketError) {
        logIssue('Failed to close client socket gracefully', socketError);
      }
    }
  });

  server.on('error', (error) => {
    if (booting && isBindError(error) && candidatePorts.length) {
      const previousPort = lastPortAttempted;
      const nextPeek = candidatePorts[0];
      const nextLabel = typeof nextPeek === 'undefined' ? 'n/a' : nextPeek === 0 ? 'auto (random open port)' : nextPeek;
      logger.warn(
        {
          attemptedPort: previousPort,
          nextPort: nextLabel,
          code: error.code,
        },
        'boot port unavailable; retrying',
      );
      setTimeout(() => attemptListen(), 750);
      return;
    }
    logIssue('HTTP server error', error);
  });

  wss.on('error', (error) => {
    if (booting && isBindError(error)) {
      return;
    }
    logIssue('WebSocket server error', error);
  });

  const attemptListen = () => {
    const nextPort = candidatePorts.shift();
    if (typeof nextPort === 'undefined') {
      logger.error('no available ports to bind; exiting');
      process.exit(1);
    }
    const label = nextPort === 0 ? 'auto (random open port)' : nextPort;
    logger.info({ port: label }, 'attempting to listen');
    lastPortAttempted = nextPort;
    server.listen(nextPort);
  };

  attemptListen();

  server.on('listening', () => {
    const address = server.address();
    const port = typeof address === 'string' ? requestedPort : address.port;
    process.env.PORT = String(port);
    booting = false;
    if (port !== requestedPort) {
      logger.warn({ requestedPort, port }, 'requested port unavailable; using fallback');
    }
    logger.info({ port }, 'server listening');
  });

  process.on('uncaughtException', (error) => {
    logIssue('Uncaught exception', error);
  });

  process.on('unhandledRejection', (reason) => {
    logIssue('Unhandled rejection', reason);
  });
}

function logIssue(context, error) {
  monitoring.trackError('server');
  if (error instanceof Error) {
    logger.error({ err: error }, context);
  } else {
    logger.error({ detail: error }, context);
  }
}

async function serveStatic(requestPath, res) {
  let filePath;
  if (requestPath === '/' || requestPath === '') {
    filePath = path.join(ROOT_DIR, 'index.html');
  } else {
    const cleanPath = requestPath.replace(/\.\.+/g, '');
    const segments = cleanPath.split('/').filter(Boolean);
    if (segments.length && STATIC_DIRS.has(segments[0])) {
      filePath = path.join(ROOT_DIR, ...segments);
    } else {
      filePath = path.join(ROOT_DIR, cleanPath);
    }
  }

  try {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(ROOT_DIR)) {
      throw new Error('Forbidden');
    }
    await access(resolved, fs.constants.R_OK);
    const ext = path.extname(resolved).toLowerCase();
    const mimeType = getMimeType(ext);
    const content = await readFile(resolved);
    res.setHeader('Content-Type', mimeType);
    res.writeHead(200);
    res.end(content);
  } catch (error) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.writeHead(404);
    res.end('Файл не найден');
  }
}

function getMimeType(ext) {
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const abort = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    req.on('data', (chunk) => {
      if (settled || !chunk) {
        return;
      }
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(bufferChunk);
      totalBytes += bufferChunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        abort(createBodyLimitError());
        req.destroy();
        return;
      }
    });

    req.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        const buffer = Buffer.concat(chunks);
        resolve(buffer.toString('utf8'));
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', abort);
  });
}

function sanitizeName(value) {
  return (value || '')
    .toString()
    .replace(/[^a-zA-Z0-9а-яА-Я_\-\s]/g, '')
    .trim()
    .slice(0, 20);
}

function sendAndClose(ws, message, code = 1000) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      const payload = encodeErrorMessage(typeof message === 'string' ? message : 'Ошибка');
      ws.send(payload, { binary: true });
    }
    ws.close(code);
  } catch (error) {
    // ignore
  }
}

function encodeErrorMessage(message) {
  const text = message || '';
  const length = Math.min(255, Buffer.byteLength(text, 'utf8'));
  const buffer = Buffer.allocUnsafe(2 + length);
  let offset = 0;
  buffer.writeUInt8(3, offset);
  offset += 1;
  buffer.writeUInt8(length & 0xff, offset);
  offset += 1;
  if (length) {
    buffer.write(text, offset, length, 'utf8');
  }
  return buffer;
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed;
  }
  return fallback;
}

function buildPortList(primary, fallback) {
  const ports = [primary];
  if (primary !== fallback) {
    ports.push(fallback);
  }
  if (primary !== 3000 && fallback !== 3000) {
    ports.push(3000);
  }
  ports.push(0);
  return ports;
}

function createBodyLimitError() {
  const error = new Error('Body too large');
  error.code = 'LIMIT_BODY';
  return error;
}

function isBindError(error) {
  return (
    error instanceof Error &&
    (error.code === 'EADDRINUSE' || error.code === 'EACCES' || error.code === 'EADDRNOTAVAIL')
  );
}

function applyCors(req, res) {
  const originHeader = req.headers.origin;
  const hasAllowedOrigins = CORS_ALLOWED_ORIGINS.size > 0;

  if (CORS_ALLOW_ANY) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (originHeader) {
    appendVaryHeader(res, 'Origin');
    const isAllowed =
      (hasAllowedOrigins && isOriginExplicitlyAllowed(originHeader)) ||
      (CORS_ALLOW_SAME_HOST && isSameHostOrigin(originHeader, req.headers));

    if (!isAllowed) {
      if (req.method === 'OPTIONS') {
        res.writeHead(403);
        res.end();
      } else {
        res.writeHead(403);
        res.end('Недопустимый источник CORS');
      }
      return true;
    }

    res.setHeader('Access-Control-Allow-Origin', originHeader);
  } else if (hasAllowedOrigins) {
    // Non-browser clients without an Origin header should not receive an
    // arbitrary allowed origin, so we omit the header.
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'false');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}

function appendVaryHeader(res, value) {
  const existing = res.getHeader('Vary');
  if (!existing) {
    res.setHeader('Vary', value);
    return;
  }

  const current = Array.isArray(existing) ? existing.join(',') : String(existing);
  const values = current
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!values.includes(value)) {
    values.push(value);
    res.setHeader('Vary', values.join(', '));
  }
}

// cluster configuration is resolved centrally in server/config.js
function isOriginExplicitlyAllowed(origin) {
  if (!origin) {
    return false;
  }

  return CORS_ALLOWED_ORIGINS.has(origin.toLowerCase());
}

function isSameHostOrigin(origin, headers) {
  if (!origin || !headers) {
    return false;
  }

  const forwardedHost = headers['x-forwarded-host'];
  const hostHeader = forwardedHost ? forwardedHost.split(',')[0].trim() : headers.host;
  if (!hostHeader) {
    return false;
  }

  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === hostHeader.toLowerCase();
  } catch (error) {
    return false;
  }
}

function allowWebSocketConnection(info) {
  const origin = info.origin || (info.req && info.req.headers && info.req.headers.origin);
  if (!origin) {
    return true;
  }

  if (WS_ALLOW_ANY) {
    return true;
  }

  if (WS_ALLOWED_ORIGINS.size > 0 && WS_ALLOWED_ORIGINS.has(origin.toLowerCase())) {
    return true;
  }

  if (WS_ALLOW_SAME_HOST && info.req && isSameHostOrigin(origin, info.req.headers)) {
    return true;
  }

  return false;
}
