const crypto = require('crypto');
const WebSocket = require('ws');
const {
  GAME_WIDTH,
  GAME_HEIGHT,
  PLAYER_RADIUS,
  BULLET_RADIUS,
  BULLET_SPEED,
  DAMAGE_PER_HIT,
  SHIELD_MAX_CHARGE,
  SHIELD_RECHARGE_FACTOR,
  SHIELD_ARC,
  SHIELD_RADIUS,
  SHIELD_REFLECTION_DRAIN,
  DASH_MAX_CHARGES,
  DASH_RECHARGE_MS,
  DASH_DISTANCE,
  WEAPON_HEAT_PER_SHOT,
  WEAPON_HEAT_COOLDOWN_RATE,
  WEAPON_OVERHEAT_PENALTY_MS,
  WEAPON_HEAT_SAFE_RATIO,
  WEAPON_MIN_SHOT_INTERVAL,
} = require('./constants');

const TICK_RATE = 30;
const MOVE_THROTTLE_MS = 16;
const STEP_DELTA = 1000 / TICK_RATE;
const MIN_SHOT_INTERVAL = WEAPON_MIN_SHOT_INTERVAL;

function decayWeaponHeat(player) {
  if (!player) return;
  const heat = typeof player.weaponHeat === 'number' ? player.weaponHeat : 0;
  player.weaponHeat = Math.max(0, heat - STEP_DELTA * WEAPON_HEAT_COOLDOWN_RATE);
}

