const GAME_WIDTH = 960;
const GAME_HEIGHT = 540;
const PLAYER_RADIUS = 16;
const BULLET_RADIUS = 4;
const MOVE_SPEED = 4.2;
const BULLET_SPEED = 9;
const DAMAGE = 22;
const SHIELD_MAX_CHARGE = 3334;
const SHIELD_RECHARGE_FACTOR = 0.5;
const SHIELD_ARC = Math.PI * 0.9;
const SHIELD_RADIUS = PLAYER_RADIUS + 22;
const SHIELD_REFLECTION_DRAIN = 0.1;
const DASH_MAX_CHARGES = 3;
const DASH_RECHARGE_MS = 5000;
const DASH_DISTANCE = 136;

const BOT_DIFFICULTY = {
  easy: { speed: 2.6, fireRate: 650, accuracy: 0.6 },
  normal: { speed: 3.2, fireRate: 480, accuracy: 0.75 },
  hard: { speed: 3.9, fireRate: 360, accuracy: 0.9 },
};

const SHIELD_COLOR_FULL_A = { r: 77, g: 246, b: 255 };
const SHIELD_COLOR_FULL_B = { r: 255, g: 44, b: 251 };
const SHIELD_COLOR_DRAINED_A = { r: 48, g: 94, b: 120 };
const SHIELD_COLOR_DRAINED_B = { r: 108, g: 62, b: 112 };
const DASH_TRAIL_DURATION = 280;

