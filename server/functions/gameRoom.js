const crypto = require('crypto');
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
const { createObjectPool } = require('./objectPool');

const TICK_RATE = 30;
const MOVE_THROTTLE_MS = 16;
const STEP_DELTA = 1000 / TICK_RATE;
const LOW_PRIORITY_BROADCAST_INTERVAL_MS = 50;
const HIGH_PRIORITY_BROADCAST_DELAY_MS = 0;
const MIN_SHOT_INTERVAL = WEAPON_MIN_SHOT_INTERVAL;
const BULLET_LIFETIME_MS_ESTIMATE =
  (Math.sqrt(GAME_WIDTH * GAME_WIDTH + GAME_HEIGHT * GAME_HEIGHT) / BULLET_SPEED) *
  (1000 / TICK_RATE);
const BULLETS_PER_PLAYER_ESTIMATE = Math.max(
  8,
  Math.ceil((BULLET_LIFETIME_MS_ESTIMATE / MIN_SHOT_INTERVAL) * 1.2),
);

const PLAYER_FIELD_FLAGS = {
  POSITION: 1 << 0,
  ANGLE: 1 << 1,
  HEALTH: 1 << 2,
  SCORE: 1 << 3,
  SHIELD: 1 << 4,
  DASH: 1 << 5,
  STATUS: 1 << 6,
  NAME: 1 << 7,
};

const PLAYER_FIELD_ALL =
  PLAYER_FIELD_FLAGS.POSITION |
  PLAYER_FIELD_FLAGS.ANGLE |
  PLAYER_FIELD_FLAGS.HEALTH |
  PLAYER_FIELD_FLAGS.SCORE |
  PLAYER_FIELD_FLAGS.SHIELD |
  PLAYER_FIELD_FLAGS.DASH |
  PLAYER_FIELD_FLAGS.STATUS |
  PLAYER_FIELD_FLAGS.NAME;

const HIGH_PRIORITY_PLAYER_MASK =
  PLAYER_FIELD_FLAGS.HEALTH |
  PLAYER_FIELD_FLAGS.SCORE |
  PLAYER_FIELD_FLAGS.STATUS |
  PLAYER_FIELD_FLAGS.NAME;

const BULLET_FIELD_FLAGS = {
  POSITION: 1 << 0,
  ANGLE: 1 << 1,
  OWNER: 1 << 2,
};

const BULLET_FIELD_ALL =
  BULLET_FIELD_FLAGS.POSITION | BULLET_FIELD_FLAGS.ANGLE | BULLET_FIELD_FLAGS.OWNER;

const HIGH_PRIORITY_BULLET_MASK = BULLET_FIELD_FLAGS.OWNER;

const SERVER_MESSAGE_TYPES = {
  STATE_UPDATE: 1,
  INIT: 2,
  ERROR: 3,
};

