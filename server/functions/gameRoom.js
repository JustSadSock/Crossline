const crypto = require('crypto');
const WebSocket = require('ws');
const {
  GAME_WIDTH,
  GAME_HEIGHT,
  PLAYER_RADIUS,
  BULLET_RADIUS,
  BULLET_SPEED,
  DAMAGE_PER_HIT,
} = require('./constants');

const TICK_RATE = 30;

class GameRoom {
  constructor({ id, name, maxPlayers = 8, persistent = false }) {
    this.id = id;
    this.name = name;
    this.maxPlayers = maxPlayers;
    this.persistent = persistent;
    this.players = {};
    this.clients = new Map();
    this.bullets = [];
    this.nextBulletId = 0;
    this.lastActivity = Date.now();
    this.interval = setInterval(() => this.step(), 1000 / TICK_RATE);
  }

  destroy() {
    clearInterval(this.interval);
    this.clients.forEach((ws) => {
      try {
        ws.close(1001, 'room-closed');
      } catch (error) {
        // ignore
      }
    });
    this.clients.clear();
    this.players = {};
    this.bullets = [];
  }

  isFull() {
    return this.clients.size >= this.maxPlayers;
  }

  isEmpty() {
    return this.clients.size === 0;
  }

  getLobbyInfo() {
    return {
      id: this.id,
      name: this.name,
      players: this.clients.size,
      maxPlayers: this.maxPlayers,
      status: this.clients.size > 0 ? 'live' : 'idle',
      persistent: this.persistent,
    };
  }

  generatePlayerId() {
    return crypto.randomBytes(4).toString('hex');
  }

  attachClient(ws, playerName) {
    if (this.isFull()) {
      throw new Error('Room is full');
    }
    const playerId = this.generatePlayerId();
    const spawn = this.randomSpawn();
    this.players[playerId] = {
      id: playerId,
      name: playerName || `Pilot-${playerId.slice(0, 4)}`,
      x: spawn.x,
      y: spawn.y,
      angle: 0,
      health: 100,
      alive: true,
      score: 0,
      respawnTimer: null,
    };
    this.clients.set(playerId, ws);
    this.lastActivity = Date.now();
    this.send(ws, {
      type: 'init',
      playerId,
      room: this.getLobbyInfo(),
      constants: { width: GAME_WIDTH, height: GAME_HEIGHT },
    });
    return playerId;
  }

  detachClient(playerId) {
    this.clients.delete(playerId);
    delete this.players[playerId];
    this.lastActivity = Date.now();
  }

  handleMessage(playerId, rawMessage) {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch (error) {
      return;
    }

    const player = this.players[playerId];
    if (!player) return;

    if (message.type === 'move' && player.alive) {
      const { x, y, angle } = message;
      player.x = clamp(x, PLAYER_RADIUS, GAME_WIDTH - PLAYER_RADIUS);
      player.y = clamp(y, PLAYER_RADIUS, GAME_HEIGHT - PLAYER_RADIUS);
      player.angle = typeof angle === 'number' ? angle : player.angle;
      this.lastActivity = Date.now();
    } else if (message.type === 'shoot' && player.alive) {
      this.spawnBullet(playerId);
      this.lastActivity = Date.now();
    } else if (message.type === 'respawn' && !player.alive) {
      this.respawnPlayer(playerId);
    }
  }

  spawnBullet(playerId) {
    const player = this.players[playerId];
    if (!player) return;
    this.bullets.push({
      id: this.nextBulletId++,
      x: player.x,
      y: player.y,
      angle: player.angle,
      owner: playerId,
    });
  }

  respawnPlayer(playerId) {
    const player = this.players[playerId];
    if (!player) return;
    const spawn = this.randomSpawn();
    player.x = spawn.x;
    player.y = spawn.y;
    player.health = 100;
    player.alive = true;
    player.respawnTimer = null;
    this.lastActivity = Date.now();
  }

  step() {
    const now = Date.now();
    this.bullets = this.bullets.filter((bullet) => {
      bullet.x += Math.cos(bullet.angle) * BULLET_SPEED;
      bullet.y += Math.sin(bullet.angle) * BULLET_SPEED;
      if (bullet.x < 0 || bullet.x > GAME_WIDTH || bullet.y < 0 || bullet.y > GAME_HEIGHT) {
        return false;
      }
      for (const playerId in this.players) {
        const player = this.players[playerId];
        if (!player.alive || playerId === bullet.owner) continue;
        const distance = Math.hypot(player.x - bullet.x, player.y - bullet.y);
        if (distance < PLAYER_RADIUS + BULLET_RADIUS) {
          player.health -= DAMAGE_PER_HIT;
          if (player.health <= 0) {
            player.health = 0;
            player.alive = false;
            player.respawnTimer = now + 60000; // manual respawn window
            const shooter = this.players[bullet.owner];
            if (shooter) {
              shooter.score = (shooter.score || 0) + 1;
            }
          }
          return false;
        }
      }
      return true;
    });

    this.broadcastState();
  }

  broadcastState() {
    const payload = JSON.stringify({
      type: 'gameState',
      players: this.players,
      bullets: this.bullets,
    });
    this.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    });
  }

  randomSpawn() {
    return {
      x: Math.random() * (GAME_WIDTH - PLAYER_RADIUS * 4) + PLAYER_RADIUS * 2,
      y: Math.random() * (GAME_HEIGHT - PLAYER_RADIUS * 4) + PLAYER_RADIUS * 2,
    };
  }

  send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = GameRoom;
