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
    this.players = [];
    this.playerIndexById = new Map();
    this.freePlayerSlots = [];
    this.dirtyPlayerQueue = [];
    this.removedPlayerQueue = [];
    this.clients = new Map();
    this.bullets = [];
    this.freeBulletSlots = [];
    this.dirtyBulletQueue = [];
    this.removedBulletQueue = [];
    this.nextBulletId = 0;
    this.lastActivity = Date.now();
    this.interval = setInterval(() => this.step(), 1000 / TICK_RATE);
  }

  destroy() {
    clearInterval(this.interval);
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
    this.markPlayerDirty(player, true);
    this.clients.set(playerId, ws);
    this.lastActivity = Date.now();
    this.send(ws, {
      type: 'init',
      playerId,
      room: this.getLobbyInfo(),
      constants: { width: GAME_WIDTH, height: GAME_HEIGHT },
    });
    const snapshot = this.buildFullStateUpdate();
    if (snapshot.players.length || snapshot.bullets.length) {
      try {
        if (typeof ws.send === 'function') {
          ws.send(encodeStateUpdate(snapshot), true);
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
      player.active = false;
      player.dirtyQueued = false;
      this.playerIndexById.delete(playerId);
      this.freePlayerSlots.push(player.index);
      this.removedPlayerQueue.push(playerId);
    }
    this.lastActivity = Date.now();
  }

  handleMessage(playerId, rawMessage) {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch (error) {
      return;
    }

    const player = this.getPlayerById(playerId);
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
        player.lastMoveDirection.x = deltaX / length;
        player.lastMoveDirection.y = deltaY / length;
      }
      let changed = false;
      if (player.x !== clampedX) {
        player.x = clampedX;
        changed = true;
      }
      if (player.y !== clampedY) {
        player.y = clampedY;
        changed = true;
      }
      if (typeof angle === 'number' && Number.isFinite(angle) && player.angle !== angle) {
        player.angle = angle;
        changed = true;
      }
      player.lastMoveMessageAt = now;
      if (changed) {
        this.markPlayerDirty(player);
      }
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
      this.markPlayerDirty(player);
      this.lastActivity = now;
    } else if (message.type === 'respawn' && !player.alive) {
      this.respawnPlayer(playerId);
    } else if (message.type === 'shield') {
      const requested = !!message.active && player.alive;
      if (player.shieldRequested !== requested) {
        player.shieldRequested = requested;
        this.markPlayerDirty(player);
      }
      if (!player.shieldRequested && player.shieldActive) {
        player.shieldActive = false;
        this.markPlayerDirty(player);
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
        const targetX = clamp(player.x + normX * DASH_DISTANCE, PLAYER_RADIUS, GAME_WIDTH - PLAYER_RADIUS);
        const targetY = clamp(player.y + normY * DASH_DISTANCE, PLAYER_RADIUS, GAME_HEIGHT - PLAYER_RADIUS);
        let changed = false;
        if (player.x !== targetX) {
          player.x = targetX;
          changed = true;
        }
        if (player.y !== targetY) {
          player.y = targetY;
          changed = true;
        }
        const nextCharge = Math.max(0, player.dashCharge - 1);
        if (nextCharge !== player.dashCharge) {
          player.dashCharge = nextCharge;
          changed = true;
        }
        player.lastMoveDirection.x = normX;
        player.lastMoveDirection.y = normY;
        if (changed) {
          this.markPlayerDirty(player);
        }
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
      bullet = createBulletTemplate();
      bullet.index = slot;
      this.bullets[slot] = bullet;
    }
    bullet.index = slot;
    bullet.id = this.nextBulletId++;
    bullet.x = player.x;
    bullet.y = player.y;
    bullet.angle = player.angle;
    bullet.owner = playerId;
    bullet.active = true;
    bullet.fullSync = true;
    bullet.dirtyQueued = false;
    this.markBulletDirty(bullet, true);
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
    this.markPlayerDirty(player, true);
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
        let changed = false;
        if (player.shieldActive) {
          player.shieldActive = false;
          changed = true;
        }
        if (player.shieldRequested) {
          player.shieldRequested = false;
          changed = true;
        }
        const nextDash = Math.min(DASH_MAX_CHARGES, player.dashCharge + STEP_DELTA / DASH_RECHARGE_MS);
        if (nextDash !== player.dashCharge) {
          player.dashCharge = nextDash;
          changed = true;
        }
        if (changed) {
          this.markPlayerDirty(player);
        }
        continue;
      }
      let changed = false;
      if (player.shieldRequested && player.shieldCharge > 0) {
        if (!player.shieldActive) {
          player.shieldActive = true;
          changed = true;
        }
        const nextCharge = Math.max(0, player.shieldCharge - STEP_DELTA);
        if (nextCharge !== player.shieldCharge) {
          player.shieldCharge = nextCharge;
          changed = true;
        }
        if (player.shieldCharge <= 0 && player.shieldActive) {
          player.shieldActive = false;
          player.shieldRequested = false;
          changed = true;
        }
      } else {
        if (player.shieldActive) {
          player.shieldActive = false;
          changed = true;
        }
        const nextCharge = Math.min(
          SHIELD_MAX_CHARGE,
          player.shieldCharge + STEP_DELTA * SHIELD_RECHARGE_FACTOR,
        );
        if (nextCharge !== player.shieldCharge) {
          player.shieldCharge = nextCharge;
          changed = true;
        }
      }
      const nextDash = Math.min(
        DASH_MAX_CHARGES,
        player.dashCharge + STEP_DELTA / DASH_RECHARGE_MS,
      );
      if (nextDash !== player.dashCharge) {
        player.dashCharge = nextDash;
        changed = true;
      }
      if (changed) {
        this.markPlayerDirty(player);
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
              this.markPlayerDirty(player);
            }
            if (player.shieldCharge <= 0) {
              if (player.shieldActive || player.shieldRequested) {
                player.shieldActive = false;
                player.shieldRequested = false;
                this.markPlayerDirty(player);
              }
            }
            this.markBulletDirty(bullet, true);
            alive = true;
            break;
          }
        }
        if (distance < PLAYER_RADIUS + BULLET_RADIUS) {
          player.health -= DAMAGE_PER_HIT;
          if (player.health <= 0) {
            player.health = 0;
            player.alive = false;
            player.respawnTimer = now + 60000; // manual respawn window
            const shooter = this.getPlayerById(bullet.owner);
            if (shooter) {
              shooter.score = (shooter.score || 0) + 1;
              this.markPlayerDirty(shooter);
            }
          }
          this.markPlayerDirty(player);
          this.releaseBullet(bullet);
          alive = false;
          break;
        }
      }
      if (alive && bullet.active) {
        this.markBulletDirty(bullet);
      }
    }

    this.broadcastState();
  }

  broadcastState() {
    const playersToSend = [];
    while (this.dirtyPlayerQueue.length) {
      const playerId = this.dirtyPlayerQueue.pop();
      const player = this.getPlayerById(playerId);
      if (!player || !player.active) {
        continue;
      }
      playersToSend.push({
        id: player.id,
        name: player.fullSync ? player.name : undefined,
        x: player.x,
        y: player.y,
        angle: player.angle,
        health: player.health,
        alive: player.alive,
        score: player.score || 0,
        shieldCharge: player.shieldCharge,
        shieldActive: player.shieldActive,
        dashCharge: player.dashCharge,
        fullSync: player.fullSync,
      });
      player.fullSync = false;
      player.dirtyQueued = false;
    }

    const bulletsToSend = [];
    while (this.dirtyBulletQueue.length) {
      const bulletIndex = this.dirtyBulletQueue.pop();
      const bullet = this.bullets[bulletIndex];
      if (!bullet || !bullet.active) {
        continue;
      }
      bulletsToSend.push({
        id: bullet.id,
        x: bullet.x,
        y: bullet.y,
        angle: bullet.angle,
        owner: bullet.owner,
        fullSync: bullet.fullSync,
      });
      bullet.fullSync = false;
      bullet.dirtyQueued = false;
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
      return;
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
        ws.send(payload, true);
      } catch (error) {
        // ignore send errors
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
    if (!ws || ws.isClosed || typeof ws.send !== 'function') {
      return;
    }
    try {
      ws.send(JSON.stringify(payload));
    } catch (error) {
      // ignore send errors
    }
  }

  acquirePlayerSlot(playerId) {
    const index = this.freePlayerSlots.length ? this.freePlayerSlots.pop() : this.players.length;
    let player = this.players[index];
    if (!player) {
      player = createPlayerTemplate();
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

  markPlayerDirty(player, forceFull = false) {
    if (!player || !player.active) {
      return;
    }
    if (forceFull) {
      player.fullSync = true;
    }
    if (!player.dirtyQueued) {
      this.dirtyPlayerQueue.push(player.id);
      player.dirtyQueued = true;
    }
  }

  markBulletDirty(bullet, forceFull = false) {
    if (!bullet || !bullet.active) {
      return;
    }
    if (forceFull) {
      bullet.fullSync = true;
    }
    if (!bullet.dirtyQueued) {
      this.dirtyBulletQueue.push(bullet.index);
      bullet.dirtyQueued = true;
    }
  }

  releaseBullet(bullet) {
    if (!bullet || !bullet.active) {
      return;
    }
    bullet.active = false;
    bullet.dirtyQueued = false;
    this.freeBulletSlots.push(bullet.index);
    this.removedBulletQueue.push(bullet.id);
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
    index: 0,
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
    index: 0,
  };
}

function encodeStateUpdate({ players, removedPlayers, bullets, removedBullets }) {
  const headerSize = 1 + 2 * 4;
  let size = headerSize;

  for (let i = 0; i < players.length; i += 1) {
    const player = players[i];
    const idLength = byteLength(player.id);
    const nameLength = player.fullSync && player.name ? byteLength(player.name) : 0;
    size += 2 + idLength + 28;
    if (nameLength) {
      size += 1 + nameLength;
    }
  }

  for (let i = 0; i < removedPlayers.length; i += 1) {
    const id = removedPlayers[i];
    size += 1 + byteLength(id);
  }

  for (let i = 0; i < bullets.length; i += 1) {
    const bullet = bullets[i];
    const ownerLength = bullet.fullSync && bullet.owner ? byteLength(bullet.owner) : 0;
    size += 1 + 4 + 12;
    if (ownerLength) {
      size += 1 + ownerLength;
    }
  }

  size += removedBullets.length * 4;

  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  buffer.writeUInt8(1, offset);
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
    const idLength = byteLength(player.id);
    const nameLength = player.fullSync && player.name ? byteLength(player.name) : 0;
    let flags = 0;
    if (player.fullSync) flags |= 1;
    if (player.alive) flags |= 2;
    if (player.shieldActive) flags |= 4;
    buffer.writeUInt8(flags, offset);
    offset += 1;
    buffer.writeUInt8(idLength, offset);
    offset += 1;
    offset += buffer.write(player.id, offset, idLength, 'utf8');
    if (nameLength) {
      buffer.writeUInt8(nameLength, offset);
      offset += 1;
      offset += buffer.write(player.name, offset, nameLength, 'utf8');
    }
    buffer.writeFloatLE(player.x, offset);
    offset += 4;
    buffer.writeFloatLE(player.y, offset);
    offset += 4;
    buffer.writeFloatLE(player.angle, offset);
    offset += 4;
    buffer.writeFloatLE(player.health, offset);
    offset += 4;
    buffer.writeFloatLE(player.score, offset);
    offset += 4;
    buffer.writeFloatLE(player.shieldCharge, offset);
    offset += 4;
    buffer.writeFloatLE(player.dashCharge, offset);
    offset += 4;
  }

  for (let i = 0; i < removedPlayers.length; i += 1) {
    const id = removedPlayers[i];
    const idLength = byteLength(id);
    buffer.writeUInt8(idLength, offset);
    offset += 1;
    offset += buffer.write(id, offset, idLength, 'utf8');
  }

  for (let i = 0; i < bullets.length; i += 1) {
    const bullet = bullets[i];
    const ownerLength = bullet.fullSync && bullet.owner ? byteLength(bullet.owner) : 0;
    const flags = bullet.fullSync ? 1 : 0;
    buffer.writeUInt8(flags, offset);
    offset += 1;
    buffer.writeUInt32LE(bullet.id >>> 0, offset);
    offset += 4;
    buffer.writeFloatLE(bullet.x, offset);
    offset += 4;
    buffer.writeFloatLE(bullet.y, offset);
    offset += 4;
    buffer.writeFloatLE(bullet.angle, offset);
    offset += 4;
    if (ownerLength) {
      buffer.writeUInt8(ownerLength, offset);
      offset += 1;
      offset += buffer.write(bullet.owner, offset, ownerLength, 'utf8');
    }
  }

  for (let i = 0; i < removedBullets.length; i += 1) {
    const id = removedBullets[i];
    buffer.writeUInt32LE(id >>> 0, offset);
    offset += 4;
  }

  return buffer;
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

module.exports = GameRoom;