const CLIENT_MESSAGE_TYPES = {
  MOVE: 1,
  SHOOT: 2,
  SHIELD: 3,
  DASH: 4,
  RESPAWN: 5,
};

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
    this.players = [];
    this.playerIndexById = new Map();
    this.freePlayerSlots = [];
    this.dirtyPlayerQueue = [];
    this.removedPlayerQueue = [];
    this.playerPool = createObjectPool(createPlayerTemplate, resetPlayerTemplate, {
      initialSize: this.maxPlayers,
    });
    this.clients = new Map();
    this.bullets = [];
    this.freeBulletSlots = [];
    this.dirtyBulletQueue = [];
    this.removedBulletQueue = [];
    const bulletPrefill = Math.max(
      BULLETS_PER_PLAYER_ESTIMATE,
      this.maxPlayers * BULLETS_PER_PLAYER_ESTIMATE,
    );
    this.bulletPool = createObjectPool(createBulletTemplate, resetBulletTemplate, {
      initialSize: bulletPrefill,
    });
    this.nextBulletId = 0;
    this.lastActivity = Date.now();
    this.interval = setInterval(() => this.step(), 1000 / TICK_RATE);
    this.broadcastTimer = null;
    this.broadcastScheduled = false;
    this.lastBroadcastAt = 0;
  }

  destroy() {
    clearInterval(this.interval);
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.clients.forEach((ws) => {
      try {
        if (ws && typeof ws.end === 'function') {
          ws.end(1001, 'room-closed');
        }
      } catch (error) {
        // ignore
      }
    });
    this.clients.clear();
    this.players = [];
    this.playerIndexById.clear();
    this.freePlayerSlots.length = 0;
    this.dirtyPlayerQueue.length = 0;
    this.removedPlayerQueue.length = 0;
    this.bullets = [];
    this.freeBulletSlots.length = 0;
    this.dirtyBulletQueue.length = 0;
    this.removedBulletQueue.length = 0;
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
    const player = this.acquirePlayerSlot(playerId);
    const spawn = this.randomSpawn();
    player.id = playerId;
    player.name = playerName || `Pilot-${playerId.slice(0, 4)}`;
    player.x = spawn.x;
    player.y = spawn.y;
    player.angle = 0;
    player.health = 100;
    player.alive = true;
    player.score = 0;
    player.respawnTimer = null;
    player.shieldCharge = SHIELD_MAX_CHARGE;
    player.shieldActive = false;
    player.shieldRequested = false;
    player.dashCharge = DASH_MAX_CHARGES;
    player.lastMoveDirection.x = 1;
    player.lastMoveDirection.y = 0;
    player.lastMoveMessageAt = 0;
    player.weaponHeat = 0;
    player.weaponOverheated = false;
    player.weaponRecoveredAt = 0;
    player.lastShotAt = 0;
    player.active = true;
    player.fullSync = true;
    player.dirtyQueued = false;
    this.playerIndexById.set(playerId, player.index);
    this.markPlayerDirty(player, PLAYER_FIELD_ALL, true);
    this.clients.set(playerId, ws);
    this.lastActivity = Date.now();
    const initPayload = encodeInitMessage({
      playerId,
      width: GAME_WIDTH,
      height: GAME_HEIGHT,
    });
    try {
      if (typeof ws.send === 'function') {
        ws.send(initPayload, { binary: true });
      }
    } catch (error) {
      // ignore send errors
    }
    const snapshot = this.buildFullStateUpdate();
    if (snapshot.players.length || snapshot.bullets.length) {
      try {
        if (typeof ws.send === 'function') {
          ws.send(encodeStateUpdate(snapshot), { binary: true });
        }
      } catch (error) {
        // ignore send errors
      }
    }
    return playerId;
  }

  detachClient(playerId) {
    this.clients.delete(playerId);
    const player = this.getPlayerById(playerId);
    if (player) {
      const slot = player.index;
      this.playerIndexById.delete(playerId);
      if (player.dirtyQueued) {
        player.dirtyQueued = false;
      }
      this.freePlayerSlots.push(slot);
      this.removedPlayerQueue.push(playerId);
      this.players[slot] = null;
      this.playerPool.release(player);
      this.scheduleBroadcast('high');
    }
    this.lastActivity = Date.now();
  }

  handleMessage(playerId, rawMessage) {
    if (!rawMessage) {
      return;
    }

    let buffer;
    if (Buffer.isBuffer(rawMessage)) {
      buffer = rawMessage;
    } else if (rawMessage instanceof ArrayBuffer) {
      buffer = Buffer.from(rawMessage);
    } else if (ArrayBuffer.isView(rawMessage)) {
      buffer = Buffer.from(rawMessage.buffer, rawMessage.byteOffset, rawMessage.byteLength);
    } else {
      return;
    }

    if (!buffer.length) {
      return;
    }

    const player = this.getPlayerById(playerId);
    if (!player) return;

    const type = buffer.readUInt8(0);
    const now = Date.now();

    if (type === CLIENT_MESSAGE_TYPES.MOVE) {
      if (!player.alive || buffer.length < 13) {
        return;
      }
      if (player.lastMoveMessageAt && now - player.lastMoveMessageAt < MOVE_THROTTLE_MS) {
        return;
      }
      const x = buffer.readFloatLE(1);
      const y = buffer.readFloatLE(5);
      const angle = buffer.readFloatLE(9);
      const clampedX = clamp(x, PLAYER_RADIUS, GAME_WIDTH - PLAYER_RADIUS);
      const clampedY = clamp(y, PLAYER_RADIUS, GAME_HEIGHT - PLAYER_RADIUS);
      const deltaX = clampedX - player.x;
      const deltaY = clampedY - player.y;
      if (deltaX || deltaY) {
        const length = Math.hypot(deltaX, deltaY) || 1;
        player.lastMoveDirection.x = deltaX / length;
        player.lastMoveDirection.y = deltaY / length;
      }
      let mask = 0;
      if (player.x !== clampedX) {
        player.x = clampedX;
        mask |= PLAYER_FIELD_FLAGS.POSITION;
      }
      if (player.y !== clampedY) {
        player.y = clampedY;
        mask |= PLAYER_FIELD_FLAGS.POSITION;
      }
      if (Number.isFinite(angle) && player.angle !== angle) {
        player.angle = angle;
        mask |= PLAYER_FIELD_FLAGS.ANGLE;
      }
      player.lastMoveMessageAt = now;
      if (mask) {
        this.markPlayerDirty(player, mask);
      }
      this.lastActivity = now;
    } else if (type === CLIENT_MESSAGE_TYPES.SHOOT) {
      if (!player.alive) {
        return;
      }
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
    } else if (type === CLIENT_MESSAGE_TYPES.RESPAWN) {
      if (!player.alive) {
        this.respawnPlayer(playerId);
        this.lastActivity = now;
      }
    } else if (type === CLIENT_MESSAGE_TYPES.SHIELD) {
      const requested = player.alive && buffer.length >= 2 && buffer.readUInt8(1) !== 0;
      if (player.shieldRequested !== requested) {
        player.shieldRequested = requested;
      }
      if (!player.shieldRequested && player.shieldActive) {
        player.shieldActive = false;
        this.markPlayerDirty(player, PLAYER_FIELD_FLAGS.STATUS);
      }
      this.lastActivity = now;
    } else if (type === CLIENT_MESSAGE_TYPES.DASH) {
      if (!player.alive || player.dashCharge < 1 || buffer.length < 9) {
        this.lastActivity = now;
        return;
      }
      const dirX = buffer.readFloatLE(1);
      const dirY = buffer.readFloatLE(5);
      let baseX = Number.isFinite(dirX) ? dirX : 0;
      let baseY = Number.isFinite(dirY) ? dirY : 0;
      if (!baseX && !baseY) {
        baseX = player.lastMoveDirection.x || Math.cos(player.angle);
        baseY = player.lastMoveDirection.y || Math.sin(player.angle);
      }
      const length = Math.hypot(baseX, baseY) || 1;
      const normX = baseX / length;
      const normY = baseY / length;
      const targetX = clamp(player.x + normX * DASH_DISTANCE, PLAYER_RADIUS, GAME_WIDTH - PLAYER_RADIUS);
      const targetY = clamp(player.y + normY * DASH_DISTANCE, PLAYER_RADIUS, GAME_HEIGHT - PLAYER_RADIUS);
      let mask = 0;
      if (player.x !== targetX) {
        player.x = targetX;
        mask |= PLAYER_FIELD_FLAGS.POSITION;
      }
      if (player.y !== targetY) {
        player.y = targetY;
        mask |= PLAYER_FIELD_FLAGS.POSITION;
      }
      const nextCharge = Math.max(0, player.dashCharge - 1);
      if (nextCharge !== player.dashCharge) {
        player.dashCharge = nextCharge;
        mask |= PLAYER_FIELD_FLAGS.DASH;
      }
      player.lastMoveDirection.x = normX;
      player.lastMoveDirection.y = normY;
      if (mask) {
        this.markPlayerDirty(player, mask);
      }
      this.lastActivity = now;
    }
  }

  spawnBullet(playerId) {
    const player = this.getPlayerById(playerId);
    if (!player) return;
    const slot = this.freeBulletSlots.length ? this.freeBulletSlots.pop() : this.bullets.length;
    let bullet = this.bullets[slot];
    if (!bullet) {
      bullet = this.bulletPool.acquire();
      bullet.index = slot;
      this.bullets[slot] = bullet;
    }
    if (bullet.index !== slot) {
      bullet.index = slot;
    }
    bullet.id = this.nextBulletId++;
    bullet.x = player.x;
    bullet.y = player.y;
    bullet.angle = player.angle;
    bullet.owner = playerId;
    bullet.active = true;
    bullet.fullSync = true;
    bullet.dirtyQueued = false;
    this.markBulletDirty(bullet, BULLET_FIELD_ALL, true);
  }

  respawnPlayer(playerId) {
    const player = this.getPlayerById(playerId);
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
    player.lastMoveDirection.x = 1;
    player.lastMoveDirection.y = 0;
    player.weaponHeat = 0;
    player.weaponOverheated = false;
    player.weaponRecoveredAt = 0;
    player.lastShotAt = Date.now() - MIN_SHOT_INTERVAL;
    this.markPlayerDirty(player, PLAYER_FIELD_ALL, true);
    this.lastActivity = Date.now();
  }

  step() {
    if (this.clients.size === 0) {
      return;
    }

    const now = Date.now();

    for (let i = 0; i < this.players.length; i += 1) {
      const player = this.players[i];
      if (!player || !player.active) {
        continue;
      }
      decayWeaponHeat(player);
      recoverWeaponHeat(player, now);
      if (!player.alive) {
        let mask = 0;
        if (player.shieldActive) {
          player.shieldActive = false;
          mask |= PLAYER_FIELD_FLAGS.STATUS;
        }
        if (player.shieldRequested) {
          player.shieldRequested = false;
        }
        const nextDash = Math.min(DASH_MAX_CHARGES, player.dashCharge + STEP_DELTA / DASH_RECHARGE_MS);
        if (nextDash !== player.dashCharge) {
          player.dashCharge = nextDash;
          mask |= PLAYER_FIELD_FLAGS.DASH;
        }
        if (mask) {
          this.markPlayerDirty(player, mask);
        }
        continue;
      }
      let mask = 0;
      if (player.shieldRequested && player.shieldCharge > 0) {
        if (!player.shieldActive) {
          player.shieldActive = true;
          mask |= PLAYER_FIELD_FLAGS.STATUS;
        }
        const nextCharge = Math.max(0, player.shieldCharge - STEP_DELTA);
        if (nextCharge !== player.shieldCharge) {
          player.shieldCharge = nextCharge;
          mask |= PLAYER_FIELD_FLAGS.SHIELD;
        }
        if (player.shieldCharge <= 0 && player.shieldActive) {
          player.shieldActive = false;
          player.shieldRequested = false;
          mask |= PLAYER_FIELD_FLAGS.STATUS;
        }
      } else {
        if (player.shieldActive) {
          player.shieldActive = false;
          mask |= PLAYER_FIELD_FLAGS.STATUS;
        }
        const nextCharge = Math.min(
          SHIELD_MAX_CHARGE,
          player.shieldCharge + STEP_DELTA * SHIELD_RECHARGE_FACTOR,
        );
        if (nextCharge !== player.shieldCharge) {
          player.shieldCharge = nextCharge;
          mask |= PLAYER_FIELD_FLAGS.SHIELD;
        }
      }
      const nextDash = Math.min(
        DASH_MAX_CHARGES,
        player.dashCharge + STEP_DELTA / DASH_RECHARGE_MS,
      );
      if (nextDash !== player.dashCharge) {
        player.dashCharge = nextDash;
        mask |= PLAYER_FIELD_FLAGS.DASH;
      }
      if (mask) {
        this.markPlayerDirty(player, mask);
      }
    }

    for (let i = 0; i < this.bullets.length; i += 1) {
      const bullet = this.bullets[i];
      if (!bullet || !bullet.active) {
        continue;
      }
      bullet.x += Math.cos(bullet.angle) * BULLET_SPEED;
      bullet.y += Math.sin(bullet.angle) * BULLET_SPEED;
      if (bullet.x < 0 || bullet.x > GAME_WIDTH || bullet.y < 0 || bullet.y > GAME_HEIGHT) {
        this.releaseBullet(bullet);
        continue;
      }
      let alive = true;
      for (let pIndex = 0; pIndex < this.players.length; pIndex += 1) {
        const player = this.players[pIndex];
        if (!player || !player.active || !player.alive || player.id === bullet.owner) {
          continue;
        }
        const distance = Math.hypot(player.x - bullet.x, player.y - bullet.y);
        if (
          player.shieldActive &&
          player.shieldCharge > 0 &&
          distance < SHIELD_RADIUS &&
          bullet.owner !== player.id
        ) {
          const toBulletAngle = Math.atan2(bullet.y - player.y, bullet.x - player.x);
          const angleDiff = Math.abs(normalizeAngle(player.angle - toBulletAngle));
          if (angleDiff <= SHIELD_ARC / 2) {
            bullet.owner = player.id;
            bullet.angle = player.angle;
            const offset = SHIELD_RADIUS + 6;
            bullet.x = player.x + Math.cos(player.angle) * offset;
            bullet.y = player.y + Math.sin(player.angle) * offset;
            const drain = SHIELD_MAX_CHARGE * SHIELD_REFLECTION_DRAIN;
            const nextCharge = Math.max(0, player.shieldCharge - drain);
            if (nextCharge !== player.shieldCharge) {
              player.shieldCharge = nextCharge;
              this.markPlayerDirty(player, PLAYER_FIELD_FLAGS.SHIELD);
            }
            if (player.shieldCharge <= 0) {
              if (player.shieldActive || player.shieldRequested) {
                player.shieldActive = false;
                player.shieldRequested = false;
                this.markPlayerDirty(player, PLAYER_FIELD_FLAGS.STATUS);
              }
            }
            this.markBulletDirty(
              bullet,
              BULLET_FIELD_FLAGS.POSITION | BULLET_FIELD_FLAGS.ANGLE | BULLET_FIELD_FLAGS.OWNER,
            );
            alive = true;
            break;
          }
        }
        if (distance < PLAYER_RADIUS + BULLET_RADIUS) {
          player.health -= DAMAGE_PER_HIT;
          let playerMask = PLAYER_FIELD_FLAGS.HEALTH;
          if (player.health <= 0) {
            player.health = 0;
            player.alive = false;
            player.respawnTimer = now + 60000; // manual respawn window
            const shooter = this.getPlayerById(bullet.owner);
            if (shooter) {
              shooter.score = (shooter.score || 0) + 1;
              this.markPlayerDirty(shooter, PLAYER_FIELD_FLAGS.SCORE);
            }
            playerMask |= PLAYER_FIELD_FLAGS.STATUS;
          }
          this.markPlayerDirty(player, playerMask);
          this.releaseBullet(bullet);
          alive = false;
          break;
        }
      }
      if (alive && bullet.active) {
        this.markBulletDirty(bullet, BULLET_FIELD_FLAGS.POSITION);
      }
    }

  }

  broadcastState() {
    const playersToSend = [];
    while (this.dirtyPlayerQueue.length) {
      const playerId = this.dirtyPlayerQueue.pop();
      const player = this.getPlayerById(playerId);
      if (!player || !player.active) {
        continue;
      }
      const mask = player.fullSync ? PLAYER_FIELD_ALL : player.dirtyMask || 0;
      if (!mask) {
        player.dirtyQueued = false;
        player.dirtyMask = 0;
        player.fullSync = false;
        continue;
      }
      const includeName = (mask & PLAYER_FIELD_FLAGS.NAME) !== 0;
      playersToSend.push({
        id: player.id,
        name: includeName ? player.name : undefined,
        x: mask & PLAYER_FIELD_FLAGS.POSITION ? player.x : undefined,
        y: mask & PLAYER_FIELD_FLAGS.POSITION ? player.y : undefined,
        angle: mask & PLAYER_FIELD_FLAGS.ANGLE ? player.angle : undefined,
        health: mask & PLAYER_FIELD_FLAGS.HEALTH ? player.health : undefined,
        alive: player.alive,
        score: mask & PLAYER_FIELD_FLAGS.SCORE ? player.score || 0 : undefined,
        shieldCharge: mask & PLAYER_FIELD_FLAGS.SHIELD ? player.shieldCharge : undefined,
        shieldActive: player.shieldActive,
        dashCharge: mask & PLAYER_FIELD_FLAGS.DASH ? player.dashCharge : undefined,
        fullSync: player.fullSync,
        mask,
      });
      player.fullSync = false;
      player.dirtyQueued = false;
      player.dirtyMask = 0;
    }

    const bulletsToSend = [];
    while (this.dirtyBulletQueue.length) {
      const bulletIndex = this.dirtyBulletQueue.pop();
      const bullet = this.bullets[bulletIndex];
      if (!bullet || !bullet.active) {
        continue;
      }
      const mask = bullet.fullSync ? BULLET_FIELD_ALL : bullet.dirtyMask || 0;
      if (!mask) {
        bullet.dirtyQueued = false;
        bullet.dirtyMask = 0;
        bullet.fullSync = false;
        continue;
      }
      bulletsToSend.push({
        id: bullet.id,
        x: mask & BULLET_FIELD_FLAGS.POSITION ? bullet.x : undefined,
        y: mask & BULLET_FIELD_FLAGS.POSITION ? bullet.y : undefined,
        angle: mask & BULLET_FIELD_FLAGS.ANGLE ? bullet.angle : undefined,
        owner: mask & BULLET_FIELD_FLAGS.OWNER ? bullet.owner : undefined,
        fullSync: bullet.fullSync,
        mask,
      });
      bullet.fullSync = false;
      bullet.dirtyQueued = false;
      bullet.dirtyMask = 0;
    }

    const removedPlayers = [];
    while (this.removedPlayerQueue.length) {
      removedPlayers.push(this.removedPlayerQueue.pop());
    }

    const removedBullets = [];
    while (this.removedBulletQueue.length) {
      removedBullets.push(this.removedBulletQueue.pop());
    }

    if (
      !playersToSend.length &&
      !bulletsToSend.length &&
      !removedPlayers.length &&
      !removedBullets.length
    ) {
      return false;
    }

    const payload = encodeStateUpdate({
      players: playersToSend,
      removedPlayers,
      bullets: bulletsToSend,
      removedBullets,
    });

    this.clients.forEach((ws) => {
      if (!ws || ws.isClosed || typeof ws.send !== 'function') {
        return;
      }
      try {
        ws.send(payload, { binary: true });
      } catch (error) {
        // ignore send errors
      }
    });

    return true;
  }

  randomSpawn() {
    return {
      x: Math.random() * (GAME_WIDTH - PLAYER_RADIUS * 4) + PLAYER_RADIUS * 2,
      y: Math.random() * (GAME_HEIGHT - PLAYER_RADIUS * 4) + PLAYER_RADIUS * 2,
    };
  }

  send(ws, payload) {
    if (!ws || ws.isClosed || typeof ws.send !== 'function') {
      return;
    }
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      // ignore send errors
    }
  }

  scheduleBroadcast(priority = 'low') {
    if (priority === 'high') {
      if (this.broadcastTimer) {
        clearTimeout(this.broadcastTimer);
      }
      this.broadcastScheduled = true;
      this.broadcastTimer = setTimeout(() => this.flushBroadcast(), HIGH_PRIORITY_BROADCAST_DELAY_MS);
      return;
    }

    if (this.broadcastScheduled) {
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastBroadcastAt;
    const delay =
      elapsed >= LOW_PRIORITY_BROADCAST_INTERVAL_MS
        ? 0
        : LOW_PRIORITY_BROADCAST_INTERVAL_MS - elapsed;

    this.broadcastScheduled = true;
    this.broadcastTimer = setTimeout(() => this.flushBroadcast(), delay);
  }

  flushBroadcast() {
    this.broadcastScheduled = false;
    this.broadcastTimer = null;
    const sent = this.broadcastState();
    if (sent) {
      this.lastBroadcastAt = Date.now();
    }
  }

  isHighPriorityPlayerMask(mask) {
    return (mask & HIGH_PRIORITY_PLAYER_MASK) !== 0;
  }

  isHighPriorityBulletMask(mask) {
    return (mask & HIGH_PRIORITY_BULLET_MASK) !== 0;
  }

  acquirePlayerSlot(playerId) {
    const index = this.freePlayerSlots.length ? this.freePlayerSlots.pop() : this.players.length;
    let player = this.players[index];
    if (!player) {
      player = this.playerPool.acquire();
      player.index = index;
      this.players[index] = player;
    }
    player.index = index;
    player.id = playerId;
    player.active = true;
    return player;
  }

  getPlayerById(playerId) {
    const index = this.playerIndexById.get(playerId);
    if (index === undefined) {
      return null;
    }
    const player = this.players[index];
    if (!player || !player.active) {
      return null;
    }
    return player;
  }

  markPlayerDirty(player, mask = PLAYER_FIELD_ALL, forceFull = false) {
    if (!player || !player.active) {
      return;
    }
    if (forceFull) {
      player.fullSync = true;
      player.dirtyMask = PLAYER_FIELD_ALL;
    } else if (mask) {
      player.dirtyMask = (player.dirtyMask || 0) | mask;
    }
    const aggregatedMask = player.fullSync ? PLAYER_FIELD_ALL : player.dirtyMask || 0;
    const shouldQueue = forceFull || mask;
    if (shouldQueue && !player.dirtyQueued) {
      this.dirtyPlayerQueue.push(player.id);
      player.dirtyQueued = true;
    }
    if (shouldQueue || aggregatedMask) {
      const priority = forceFull || this.isHighPriorityPlayerMask(aggregatedMask) ? 'high' : 'low';
      this.scheduleBroadcast(priority);
    }
  }

  markBulletDirty(bullet, mask = BULLET_FIELD_ALL, forceFull = false) {
    if (!bullet || !bullet.active) {
      return;
    }
    if (forceFull) {
      bullet.fullSync = true;
      bullet.dirtyMask = BULLET_FIELD_ALL;
    } else if (mask) {
      bullet.dirtyMask = (bullet.dirtyMask || 0) | mask;
    }
    const aggregatedMask = bullet.fullSync ? BULLET_FIELD_ALL : bullet.dirtyMask || 0;
    const shouldQueue = forceFull || mask;
    if (shouldQueue && !bullet.dirtyQueued) {
      this.dirtyBulletQueue.push(bullet.index);
      bullet.dirtyQueued = true;
    }
    if (shouldQueue || aggregatedMask) {
      const priority = forceFull || this.isHighPriorityBulletMask(aggregatedMask) ? 'high' : 'low';
      this.scheduleBroadcast(priority);
    }
  }

  releaseBullet(bullet) {
    if (!bullet || !bullet.active) {
      return;
    }
    const slot = bullet.index;
    const bulletId = bullet.id;
    bullet.active = false;
    bullet.dirtyQueued = false;
    this.freeBulletSlots.push(slot);
    this.removedBulletQueue.push(bulletId);
    this.bullets[slot] = null;
    this.bulletPool.release(bullet);
    this.scheduleBroadcast('high');
  }

  buildFullStateUpdate() {
    const players = [];
    for (let i = 0; i < this.players.length; i += 1) {
      const player = this.players[i];
      if (!player || !player.active) {
        continue;
      }
      players.push({
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
        fullSync: true,
        mask: PLAYER_FIELD_ALL,
      });
    }

    const bullets = [];
    for (let i = 0; i < this.bullets.length; i += 1) {
      const bullet = this.bullets[i];
      if (!bullet || !bullet.active) {
        continue;
      }
      bullets.push({
        id: bullet.id,
        x: bullet.x,
        y: bullet.y,
        angle: bullet.angle,
        owner: bullet.owner,
        fullSync: true,
        mask: BULLET_FIELD_ALL,
      });
    }

    return {
      players,
      removedPlayers: [],
      bullets,
      removedBullets: [],
    };
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

function createPlayerTemplate() {
  return {
    id: '',
    name: '',
    x: 0,
    y: 0,
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
    active: false,
    dirtyQueued: false,
    fullSync: false,
    index: -1,
    dirtyMask: 0,
  };
}

function createBulletTemplate() {
  return {
    id: 0,
    x: 0,
    y: 0,
    angle: 0,
    owner: '',
    active: false,
    dirtyQueued: false,
    fullSync: false,
    index: -1,
    dirtyMask: 0,
  };
}

function resetPlayerTemplate(player) {
  player.id = '';
  player.name = '';
  player.x = 0;
  player.y = 0;
  player.angle = 0;
  player.health = 100;
  player.alive = true;
  player.score = 0;
  player.respawnTimer = null;
  player.shieldCharge = SHIELD_MAX_CHARGE;
  player.shieldActive = false;
  player.shieldRequested = false;
  player.dashCharge = DASH_MAX_CHARGES;
  if (!player.lastMoveDirection) {
    player.lastMoveDirection = { x: 1, y: 0 };
  } else {
    player.lastMoveDirection.x = 1;
    player.lastMoveDirection.y = 0;
  }
  player.lastMoveMessageAt = 0;
  player.weaponHeat = 0;
  player.weaponOverheated = false;
  player.weaponRecoveredAt = 0;
  player.lastShotAt = 0;
  player.active = false;
  player.dirtyQueued = false;
  player.fullSync = false;
  player.index = -1;
  player.dirtyMask = 0;
}

function resetBulletTemplate(bullet) {
  bullet.id = 0;
  bullet.x = 0;
  bullet.y = 0;
  bullet.angle = 0;
  bullet.owner = '';
  bullet.active = false;
  bullet.dirtyQueued = false;
  bullet.fullSync = false;
  bullet.index = -1;
  bullet.dirtyMask = 0;
}

function encodeInitMessage({ playerId, width = GAME_WIDTH, height = GAME_HEIGHT }) {
  const id = playerId || '';
  const idLength = byteLength(id);
  const size = 1 + 1 + idLength + 4 + 4;
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  buffer.writeUInt8(SERVER_MESSAGE_TYPES.INIT, offset);
  offset += 1;
  buffer.writeUInt8(idLength & 0xff, offset);
  offset += 1;
  if (idLength) {
    offset += buffer.write(id, offset, idLength, 'utf8');
  }
  buffer.writeFloatLE(width ?? GAME_WIDTH, offset);
  offset += 4;
  buffer.writeFloatLE(height ?? GAME_HEIGHT, offset);
  return buffer;
}

function encodeStateUpdate({ players, removedPlayers, bullets, removedBullets }) {
  const headerSize = 1 + 2 * 4;
  let size = headerSize;

  for (let i = 0; i < players.length; i += 1) {
    const player = players[i];
    const mask = player.fullSync ? PLAYER_FIELD_ALL : player.mask || 0;
    const idLength = byteLength(player.id);
    const includeName = (mask & PLAYER_FIELD_FLAGS.NAME) !== 0;
    const nameValue = includeName && player.name ? player.name : '';
    const nameLength = includeName ? byteLength(nameValue) : 0;
    size += 1 + 1 + idLength + 2;
    if (includeName) {
      size += 1 + nameLength;
    }
    if (mask & PLAYER_FIELD_FLAGS.POSITION) {
      size += 8;
    }
    if (mask & PLAYER_FIELD_FLAGS.ANGLE) {
      size += 4;
    }
    if (mask & PLAYER_FIELD_FLAGS.HEALTH) {
      size += 4;
    }
    if (mask & PLAYER_FIELD_FLAGS.SCORE) {
      size += 4;
    }
    if (mask & PLAYER_FIELD_FLAGS.SHIELD) {
      size += 4;
    }
    if (mask & PLAYER_FIELD_FLAGS.DASH) {
      size += 4;
    }
  }

  for (let i = 0; i < removedPlayers.length; i += 1) {
    const id = removedPlayers[i];
    size += 1 + byteLength(id);
  }

  for (let i = 0; i < bullets.length; i += 1) {
    const bullet = bullets[i];
    const mask = bullet.fullSync ? BULLET_FIELD_ALL : bullet.mask || 0;
    const ownerValue = mask & BULLET_FIELD_FLAGS.OWNER ? bullet.owner || '' : '';
    const ownerLength = mask & BULLET_FIELD_FLAGS.OWNER ? byteLength(ownerValue) : 0;
    size += 1 + 4 + 1;
    if (mask & BULLET_FIELD_FLAGS.POSITION) {
      size += 8;
    }
    if (mask & BULLET_FIELD_FLAGS.ANGLE) {
      size += 4;
    }
    if (mask & BULLET_FIELD_FLAGS.OWNER) {
      size += 1 + ownerLength;
    }
  }

  size += removedBullets.length * 4;

  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  buffer.writeUInt8(SERVER_MESSAGE_TYPES.STATE_UPDATE, offset);
  offset += 1;
  buffer.writeUInt16LE(players.length, offset);
  offset += 2;
  buffer.writeUInt16LE(removedPlayers.length, offset);
  offset += 2;
  buffer.writeUInt16LE(bullets.length, offset);
  offset += 2;
  buffer.writeUInt16LE(removedBullets.length, offset);
  offset += 2;

  for (let i = 0; i < players.length; i += 1) {
    const player = players[i];
    const mask = player.fullSync ? PLAYER_FIELD_ALL : player.mask || 0;
    const id = player.id || '';
    const idLength = byteLength(id);
    const includeName = (mask & PLAYER_FIELD_FLAGS.NAME) !== 0;
    const nameValue = includeName && player.name ? player.name : '';
    const nameLength = includeName ? byteLength(nameValue) : 0;
    let flags = 0;
    if (player.fullSync) flags |= 1;
    if (player.alive) flags |= 2;
    if (player.shieldActive) flags |= 4;
    if (includeName) flags |= 8;
    buffer.writeUInt8(flags, offset);
    offset += 1;
    buffer.writeUInt8(idLength, offset);
    offset += 1;
    if (idLength) {
      offset += buffer.write(id, offset, idLength, 'utf8');
    }
    if (includeName) {
      buffer.writeUInt8(nameLength, offset);
      offset += 1;
      if (nameLength) {
        offset += buffer.write(nameValue, offset, nameLength, 'utf8');
      }
    }
    buffer.writeUInt16LE(mask & 0xffff, offset);
    offset += 2;
    if (mask & PLAYER_FIELD_FLAGS.POSITION) {
      buffer.writeFloatLE(player.x ?? 0, offset);
      offset += 4;
      buffer.writeFloatLE(player.y ?? 0, offset);
      offset += 4;
    }
    if (mask & PLAYER_FIELD_FLAGS.ANGLE) {
      buffer.writeFloatLE(player.angle ?? 0, offset);
      offset += 4;
    }
    if (mask & PLAYER_FIELD_FLAGS.HEALTH) {
      buffer.writeFloatLE(player.health ?? 0, offset);
      offset += 4;
    }
    if (mask & PLAYER_FIELD_FLAGS.SCORE) {
      buffer.writeFloatLE(player.score ?? 0, offset);
      offset += 4;
    }
    if (mask & PLAYER_FIELD_FLAGS.SHIELD) {
      buffer.writeFloatLE(player.shieldCharge ?? 0, offset);
      offset += 4;
    }
    if (mask & PLAYER_FIELD_FLAGS.DASH) {
      buffer.writeFloatLE(player.dashCharge ?? 0, offset);
      offset += 4;
    }
  }

  for (let i = 0; i < removedPlayers.length; i += 1) {
    const id = removedPlayers[i] || '';
    const idLength = byteLength(id);
    buffer.writeUInt8(idLength, offset);
    offset += 1;
    if (idLength) {
      offset += buffer.write(id, offset, idLength, 'utf8');
    }
  }

  for (let i = 0; i < bullets.length; i += 1) {
    const bullet = bullets[i];
    const mask = bullet.fullSync ? BULLET_FIELD_ALL : bullet.mask || 0;
    const ownerValue = mask & BULLET_FIELD_FLAGS.OWNER ? bullet.owner || '' : '';
    const ownerLength = mask & BULLET_FIELD_FLAGS.OWNER ? byteLength(ownerValue) : 0;
    const flags = bullet.fullSync ? 1 : 0;
    buffer.writeUInt8(flags, offset);
    offset += 1;
    buffer.writeUInt32LE((bullet.id || 0) >>> 0, offset);
    offset += 4;
    buffer.writeUInt8(mask & 0xff, offset);
    offset += 1;
    if (mask & BULLET_FIELD_FLAGS.POSITION) {
      buffer.writeFloatLE(bullet.x ?? 0, offset);
      offset += 4;
      buffer.writeFloatLE(bullet.y ?? 0, offset);
      offset += 4;
    }
    if (mask & BULLET_FIELD_FLAGS.ANGLE) {
      buffer.writeFloatLE(bullet.angle ?? 0, offset);
      offset += 4;
    }
    if (mask & BULLET_FIELD_FLAGS.OWNER) {
      buffer.writeUInt8(ownerLength, offset);
      offset += 1;
      if (ownerLength) {
        offset += buffer.write(ownerValue, offset, ownerLength, 'utf8');
      }
    }
  }

  for (let i = 0; i < removedBullets.length; i += 1) {
    const id = removedBullets[i];
    buffer.writeUInt32LE((id || 0) >>> 0, offset);
    offset += 4;
  }

  return buffer;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

module.exports = GameRoom;