function recoverWeaponHeat(player, now) {
  if (!player || !player.weaponOverheated) return;
  if (player.weaponHeat <= WEAPON_HEAT_SAFE_RATIO && now >= (player.weaponRecoveredAt || 0)) {
    player.weaponOverheated = false;
  }
}

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
      shieldCharge: SHIELD_MAX_CHARGE,
      shieldActive: false,
      shieldRequested: false,
      dashCharge: DASH_MAX_CHARGES,
      lastMoveDirection: { x: 1, y: 0 },
      lastMoveMessageAt: 0,
      weaponHeat: 0,
      weaponOverheated: false,
      weaponRecoveredAt: 0,
      lastShotAt: 0,
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

    const now = Date.now();

    if (message.type === 'move' && player.alive) {
      if (player.lastMoveMessageAt && now - player.lastMoveMessageAt < MOVE_THROTTLE_MS) {
        return;
      }
      const { x, y, angle } = message;
      const clampedX = clamp(x, PLAYER_RADIUS, GAME_WIDTH - PLAYER_RADIUS);
      const clampedY = clamp(y, PLAYER_RADIUS, GAME_HEIGHT - PLAYER_RADIUS);
      const deltaX = clampedX - player.x;
      const deltaY = clampedY - player.y;
      if (deltaX || deltaY) {
        const length = Math.hypot(deltaX, deltaY) || 1;
        player.lastMoveDirection = { x: deltaX / length, y: deltaY / length };
      }
      player.x = clampedX;
      player.y = clampedY;
      if (typeof angle === 'number' && Number.isFinite(angle)) {
        player.angle = angle;
      }
      player.lastMoveMessageAt = now;
      this.lastActivity = now;
    } else if (message.type === 'shoot' && player.alive) {
      if (player.shieldActive || player.shieldRequested) {
        return;
      }
      if (player.weaponOverheated) {
        return;
      }
      if (now - (player.lastShotAt || 0) < MIN_SHOT_INTERVAL) {
        return;
      }
      if (player.weaponHeat >= 1) {
        player.weaponOverheated = true;
        player.weaponRecoveredAt = now + WEAPON_OVERHEAT_PENALTY_MS;
        return;
      }
      this.spawnBullet(playerId);
      player.lastShotAt = now;
      player.weaponHeat = Math.min(1, (player.weaponHeat || 0) + WEAPON_HEAT_PER_SHOT);
      if (player.weaponHeat >= 1) {
        player.weaponOverheated = true;
        player.weaponRecoveredAt = now + WEAPON_OVERHEAT_PENALTY_MS;
      }
      this.lastActivity = now;
    } else if (message.type === 'respawn' && !player.alive) {
      this.respawnPlayer(playerId);
    } else if (message.type === 'shield') {
      player.shieldRequested = !!message.active && player.alive;
      if (!player.shieldRequested) {
        player.shieldActive = false;
      }
      this.lastActivity = now;
    } else if (message.type === 'dash' && player.alive) {
      if (player.dashCharge >= 1) {
        const dirX = typeof message.dirX === 'number' ? message.dirX : 0;
        const dirY = typeof message.dirY === 'number' ? message.dirY : 0;
        let baseX = dirX;
        let baseY = dirY;
        if (!baseX && !baseY) {
          baseX = player.lastMoveDirection.x || Math.cos(player.angle);
          baseY = player.lastMoveDirection.y || Math.sin(player.angle);
        }
        const length = Math.hypot(baseX, baseY) || 1;
        const normX = baseX / length;
        const normY = baseY / length;
        player.x = clamp(player.x + normX * DASH_DISTANCE, PLAYER_RADIUS, GAME_WIDTH - PLAYER_RADIUS);
        player.y = clamp(player.y + normY * DASH_DISTANCE, PLAYER_RADIUS, GAME_HEIGHT - PLAYER_RADIUS);
        player.dashCharge = Math.max(0, player.dashCharge - 1);
        player.lastMoveDirection = { x: normX, y: normY };
      }
      this.lastActivity = now;
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
    player.shieldCharge = SHIELD_MAX_CHARGE;
    player.shieldActive = false;
    player.shieldRequested = false;
    player.dashCharge = DASH_MAX_CHARGES;
    player.lastMoveDirection = { x: 1, y: 0 };
    player.weaponHeat = 0;
    player.weaponOverheated = false;
    player.weaponRecoveredAt = 0;
    player.lastShotAt = Date.now() - MIN_SHOT_INTERVAL;
    this.lastActivity = Date.now();
  }

  step() {
    if (this.clients.size === 0) {
      return;
    }

    const now = Date.now();

    Object.values(this.players).forEach((player) => {
      decayWeaponHeat(player);
      recoverWeaponHeat(player, now);
      if (!player.alive) {
        player.shieldActive = false;
        player.shieldRequested = false;
        player.dashCharge = Math.min(DASH_MAX_CHARGES, player.dashCharge + STEP_DELTA / DASH_RECHARGE_MS);
        return;
      }
      if (player.shieldRequested && player.shieldCharge > 0) {
        player.shieldActive = true;
        player.shieldCharge = Math.max(0, player.shieldCharge - STEP_DELTA);
        if (player.shieldCharge <= 0) {
          player.shieldActive = false;
        }
      } else {
        player.shieldActive = false;
        player.shieldCharge = Math.min(
          SHIELD_MAX_CHARGE,
          player.shieldCharge + STEP_DELTA * SHIELD_RECHARGE_FACTOR,
        );
      }
      player.dashCharge = Math.min(
        DASH_MAX_CHARGES,
        player.dashCharge + STEP_DELTA / DASH_RECHARGE_MS,
      );
    });

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
        if (
          player.shieldActive &&
          player.shieldCharge > 0 &&
          distance < SHIELD_RADIUS &&
          bullet.owner !== playerId
        ) {
          const toBulletAngle = Math.atan2(bullet.y - player.y, bullet.x - player.x);
          const angleDiff = Math.abs(normalizeAngle(player.angle - toBulletAngle));
          if (angleDiff <= SHIELD_ARC / 2) {
            bullet.owner = playerId;
            bullet.angle = player.angle;
            const offset = SHIELD_RADIUS + 6;
            bullet.x = player.x + Math.cos(player.angle) * offset;
            bullet.y = player.y + Math.sin(player.angle) * offset;
            const drain = SHIELD_MAX_CHARGE * SHIELD_REFLECTION_DRAIN;
            player.shieldCharge = Math.max(0, player.shieldCharge - drain);
            if (player.shieldCharge <= 0) {
              player.shieldActive = false;
              player.shieldRequested = false;
            }
            return true;
          }
        }
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
    const players = {};
    Object.entries(this.players).forEach(([id, player]) => {
      players[id] = {
        id: player.id,
        name: player.name,
        x: player.x,
        y: player.y,
        angle: player.angle,
        health: player.health,
        alive: player.alive,
        score: player.score || 0,
        shieldCharge: player.shieldCharge,
        shieldActive: player.shieldActive,
        dashCharge: player.dashCharge,
      };
    });
    const bullets = this.bullets.map((bullet) => ({
      id: bullet.id,
      x: bullet.x,
      y: bullet.y,
      angle: bullet.angle,
      owner: bullet.owner,
    }));
    const payload = JSON.stringify({
      type: 'gameState',
      players,
      bullets,
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

function normalizeAngle(angle) {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

module.exports = GameRoom;
