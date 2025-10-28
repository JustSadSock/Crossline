const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer((req, res) => {
  let filePath = '.' + req.url;
  if (filePath === './') {
    filePath = './public/index.html';
  } else if (req.url.startsWith('/js/')) {
    filePath = './public' + req.url;
  } else if (req.url.startsWith('/css/')) {
    filePath = './public' + req.url;
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
  };

  const contentType = mimeTypes[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404);
        res.end('404 - File Not Found');
      } else {
        res.writeHead(500);
        res.end('500 - Internal Server Error: ' + error.code);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Game state
const gameState = {
  players: {},
  bullets: [],
  nextBulletId: 0
};

const GAME_WIDTH = 800;
const GAME_HEIGHT = 600;
const PLAYER_SIZE = 30;
const BULLET_SIZE = 5;
const BULLET_SPEED = 10;

// Game loop - update bullets and check collisions
setInterval(() => {
  // Update bullets
  gameState.bullets = gameState.bullets.filter(bullet => {
    bullet.x += Math.cos(bullet.angle) * BULLET_SPEED;
    bullet.y += Math.sin(bullet.angle) * BULLET_SPEED;
    
    // Remove bullets that are out of bounds
    if (bullet.x < 0 || bullet.x > GAME_WIDTH || bullet.y < 0 || bullet.y > GAME_HEIGHT) {
      return false;
    }
    
    // Check collision with players
    for (const playerId in gameState.players) {
      if (playerId === bullet.playerId) continue;
      
      const player = gameState.players[playerId];
      const dx = player.x - bullet.x;
      const dy = player.y - bullet.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance < PLAYER_SIZE / 2 + BULLET_SIZE) {
        // Hit detected
        player.health -= 20;
        if (player.health <= 0) {
          player.health = 0;
          player.alive = false;
        }
        return false; // Remove bullet
      }
    }
    
    return true;
  });
  
  // Broadcast game state to all clients
  broadcastGameState();
}, 1000 / 30); // 30 FPS

function broadcastGameState() {
  const state = JSON.stringify({
    type: 'gameState',
    players: gameState.players,
    bullets: gameState.bullets
  });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(state);
    }
  });
}

wss.on('connection', (ws) => {
  const playerId = generateId();
  console.log(`Player ${playerId} connected`);
  
  // Initialize player
  gameState.players[playerId] = {
    id: playerId,
    x: Math.random() * (GAME_WIDTH - PLAYER_SIZE) + PLAYER_SIZE / 2,
    y: Math.random() * (GAME_HEIGHT - PLAYER_SIZE) + PLAYER_SIZE / 2,
    angle: 0,
    health: 100,
    alive: true,
    score: 0
  };
  
  // Send player ID
  ws.send(JSON.stringify({
    type: 'init',
    playerId: playerId
  }));
  
  // Handle messages from client
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'move') {
        const player = gameState.players[playerId];
        if (player && player.alive) {
          player.x = Math.max(PLAYER_SIZE / 2, Math.min(GAME_WIDTH - PLAYER_SIZE / 2, data.x));
          player.y = Math.max(PLAYER_SIZE / 2, Math.min(GAME_HEIGHT - PLAYER_SIZE / 2, data.y));
          player.angle = data.angle;
        }
      } else if (data.type === 'shoot') {
        const player = gameState.players[playerId];
        if (player && player.alive) {
          gameState.bullets.push({
            id: gameState.nextBulletId++,
            x: player.x,
            y: player.y,
            angle: player.angle,
            playerId: playerId
          });
        }
      } else if (data.type === 'respawn') {
        const player = gameState.players[playerId];
        if (player && !player.alive) {
          player.x = Math.random() * (GAME_WIDTH - PLAYER_SIZE) + PLAYER_SIZE / 2;
          player.y = Math.random() * (GAME_HEIGHT - PLAYER_SIZE) + PLAYER_SIZE / 2;
          player.health = 100;
          player.alive = true;
        }
      }
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  });
  
  // Handle disconnect
  ws.on('close', () => {
    console.log(`Player ${playerId} disconnected`);
    delete gameState.players[playerId];
  });
});

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
