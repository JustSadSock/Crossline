const fs = require('fs');
const path = require('path');
const cluster = require('cluster');
const os = require('os');
const { promisify } = require('util');
const uWS = loadUWebSockets();
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
const STATUS_TEXT = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
};

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

function loadUWebSockets() {
  try {
    return require('uWebSockets.js');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      const message = [
        "[BOOT] The optional dependency 'uWebSockets.js' is missing.",
        '[BOOT] Install project dependencies before starting the server.',
        '[BOOT] Run "npm ci" (or "npm install") from the repository root,',
        '       or use launch-crossline.bat / scripts/launch-crossline.ps1 on Windows.',
      ].join('\n');
      console.error(message);
      process.exitCode = 1;
      process.exit();
    }
    throw error;
  }
}

function startServer() {
  const DEFAULT_PORT = 3000;
  const requestedPort = parsePort(process.env.PORT, DEFAULT_PORT);
  const candidatePorts = buildPortList(requestedPort, DEFAULT_PORT);
  let requestedPortFailed = false;
  let listenSocket = null;

  if (cluster.isWorker) {
    console.log(`[CLUSTER] Worker ${process.pid} starting game server`);
  }

  ensureDefaultRooms();
  setInterval(() => pruneRooms(), 60 * 1000);

  const app = uWS.App();

  app.ws('/*', {
    compression: uWS.DEDICATED_COMPRESSOR_256KB,
    idleTimeout: 60,
    maxBackpressure: 64 * 1024,
    upgrade: (res, req, context) => {
      const url = req.getUrl();
      if (url !== '/' && url !== '') {
        res.writeStatus('404 Not Found').end();
        return;
      }
      const params = new URLSearchParams(req.getQuery() || '');
      const roomId = params.get('room');
      const playerName = sanitizeName(params.get('name') || '');
      res.upgrade(
        {
          roomId,
          playerName,
        },
        req.getHeader('sec-websocket-key'),
        req.getHeader('sec-websocket-protocol'),
        req.getHeader('sec-websocket-extensions'),
        context,
      );
    },
    open: (ws) => {
      ws.isClosed = false;
      const roomId = ws.roomId;
      const playerName = ws.playerName;

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

      try {
        const playerId = room.attachClient(ws, playerName);
        ws.playerId = playerId;
        ws.room = room;
      } catch (error) {
        console.error('Attach client error', error);
        sendAndClose(ws, { type: 'error', message: 'Не удалось присоединиться' }, 1011);
      }
    },
    message: (ws, message, isBinary) => {
      if (ws.isClosed || !ws.room || !ws.playerId) {
        return;
      }
      if (isBinary) {
        return;
      }
      const text = Buffer.from(message).toString('utf8');
      ws.room.handleMessage(ws.playerId, text);
    },
    close: (ws) => {
      ws.isClosed = true;
      if (ws.room && ws.playerId) {
        ws.room.detachClient(ws.playerId);
      }
    },
    drain: (ws) => {
      ws.isDraining = false;
    },
  });

  app.options('/*', (res, req) => {
    if (!applyCors(res, req)) {
      res.writeStatus(`${204} ${STATUS_TEXT[204]}`);
      res.end();
    }
  });

  app.get('/rooms', (res, req) => {
    if (applyCors(res, req)) return;
    const abortState = createAbortedState(res);
    if (abortState.aborted) return;
    try {
      const rooms = listRooms();
      res.writeHeader('Content-Type', 'application/json; charset=utf-8');
      res.writeStatus(`${200} ${STATUS_TEXT[200]}`);
      res.end(JSON.stringify(rooms));
    } catch (error) {
      if (abortState.aborted) return;
      logIssue('Failed to list rooms', error);
      res.writeHeader('Content-Type', 'text/plain; charset=utf-8');
      res.writeStatus(`${500} ${STATUS_TEXT[500]}`);
      res.end('Ошибка сервера');
    }
  });

  app.post('/rooms', (res, req) => {
    if (applyCors(res, req)) return;
    const abortState = createAbortedState(res);
    readRequestBody(res, abortState)
      .then((body) => {
        if (abortState.aborted) return;
        try {
          const payload = JSON.parse(body || '{}');
          const name = typeof payload.name === 'string' ? payload.name : '';
          const room = createRoom({ name: sanitizeName(name).slice(0, 24) });
          const info = room.getLobbyInfo();
          res.writeHeader('Content-Type', 'application/json; charset=utf-8');
          res.writeStatus(`${201} ${STATUS_TEXT[201]}`);
          res.end(JSON.stringify(info));
        } catch (error) {
          if (abortState.aborted) return;
          logIssue('Failed to create room', error);
          res.writeHeader('Content-Type', 'text/plain; charset=utf-8');
          res.writeStatus(`${400} ${STATUS_TEXT[400]}`);
          res.end('Не удалось создать комнату');
        }
      })
      .catch((error) => {
        if (abortState.aborted) return;
        logIssue('Failed to read request body', error);
        res.writeHeader('Content-Type', 'text/plain; charset=utf-8');
        res.writeStatus(`${400} ${STATUS_TEXT[400]}`);
        res.end('Некорректный запрос');
      });
  });

  app.get('/health', (res, req) => {
    if (applyCors(res, req)) return;
    const abortState = createAbortedState(res);
    if (abortState.aborted) return;
    res.writeHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeStatus(`${200} ${STATUS_TEXT[200]}`);
    res.end(JSON.stringify({ status: 'ok' }));
  });

  app.get('/*', (res, req) => {
    if (applyCors(res, req)) return;
    const abortState = createAbortedState(res);
    serveStatic(req.getUrl() || '/', res, abortState);
  });

  const attemptListen = () => {
    const nextPort = candidatePorts.shift();
    if (typeof nextPort === 'undefined') {
      console.error('[BOOT] No available ports to bind. Exiting.');
      process.exit(1);
    }
    const label = nextPort === 0 ? 'auto (random open port)' : nextPort;
    console.log(`[BOOT] Attempting to listen on port ${label}...`);
    app.listen(nextPort, (token) => {
      if (token) {
        listenSocket = token;
        const actualPort = uWS.us_listen_socket_local_port(token);
        const port = actualPort || nextPort;
        process.env.PORT = String(port);
        if (requestedPort !== port && requestedPortFailed) {
          console.log(`[BOOT] Requested port ${requestedPort} unavailable. Using fallback port ${port}.`);
        }
        console.log(`Server running on http://localhost:${port}`);
      } else {
        if (nextPort === requestedPort) {
          requestedPortFailed = true;
        }
        const nextPeek = candidatePorts[0];
        const nextLabel =
          typeof nextPeek === 'undefined' ? 'n/a' : nextPeek === 0 ? 'auto (random open port)' : nextPeek;
        console.warn(`[BOOT] Port ${label} unavailable. Retrying on ${nextLabel}...`);
        setTimeout(attemptListen, 750);
      }
    });
  };

  attemptListen();

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

function createAbortedState(res) {
  const handlers = [];
  const state = {
    aborted: false,
    onAbort(handler) {
      if (typeof handler === 'function') {
        handlers.push(handler);
      }
    },
  };
  res.onAborted(() => {
    if (state.aborted) {
      return;
    }
    state.aborted = true;
    for (const handler of handlers) {
      try {
        handler();
      } catch (error) {
        // ignore handler errors
      }
    }
  });
  return state;
}

async function serveStatic(requestPath, res, abortState) {
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
    if (abortState.aborted) return;
    res.writeHeader('Content-Type', mimeType);
    res.writeStatus(`${200} ${STATUS_TEXT[200]}`);
    res.end(content);
  } catch (error) {
    if (abortState.aborted) return;
    res.writeHeader('Content-Type', 'text/plain; charset=utf-8');
    res.writeStatus(`${404} ${STATUS_TEXT[404]}`);
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

function readRequestBody(res, abortState) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;

    const safeReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    abortState.onAbort(() => {
      safeReject(new Error('aborted'));
    });

    res.onData((chunk, isLast) => {
      if (settled || abortState.aborted) {
        safeReject(new Error('aborted'));
        return;
      }
      const current = Buffer.from(chunk);
      if (buffer.length + current.length > 1e6) {
        abortState.aborted = true;
        safeReject(new Error('Body too large'));
        return;
      }
      buffer = Buffer.concat([buffer, current]);
      if (isLast) {
        settled = true;
        resolve(buffer.toString('utf8'));
      }
    });
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
  if (!ws || ws.isClosed) {
    return;
  }
  if (typeof ws.send === 'function') {
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      // ignore send errors
    }
  }
  if (typeof ws.end === 'function') {
    try {
      ws.end(code);
    } catch (error) {
      // ignore close errors
    }
  }
  ws.isClosed = true;
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

function applyCors(res, req) {
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
    res.writeHeader('Vary', 'Origin');
    const requestOrigin = req.getHeader('origin');
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      res.writeHeader('Access-Control-Allow-Origin', requestOrigin);
    } else if (requestOrigin) {
      if (req.getMethod() === 'OPTIONS') {
        res.writeStatus(`${204} ${STATUS_TEXT[204]}`);
        res.end();
      } else {
        res.writeStatus(`${403} ${STATUS_TEXT[403]}`);
        res.end('Недопустимый источник CORS');
      }
      return true;
    } else {
      res.writeHeader('Access-Control-Allow-Origin', allowedOrigins[0]);
    }
  } else {
    res.writeHeader('Access-Control-Allow-Origin', '*');
  }

  res.writeHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.writeHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.writeHeader('Access-Control-Allow-Credentials', 'false');

  if (req.getMethod() === 'OPTIONS') {
    res.writeStatus(`${204} ${STATUS_TEXT[204]}`);
    res.end();
    return true;
  }

  return false;
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
