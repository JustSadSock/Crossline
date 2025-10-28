const http = require('http');
const fs = require('fs');
const path = require('path');
const cluster = require('cluster');
const os = require('os');
const { promisify } = require('util');
const WebSocket = require('ws');
const {
  createRoom,
  getRoom,
  listRooms,
  pruneRooms,
  ensureDefaultRooms,
} = require('./functions/roomManager');

const readFile = promisify(fs.readFile);
const access = promisify(fs.access);

const ROOT_DIR = path.resolve(__dirname, '..');
const STATIC_DIRS = new Set(['styles', 'scripts', 'assets']);

bootstrap();

function bootstrap() {
  const clusterEnabled = shouldUseCluster();
  if (clusterEnabled && cluster.isPrimary) {
    const workerCount = resolveWorkerCount();
    console.log(`[CLUSTER] Primary ${process.pid} launching ${workerCount} workers`);
    for (let index = 0; index < workerCount; index += 1) {
      cluster.fork();
    }

    cluster.on('online', (worker) => {
      console.log(`[CLUSTER] Worker ${worker.process.pid} is online`);
    });

    cluster.on('exit', (worker, code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      console.warn(`[CLUSTER] Worker ${worker.process.pid} exited (${reason})`);
      if (code !== 0 && !signal) {
        console.warn('[CLUSTER] Restarting worker...');
        cluster.fork();
      }
    });
    return;
  }

  if (!clusterEnabled && cluster.isPrimary) {
    console.log('[CLUSTER] Running in single-process mode');
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
    console.log(`[CLUSTER] Worker ${process.pid} starting game server`);
  }

  ensureDefaultRooms();
  setInterval(() => pruneRooms(), 60 * 1000);

  const server = http.createServer(async (req, res) => {
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
        console.error('Failed to create room', error);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.writeHead(400);
        res.end('Не удалось создать комнату');
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    serveStatic(url.pathname, res);
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const roomId = url.searchParams.get('room');
    const playerName = sanitizeName(url.searchParams.get('name') || '');

    if (!roomId) {
      sendAndClose(ws, { type: 'error', message: 'Комната не указана' }, 1008);
      return;
    }

    const room = getRoom(roomId);
    if (!room) {
      sendAndClose(ws, { type: 'error', message: 'Комната не найдена' }, 1008);
      return;
    }

    if (room.isFull()) {
      sendAndClose(ws, { type: 'error', message: 'Комната заполнена' }, 1008);
      return;
    }

    let playerId;
    try {
      playerId = room.attachClient(ws, playerName);
    } catch (error) {
      console.error('Attach client error', error);
      sendAndClose(ws, { type: 'error', message: 'Не удалось присоединиться' }, 1011);
      return;
    }

    ws.on('message', (data) => {
      room.handleMessage(playerId, data);
    });

    ws.on('close', () => {
      room.detachClient(playerId);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error', error);
      room.detachClient(playerId);
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
      console.warn(
        `[BOOT] Port ${previousPort === 0 ? 'auto' : previousPort} unavailable (${error.code}). Retrying on ${nextLabel}...`,
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
      console.error('[BOOT] No available ports to bind. Exiting.');
      process.exit(1);
    }
    const label = nextPort === 0 ? 'auto (random open port)' : nextPort;
    console.log(`[BOOT] Attempting to listen on port ${label}...`);
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
      console.log(`[BOOT] Requested port ${requestedPort} unavailable. Using fallback port ${port}.`);
    }
    console.log(`Server running on http://localhost:${port}`);
  });

  process.on('uncaughtException', (error) => {
    logIssue('Uncaught exception', error);
  });

  process.on('unhandledRejection', (reason) => {
    logIssue('Unhandled rejection', reason);
  });
}

function logIssue(context, error) {
  const stamp = new Date().toISOString();
  if (error instanceof Error) {
    console.error(`[${stamp}] ${context}:`, error.stack || error.message);
  } else {
    console.error(`[${stamp}] ${context}:`, error);
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
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', (error) => reject(error));
  });
}

function sanitizeName(value) {
  return (value || '')
    .toString()
    .replace(/[^a-zA-Z0-9а-яА-Я_\-\s]/g, '')
    .trim()
    .slice(0, 20);
}

function sendAndClose(ws, payload, code = 1000) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
    ws.close(code);
  } catch (error) {
    // ignore
  }
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

function isBindError(error) {
  return (
    error instanceof Error &&
    (error.code === 'EADDRINUSE' || error.code === 'EACCES' || error.code === 'EADDRNOTAVAIL')
  );
}

function applyCors(req, res) {
  const rawOrigin = process.env.CROSSLINE_CORS_ORIGIN || '*';
  const allowedOrigins = rawOrigin
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      if (value === '*') {
        return '*';
      }
      return value.replace(/\/+$/, '');
    })
    .filter(Boolean);
  const allowAll = allowedOrigins.length === 0 || allowedOrigins.includes('*');

  if (!allowAll) {
    appendVaryHeader(res, 'Origin');
    const requestOrigin = req.headers.origin;
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    } else if (requestOrigin) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(403);
        res.end('Недопустимый источник CORS');
      }
      return true;
    } else {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0]);
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
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

function shouldUseCluster() {
  if (process.env.CROSSLINE_CLUSTER === '0' || process.env.CROSSLINE_CLUSTER === 'false') {
    return false;
  }
  const workers = resolveWorkerCount();
  return workers > 1;
}

function resolveWorkerCount() {
  const overrides = [process.env.CROSSLINE_CLUSTER_WORKERS, process.env.WEB_CONCURRENCY];
  for (const value of overrides) {
    const parsed = parseWorkerCount(value);
    if (parsed > 0) {
      return parsed;
    }
  }
  const cpuInfo = os.cpus();
  if (Array.isArray(cpuInfo) && cpuInfo.length > 0) {
    return cpuInfo.length;
  }
  return 1;
}

function parseWorkerCount(value) {
  if (typeof value === 'undefined' || value === null || value === '') {
    return 0;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return 0;
}