function mixChannel(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function mixColor(colorA, colorB, t) {
  return {
    r: mixChannel(colorA.r, colorB.r, t),
    g: mixChannel(colorA.g, colorB.g, t),
    b: mixChannel(colorA.b, colorB.b, t),
  };
}

function colorToRgba({ r, g, b }, alpha = 1) {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getShieldColors(ratio) {
  const t = Math.min(1, Math.max(0, 1 - ratio));
  return {
    primary: mixColor(SHIELD_COLOR_FULL_A, SHIELD_COLOR_DRAINED_A, t),
    secondary: mixColor(SHIELD_COLOR_FULL_B, SHIELD_COLOR_DRAINED_B, t),
  };
}

function normalizeAngle(angle) {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

export class OfflineGame {
  constructor({ canvas, inputState, ui }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.input = inputState;
    this.ui = ui;
    this.players = {};
    this.bullets = [];
    this.running = false;
    this.animationId = null;
    this.settings = BOT_DIFFICULTY.normal;
    this.playerName = 'Pilot';
    this.lastShotAt = 0;
    this.botShotAt = 0;
    this.lastFrameTime = 0;
    this.dashTrails = [];
  }

  start({ difficulty = 'normal', playerName = 'Pilot' }) {
    this.settings = BOT_DIFFICULTY[difficulty] || BOT_DIFFICULTY.normal;
    this.playerName = playerName || 'Pilot';
    this.resetState();
    this.running = true;
    this.lastFrameTime = performance.now();
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  respawn() {
    const player = this.players.player;
    if (player && !player.alive) {
      this.spawnPlayer(player);
      this.ui.toggleRespawn(false);
      this.ui.setStatus('Возвращение в бой', 'success');
    }
  }

  resetState() {
    this.players = {
      player: {
        id: 'player',
        name: this.playerName,
        x: GAME_WIDTH * 0.25,
        y: GAME_HEIGHT * 0.5,
        angle: 0,
        health: 100,
        alive: true,
        score: 0,
        shieldCharge: SHIELD_MAX_CHARGE,
        shieldActive: false,
        dashCharge: DASH_MAX_CHARGES,
        lastMoveDirection: { x: 1, y: 0 },
      },
      bot: {
        id: 'bot',
        name: 'SYNTH',
        x: GAME_WIDTH * 0.75,
        y: GAME_HEIGHT * 0.5,
        angle: Math.PI,
        health: 100,
        alive: true,
        score: 0,
        shieldCharge: SHIELD_MAX_CHARGE,
        shieldActive: false,
        dashCharge: DASH_MAX_CHARGES,
        lastMoveDirection: { x: -1, y: 0 },
      },
    };
    this.bullets = [];
    this.lastShotAt = 0;
    this.botShotAt = 0;
    this.dashTrails = [];
    this.ui.setHealth(100);
    this.ui.toggleRespawn(false);
    this.ui.setScoreboard([
      { id: 'player', name: this.playerName, score: 0, isSelf: true },
      { id: 'bot', name: 'SYNTH', score: 0, isSelf: false },
    ]);
    this.ui.setStatus('Бой начался', 'success');
  }

  spawnPlayer(player) {
    player.x = GAME_WIDTH * 0.25;
    player.y = GAME_HEIGHT * 0.5;
    player.health = 100;
    player.alive = true;
    player.shieldCharge = SHIELD_MAX_CHARGE;
    player.shieldActive = false;
    player.dashCharge = DASH_MAX_CHARGES;
    player.lastMoveDirection = { x: 1, y: 0 };
  }

  spawnBot(bot) {
    bot.x = GAME_WIDTH * 0.75;
    bot.y = GAME_HEIGHT * 0.5;
    bot.health = 100;
    bot.alive = true;
    bot.shieldActive = false;
    bot.shieldCharge = SHIELD_MAX_CHARGE;
    bot.dashCharge = DASH_MAX_CHARGES;
    bot.lastMoveDirection = { x: -1, y: 0 };
  }

  recordDashTrail(fromX, fromY, toX, toY) {
    this.dashTrails.push({
      fromX,
      fromY,
      toX,
      toY,
      start: performance.now(),
    });
  }

  loop() {
    if (!this.running) return;
    const now = performance.now();
    const delta = this.lastFrameTime ? now - this.lastFrameTime : 16;
    this.lastFrameTime = now;
    this.update(delta);
    this.render();
    this.animationId = requestAnimationFrame(() => this.loop());
  }

  update(delta) {
    const player = this.players.player;
    const bot = this.players.bot;
    if (!player || !bot) return;

    if (player.alive) {
      this.updatePlayer(player, delta);
    } else {
      player.shieldActive = false;
    }
    if (bot.alive) {
      this.updateBot(bot, player);
    }

    this.updateBullets();
    this.updateUi();
  }

  updatePlayer(player, delta) {
    const analogX = this.input.moveVector.x;
    const analogY = this.input.moveVector.y;
    let keyX = 0;
    let keyY = 0;
    if (this.input.keys.has('a')) keyX -= 1;
    if (this.input.keys.has('d')) keyX += 1;
    if (this.input.keys.has('w')) keyY -= 1;
    if (this.input.keys.has('s')) keyY += 1;
    const combinedX = keyX + analogX;
    const combinedY = keyY + analogY;
    const magnitude = Math.hypot(combinedX, combinedY);
    if (magnitude > 0.01) {
      const speedMultiplier = Math.min(1, magnitude);
      const moveX = (combinedX / magnitude) * MOVE_SPEED * speedMultiplier;
      const moveY = (combinedY / magnitude) * MOVE_SPEED * speedMultiplier;
      player.x += moveX;
      player.y += moveY;
      player.lastMoveDirection = { x: combinedX / magnitude, y: combinedY / magnitude };
    }
    player.x = Math.max(PLAYER_RADIUS, Math.min(GAME_WIDTH - PLAYER_RADIUS, player.x));
    player.y = Math.max(PLAYER_RADIUS, Math.min(GAME_HEIGHT - PLAYER_RADIUS, player.y));

    const scaleX = GAME_WIDTH / this.canvas.width;
    const scaleY = GAME_HEIGHT / this.canvas.height;
    const invScaleX = this.canvas.width / GAME_WIDTH;
    const invScaleY = this.canvas.height / GAME_HEIGHT;
    let targetX = this.input.pointer.x * scaleX;
    let targetY = this.input.pointer.y * scaleY;
    if (this.input.aimVector.active) {
      const aimDistance = 180;
      const aimX = player.x + this.input.aimVector.x * aimDistance;
      const aimY = player.y + this.input.aimVector.y * aimDistance;
      targetX = aimX;
      targetY = aimY;
      this.input.pointer.x = Math.max(0, Math.min(this.canvas.width, aimX * invScaleX));
      this.input.pointer.y = Math.max(0, Math.min(this.canvas.height, aimY * invScaleY));
    }
    player.angle = Math.atan2(targetY - player.y, targetX - player.x);

    const wantsShield = this.input.shield && player.shieldCharge > 0;
    if (wantsShield) {
      player.shieldActive = true;
      player.shieldCharge = Math.max(0, player.shieldCharge - delta);
      if (player.shieldCharge <= 0) {
        player.shieldActive = false;
      }
    } else {
      player.shieldActive = false;
      player.shieldCharge = Math.min(
        SHIELD_MAX_CHARGE,
        player.shieldCharge + delta * SHIELD_RECHARGE_FACTOR
      );
    }

    const now = performance.now();
    if (
      this.input.fire &&
      !player.shieldActive &&
      !this.input.shield &&
      now - this.lastShotAt > 220 &&
      player.alive
    ) {
      this.spawnBullet(player);
      this.lastShotAt = now;
    }

    const dashRequested = this.input.consumeDashRequest();
    if (dashRequested && player.dashCharge >= 1) {
      const fromX = player.x;
      const fromY = player.y;
      const baseX = magnitude > 0.01 ? combinedX / magnitude : player.lastMoveDirection.x || Math.cos(player.angle);
      const baseY = magnitude > 0.01 ? combinedY / magnitude : player.lastMoveDirection.y || Math.sin(player.angle);
      const dirLength = Math.hypot(baseX, baseY) || 1;
      const dirX = baseX / dirLength;
      const dirY = baseY / dirLength;
      player.x += dirX * DASH_DISTANCE;
      player.y += dirY * DASH_DISTANCE;
      player.dashCharge = Math.max(0, player.dashCharge - 1);
      player.x = Math.max(PLAYER_RADIUS, Math.min(GAME_WIDTH - PLAYER_RADIUS, player.x));
      player.y = Math.max(PLAYER_RADIUS, Math.min(GAME_HEIGHT - PLAYER_RADIUS, player.y));
      this.recordDashTrail(fromX, fromY, player.x, player.y);
    }

    player.dashCharge = Math.min(
      DASH_MAX_CHARGES,
      player.dashCharge + delta / DASH_RECHARGE_MS
    );
  }

  updateBot(bot, player) {
    const settings = this.settings;
    const dx = player.x - bot.x;
    const dy = player.y - bot.y;
    const distance = Math.hypot(dx, dy) || 1;

    const desiredDistance = 260;
    if (distance > desiredDistance + 30) {
      bot.x += (dx / distance) * settings.speed;
      bot.y += (dy / distance) * settings.speed;
    } else if (distance < desiredDistance - 30) {
      bot.x -= (dx / distance) * settings.speed;
      bot.y -= (dy / distance) * settings.speed;
    } else {
      const strafeAngle = Math.atan2(dy, dx) + Math.PI / 2;
      bot.x += Math.cos(strafeAngle) * settings.speed * 0.6;
      bot.y += Math.sin(strafeAngle) * settings.speed * 0.6;
    }

    bot.x = Math.max(PLAYER_RADIUS, Math.min(GAME_WIDTH - PLAYER_RADIUS, bot.x));
    bot.y = Math.max(PLAYER_RADIUS, Math.min(GAME_HEIGHT - PLAYER_RADIUS, bot.y));

    const predict = Math.min(distance / 140, 1.2);
    const aimX = player.x + Math.cos(player.angle) * 24 * predict;
    const aimY = player.y + Math.sin(player.angle) * 24 * predict;
    bot.angle = Math.atan2(aimY - bot.y, aimX - bot.x);

    const now = performance.now();
    if (now - this.botShotAt > settings.fireRate && Math.random() < settings.accuracy) {
      this.spawnBullet(bot, settings.accuracy);
      this.botShotAt = now;
    }
  }

  spawnBullet(shooter, accuracy = 1) {
    const spread = (1 - accuracy) * (Math.PI / 12);
    const angle = shooter.angle + (Math.random() - 0.5) * spread;
    this.bullets.push({
      id: Math.random().toString(16).slice(2),
      x: shooter.x,
      y: shooter.y,
      angle,
      owner: shooter.id,
      reflected: false,
    });
  }

  updateBullets() {
    this.bullets = this.bullets.filter((bullet) => {
      bullet.x += Math.cos(bullet.angle) * BULLET_SPEED;
      bullet.y += Math.sin(bullet.angle) * BULLET_SPEED;
      if (bullet.x < 0 || bullet.y < 0 || bullet.x > GAME_WIDTH || bullet.y > GAME_HEIGHT) {
        return false;
      }
      const targets = bullet.owner === 'player' ? ['bot'] : ['player'];
      for (const targetId of targets) {
        const target = this.players[targetId];
        if (!target || !target.alive) continue;
        const distance = Math.hypot(target.x - bullet.x, target.y - bullet.y);
        if (
          target.shieldActive &&
          target.shieldCharge > 0 &&
          bullet.owner !== target.id &&
          distance < SHIELD_RADIUS
        ) {
          const toBulletAngle = Math.atan2(bullet.y - target.y, bullet.x - target.x);
          const angleDiff = Math.abs(normalizeAngle(target.angle - toBulletAngle));
          if (angleDiff <= SHIELD_ARC / 2) {
            bullet.owner = target.id;
            bullet.reflected = true;
            bullet.angle = target.angle;
            const offset = SHIELD_RADIUS + 6;
            bullet.x = target.x + Math.cos(target.angle) * offset;
            bullet.y = target.y + Math.sin(target.angle) * offset;
            const drain = SHIELD_MAX_CHARGE * SHIELD_REFLECTION_DRAIN;
            target.shieldCharge = Math.max(0, target.shieldCharge - drain);
            if (target.shieldCharge <= 0) {
              target.shieldActive = false;
            }
            return true;
          }
        }
        if (distance < PLAYER_RADIUS + BULLET_RADIUS) {
          target.health -= DAMAGE;
          if (target.health <= 0) {
            target.health = 0;
            target.alive = false;
            this.players[bullet.owner].score += 1;
            if (targetId === 'player') {
              this.ui.toggleRespawn(true);
              this.ui.setStatus('Вы проиграли раунд', 'error');
            } else {
              this.spawnBot(target);
              this.ui.setStatus('Синтетик повержен', 'success');
            }
          }
          return false;
        }
      }
      return true;
    });
  }

  updateUi() {
    const player = this.players.player;
    const bot = this.players.bot;
    if (player) {
      this.ui.setHealth(player.health);
      this.ui.setShield(player.shieldCharge / SHIELD_MAX_CHARGE, player.shieldActive);
      this.ui.setDash(player.dashCharge);
      if (!player.alive) {
        this.ui.toggleRespawn(true);
      }
    }
    const entries = [
      {
        id: 'player',
        name: this.playerName,
        score: player ? player.score : 0,
        isSelf: true,
      },
      {
        id: 'bot',
        name: 'SYNTH',
        score: bot ? bot.score : 0,
        isSelf: false,
      },
    ];
    this.ui.setScoreboard(entries);
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const scaleX = this.canvas.width / GAME_WIDTH;
    const scaleY = this.canvas.height / GAME_HEIGHT;

    const gradient = ctx.createLinearGradient(0, 0, this.canvas.width, this.canvas.height);
    gradient.addColorStop(0, '#050813');
    gradient.addColorStop(0.55, '#09132a');
    gradient.addColorStop(1, '#03040c');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = 'rgba(77, 246, 255, 0.12)';
    ctx.lineWidth = 1;
    for (let x = 0; x < GAME_WIDTH; x += 70) {
      ctx.beginPath();
      ctx.moveTo(x * scaleX, 0);
      ctx.lineTo(x * scaleX, this.canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < GAME_HEIGHT; y += 70) {
      ctx.beginPath();
      ctx.moveTo(0, y * scaleY);
      ctx.lineTo(this.canvas.width, y * scaleY);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    const sweep = (performance.now() % 4500) / 4500;
    const sweepY = sweep * this.canvas.height;
    const sweepOpacity = 0.18 + Math.sin(sweep * Math.PI) * 0.08;
    ctx.fillStyle = `rgba(77, 246, 255, ${sweepOpacity.toFixed(3)})`;
    ctx.fillRect(0, sweepY, this.canvas.width, 3);
    ctx.restore();

    const nowTime = performance.now();
    this.dashTrails = this.dashTrails.filter((trail) => {
      const age = nowTime - trail.start;
      if (age > DASH_TRAIL_DURATION) {
        return false;
      }
      const t = Math.max(0, Math.min(1, age / DASH_TRAIL_DURATION));
      const startX = trail.fromX * scaleX;
      const startY = trail.fromY * scaleY;
      const endX = trail.toX * scaleX;
      const endY = trail.toY * scaleY;
      const gradient = ctx.createLinearGradient(startX, startY, endX, endY);
      gradient.addColorStop(0, colorToRgba(SHIELD_COLOR_FULL_A, 0.45 * (1 - t) + 0.25));
      gradient.addColorStop(1, colorToRgba(SHIELD_COLOR_FULL_B, 0.35 * (1 - t) + 0.15));
      ctx.save();
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 22 * (1 - t) + 6;
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(77, 246, 255, 0.45)';
      ctx.shadowBlur = 18 * (1 - t);
      ctx.globalAlpha = 0.9 * (1 - t);
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
      ctx.restore();
      return true;
    });

    this.bullets.forEach((bullet) => {
      const bx = bullet.x * scaleX;
      const by = bullet.y * scaleY;
      const color = bullet.owner === 'player' ? '#4df6ff' : '#ff4d7a';
      ctx.save();
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(bx, by, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    Object.values(this.players).forEach((player) => {
      const px = player.x * scaleX;
      const py = player.y * scaleY;
      const color = player.id === 'player' ? '#4df6ff' : '#ff2cfb';
      ctx.save();
      ctx.globalAlpha = player.alive ? 1 : 0.25;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = player.alive ? 22 : 12;
      ctx.beginPath();
      ctx.arc(px, py, PLAYER_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      if (player.shieldActive && player.shieldCharge > 0) {
        const shieldRatio = player.shieldCharge / SHIELD_MAX_CHARGE;
        const colors = getShieldColors(shieldRatio);
        const radius = (PLAYER_RADIUS + 18) * ((scaleX + scaleY) / 2);
        ctx.save();
        ctx.globalAlpha = 0.35 + shieldRatio * 0.35;
        ctx.fillStyle = colorToRgba(colors.secondary, 0.22 + shieldRatio * 0.2);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.arc(px, py, radius, player.angle - SHIELD_ARC / 2, player.angle + SHIELD_ARC / 2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = colorToRgba(colors.primary, 0.75 + shieldRatio * 0.2);
        ctx.lineWidth = 5.5;
        ctx.shadowColor = colorToRgba(colors.primary, 0.65);
        ctx.shadowBlur = 14 + shieldRatio * 8;
        ctx.beginPath();
        ctx.arc(px, py, radius, player.angle - SHIELD_ARC / 2, player.angle + SHIELD_ARC / 2);
        ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(player.angle) * 22, py + Math.sin(player.angle) * 22);
      ctx.stroke();
      ctx.restore();

      const barWidth = 36;
      const barHeight = 6;
      const barX = px - barWidth / 2;
      const barY = py - PLAYER_RADIUS - 18;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(barX, barY, barWidth, barHeight);
      ctx.fillStyle = player.health > 50 ? '#4dffae' : player.health > 25 ? '#ffbf4d' : '#ff4d7a';
      ctx.fillRect(barX, barY, (player.health / 100) * barWidth, barHeight);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.font = '12px "Roboto Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(player.name, px, py - PLAYER_RADIUS - 26);
    });

    if (this.players.player && this.players.player.alive) {
      const pointerX = this.input.pointer.x;
      const pointerY = this.input.pointer.y;
      ctx.save();
      ctx.strokeStyle = 'rgba(77, 246, 255, 0.85)';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(77, 246, 255, 0.6)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(pointerX, pointerY, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pointerX - 10, pointerY);
      ctx.lineTo(pointerX + 10, pointerY);
      ctx.moveTo(pointerX, pointerY - 10);
      ctx.lineTo(pointerX, pointerY + 10);
      ctx.stroke();
      ctx.restore();
    }
  }
}
