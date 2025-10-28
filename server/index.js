const http = require('http');
const fs = require('fs');
const path = require('path');
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

const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.resolve(__dirname, '..');
const STATIC_DIRS = new Set(['styles', 'scripts', 'assets']);

ensureDefaultRooms();
setInterval(() => pruneRooms(), 60 * 1000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/rooms') {
    const rooms = listRooms();
    res.writeHead(200, { 'Content-Type': 'application/json' });
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
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch (error) {
      console.error('Failed to create room', error);
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Не удалось создать комнату');
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
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
  logIssue('HTTP server error', error);
});

wss.on('error', (error) => {
  logIssue('WebSocket server error', error);
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

function logIssue(context, error) {
  const stamp = new Date().toISOString();
  if (error instanceof Error) {
    console.error(`[${stamp}] ${context}:`, error.stack || error.message);
  } else {
    console.error(`[${stamp}] ${context}:`, error);
  }
}

process.on('uncaughtException', (error) => {
  logIssue('Uncaught exception', error);
});

process.on('unhandledRejection', (reason) => {
  logIssue('Unhandled rejection', reason);
});

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
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(content);
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
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
