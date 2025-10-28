const GAME_WIDTH = 960;
const GAME_HEIGHT = 540;
const MOVE_SPEED = 4.6;
const SHOT_COOLDOWN = 200;
const SHIELD_MAX_CHARGE = 3334;
const SHIELD_ARC = Math.PI * 0.9;
const SHIELD_RADIUS = 38;
const DASH_DISTANCE = 136;
const DASH_TRAIL_DURATION = 260;
const MOVE_SEND_INTERVAL = 1000 / 60;
const WEAPON_HEAT_PER_SHOT = 0.28;
const WEAPON_HEAT_COOLDOWN_RATE = 0.0005;
const WEAPON_OVERHEAT_PENALTY_MS = 1200;
const WEAPON_HEAT_SAFE_RATIO = 0.45;

const SHIELD_COLOR_FULL_A = { r: 77, g: 246, b: 255 };
const SHIELD_COLOR_FULL_B = { r: 255, g: 44, b: 251 };
const SHIELD_COLOR_DRAINED_A = { r: 46, g: 94, b: 124 };
const SHIELD_COLOR_DRAINED_B = { r: 110, g: 60, b: 118 };

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

export class OnlineGame {
  constructor({ canvas, inputState, ui, wsBaseUrl }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.input = inputState;
    this.ui = ui;
    this.wsBaseUrl = wsBaseUrl;
    this.players = {};
    this.bullets = [];
    this.playerId = null;
    this.roomId = null;
    this.ws = null;
    this.running = false;
    this.animationId = null;
    this.lastSent = { x: null, y: null, angle: null };
    this.lastMoveSentAt = 0;
    this.lastShotAt = 0;
    this.lastFrameTime = 0;
    this.bounds = { width: GAME_WIDTH, height: GAME_HEIGHT };
    this.lastShieldSent = false;
    this.lastDashVector = { x: 1, y: 0 };
    this.dashTrails = [];
    this.previousPositions = new Map();
    this.recentDashMarks = new Map();
    this.weaponHeat = 0;
    this.weaponOverheated = false;
    this.weaponRecoveredAt = 0;
  }

  start({ roomId, playerName }) {
    this.roomId = roomId;
    this.lastSent = { x: null, y: null, angle: null };
    this.lastMoveSentAt = 0;
    this.lastShieldSent = false;
    this.lastDashVector = { x: 1, y: 0 };
    this.dashTrails = [];
    this.previousPositions.clear();
    this.recentDashMarks.clear();
    this.weaponHeat = 0;
    this.weaponOverheated = false;
    this.weaponRecoveredAt = 0;
    this.lastFrameTime = 0;
    return new Promise((resolve, reject) => {
      // Use configured wsBaseUrl if provided, otherwise use current host
      let wsUrl;
      if (this.wsBaseUrl) {
        wsUrl = `${this.wsBaseUrl}/?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(playerName)}`;
      } else {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        wsUrl = `${protocol}//${window.location.host}/?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(playerName)}`;
      }
      this.ws = new WebSocket(wsUrl);
      let resolved = false;

      this.ws.addEventListener('open', () => {
        this.ui.setStatus('Соединение установлено', 'success');
      });

      this.ws.addEventListener('message', (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'init') {
          this.playerId = data.playerId;
          if (data.constants && data.constants.width && data.constants.height) {
            this.bounds.width = data.constants.width;
            this.bounds.height = data.constants.height;
          }
          if (!resolved) {
            resolved = true;
            resolve();
          }
          this.running = true;
          this.loop();
        } else if (data.type === 'gameState') {
          this.handleGameState(data);
        } else if (data.type === 'error') {
          this.ui.setStatus(data.message || 'Ошибка сервера', 'error');
        }
      });

      this.ws.addEventListener('close', () => {
        if (!resolved) {
          reject(new Error('Соединение закрыто'));
          resolved = true;
        }
        this.ui.setStatus('Соединение закрыто', 'error');
        this.stop();
      });

      this.ws.addEventListener('error', (error) => {
        console.error('WebSocket error', error);
        if (!resolved) {
          reject(error);
          resolved = true;
        }
        this.ui.setStatus('Ошибка сети', 'error');
      });
    });
  }

  stop() {
    this.running = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
    this.weaponHeat = 0;
    this.weaponOverheated = false;
    this.weaponRecoveredAt = 0;
    this.lastFrameTime = 0;
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
    const player = this.players[this.playerId];
    if (!player || !player.alive || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const now = performance.now();
    const wasOverheated = this.weaponOverheated;
    this.weaponHeat = Math.max(0, this.weaponHeat - delta * WEAPON_HEAT_COOLDOWN_RATE);
    if (this.weaponOverheated && this.weaponHeat <= WEAPON_HEAT_SAFE_RATIO && now >= this.weaponRecoveredAt) {
      this.weaponOverheated = false;
      if (wasOverheated) {
        this.ui.setStatus('Оружие остыло', 'success');
      }
    }

    const analogX = this.input.moveVector.x;
    const analogY = this.input.moveVector.y;
    let moveX = 0;
    let moveY = 0;
    if (this.input.keys.has('a')) moveX -= 1;
    if (this.input.keys.has('d')) moveX += 1;
    if (this.input.keys.has('w')) moveY -= 1;
    if (this.input.keys.has('s')) moveY += 1;
    moveX += analogX;
    moveY += analogY;

    let newX = player.x;
    let newY = player.y;
    const magnitude = Math.hypot(moveX, moveY);
    if (magnitude > 0.01) {
      const speed = MOVE_SPEED * Math.min(1, magnitude);
      newX += (moveX / magnitude) * speed;
      newY += (moveY / magnitude) * speed;
    }
    newX = Math.max(15, Math.min(this.bounds.width - 15, newX));
    newY = Math.max(15, Math.min(this.bounds.height - 15, newY));

    const scaleX = this.bounds.width / this.canvas.width;
    const scaleY = this.bounds.height / this.canvas.height;
    let pointerCanvasX = this.input.pointer.x;
    let pointerCanvasY = this.input.pointer.y;
    if (this.input.aimVector.active) {
      const aimDistance = 180;
      const aimX = player.x + this.input.aimVector.x * aimDistance;
      const aimY = player.y + this.input.aimVector.y * aimDistance;
      pointerCanvasX = Math.max(0, Math.min(this.canvas.width, aimX * (this.canvas.width / this.bounds.width)));
      pointerCanvasY = Math.max(0, Math.min(this.canvas.height, aimY * (this.canvas.height / this.bounds.height)));
      this.input.pointer.x = pointerCanvasX;
      this.input.pointer.y = pointerCanvasY;
    }
    const pointerX = pointerCanvasX * scaleX;
    const pointerY = pointerCanvasY * scaleY;
    const angle = Math.atan2(pointerY - player.y, pointerX - player.x);

    if (magnitude > 0.01) {
      this.lastDashVector = { x: moveX / magnitude, y: moveY / magnitude };
    }

    const positionChanged =
      this.lastSent.x === null ||
      Math.abs(newX - this.lastSent.x) > 0.25 ||
      Math.abs(newY - this.lastSent.y) > 0.25;
    const angleChanged = this.lastSent.angle === null || Math.abs(angle - this.lastSent.angle) > 0.01;
    if ((positionChanged || angleChanged) && now - this.lastMoveSentAt >= MOVE_SEND_INTERVAL) {
      this.ws.send(JSON.stringify({
        type: 'move',
        x: newX,
        y: newY,
        angle,
      }));
      this.lastSent = { x: newX, y: newY, angle };
      this.lastMoveSentAt = now;
    }

    if (
      this.input.fire &&
      !this.input.shield &&
      !player.shieldActive &&
      now - this.lastShotAt > SHOT_COOLDOWN &&
      !this.weaponOverheated &&
      this.weaponHeat < 1
    ) {
      this.ws.send(JSON.stringify({ type: 'shoot' }));
      this.lastShotAt = now;
      this.weaponHeat = Math.min(1, this.weaponHeat + WEAPON_HEAT_PER_SHOT);
      if (this.weaponHeat >= 1) {
        this.weaponOverheated = true;
        this.weaponRecoveredAt = now + WEAPON_OVERHEAT_PENALTY_MS;
        this.ui.setStatus('Оружие перегрелось', 'warning');
      }
    }

    const dashTriggered = this.input.consumeDashRequest();
    if (dashTriggered) {
      const startX = player.x;
      const startY = player.y;
      let dashX = this.lastDashVector.x;
      let dashY = this.lastDashVector.y;
      if (!dashX && !dashY) {
        dashX = Math.cos(angle);
        dashY = Math.sin(angle);
      }
      const length = Math.hypot(dashX, dashY) || 1;
      const dirX = dashX / length;
      const dirY = dashY / length;
      this.ws.send(JSON.stringify({ type: 'dash', dirX, dirY }));
      const predictedX = Math.max(15, Math.min(this.bounds.width - 15, player.x + dirX * DASH_DISTANCE));
      const predictedY = Math.max(15, Math.min(this.bounds.height - 15, player.y + dirY * DASH_DISTANCE));
      this.recordDashTrail(this.playerId, startX, startY, predictedX, predictedY);
      player.x = predictedX;
      player.y = predictedY;
      this.lastSent.x = predictedX;
      this.lastSent.y = predictedY;
      this.lastMoveSentAt = now;
    }

    const shieldActive = !!this.input.shield;
    if (shieldActive !== this.lastShieldSent) {
      this.ws.send(JSON.stringify({ type: 'shield', active: shieldActive }));
      this.lastShieldSent = shieldActive;
    }
  }

  recordDashTrail(playerId, fromX, fromY, toX, toY) {
    this.dashTrails.push({
      fromX,
      fromY,
      toX,
      toY,
      start: performance.now(),
    });
    if (playerId) {
      this.recentDashMarks.set(playerId, performance.now());
    }
  }

  respawn() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'respawn' }));
    }
  }

  handleGameState({ players = {}, bullets = [] }) {
    const previousSelf = this.players[this.playerId];
    const activeIds = new Set();
    const now = performance.now();
    Object.values(players).forEach((player) => {
      activeIds.add(player.id);
      const previous = this.previousPositions.get(player.id);
      if (previous && player.alive && previous.alive !== false) {
        const dx = player.x - previous.x;
        const dy = player.y - previous.y;
        const distance = Math.hypot(dx, dy);
        const recentDash = this.recentDashMarks.get(player.id);
        if (distance > DASH_DISTANCE * 0.6 && (!recentDash || now - recentDash > DASH_TRAIL_DURATION)) {
          this.recordDashTrail(player.id, previous.x, previous.y, player.x, player.y);
        }
      }
      this.previousPositions.set(player.id, { x: player.x, y: player.y, alive: player.alive });
    });
    Array.from(this.previousPositions.keys()).forEach((id) => {
      if (!activeIds.has(id)) {
        this.previousPositions.delete(id);
        this.recentDashMarks.delete(id);
      }
    });
    const currentSelf = players[this.playerId];
    const wasAlive = previousSelf ? previousSelf.alive !== false : false;
    const isAlive = currentSelf ? currentSelf.alive !== false : false;
    if (wasAlive && !isAlive) {
      this.weaponHeat = 0;
      this.weaponOverheated = false;
      this.weaponRecoveredAt = 0;
    }
    if (!wasAlive && isAlive) {
      this.weaponHeat = 0;
      this.weaponOverheated = false;
      this.weaponRecoveredAt = 0;
      this.lastShotAt = performance.now() - SHOT_COOLDOWN;
    }
    this.players = players;
    this.bullets = bullets;
    this.updateUiFromState();
  }

  updateUiFromState() {
    const player = this.players[this.playerId];
    if (player) {
      this.ui.setHealth(player.health);
      const shieldRatio = player.shieldCharge != null ? player.shieldCharge / SHIELD_MAX_CHARGE : 0;
      this.ui.setShield(shieldRatio, !!player.shieldActive);
      this.ui.setDash(player.dashCharge != null ? player.dashCharge : 0);
      this.ui.toggleRespawn(!player.alive);
      this.ui.setRespawnEnabled(true);
    } else {
      this.ui.setHealth(0);
      this.ui.setShield(0, false);
      this.ui.setDash(0);
      this.ui.toggleRespawn(false);
    }
    const entries = Object.values(this.players).map((p) => ({
      id: p.id,
      name: p.name || p.id?.slice(0, 5),
      score: p.score || 0,
      isSelf: p.id === this.playerId,
    }));
    this.ui.setScoreboard(entries);
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const scaleX = this.canvas.width / this.bounds.width;
    const scaleY = this.canvas.height / this.bounds.height;

    const gradient = ctx.createLinearGradient(0, 0, this.canvas.width, this.canvas.height);
    gradient.addColorStop(0, '#050812');
    gradient.addColorStop(0.45, '#08142b');
    gradient.addColorStop(1, '#03040b');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = 'rgba(77, 246, 255, 0.1)';
    ctx.lineWidth = 1;
    for (let x = 0; x < this.bounds.width; x += 80) {
      ctx.beginPath();
      ctx.moveTo(x * scaleX, 0);
      ctx.lineTo(x * scaleX, this.canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < this.bounds.height; y += 80) {
      ctx.beginPath();
      ctx.moveTo(0, y * scaleY);
      ctx.lineTo(this.canvas.width, y * scaleY);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    const sweep = (performance.now() % 4200) / 4200;
    const sweepX = sweep * this.canvas.width;
    ctx.fillStyle = 'rgba(255, 44, 251, 0.12)';
    ctx.fillRect(sweepX, 0, 3, this.canvas.height);
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
      gradient.addColorStop(0, colorToRgba(SHIELD_COLOR_FULL_A, 0.5 * (1 - t) + 0.2));
      gradient.addColorStop(1, colorToRgba(SHIELD_COLOR_FULL_B, 0.4 * (1 - t) + 0.15));
      ctx.save();
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 20 * (1 - t) + 6;
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(77, 246, 255, 0.45)';
      ctx.shadowBlur = 16 * (1 - t);
      ctx.globalAlpha = 0.85 * (1 - t);
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
      const color = '#fffb7a';
      ctx.save();
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(bx, by, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 251, 122, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - Math.cos(bullet.angle) * 12, by - Math.sin(bullet.angle) * 12);
      ctx.stroke();
      ctx.restore();
    });

    Object.values(this.players).forEach((player) => {
      if (!player.alive) {
        ctx.save();
        ctx.fillStyle = 'rgba(255, 77, 122, 0.18)';
        ctx.beginPath();
        ctx.arc(player.x * scaleX, player.y * scaleY, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return;
      }
      const isSelf = player.id === this.playerId;
      const px = player.x * scaleX;
      const py = player.y * scaleY;
      const color = isSelf ? '#4df6ff' : '#ff2cfb';
      if (player.shieldActive && player.shieldCharge > 0) {
        const shieldRatio = Math.max(0, Math.min(1, player.shieldCharge / SHIELD_MAX_CHARGE));
        const colors = getShieldColors(shieldRatio);
        ctx.save();
        ctx.globalAlpha = 0.3 + shieldRatio * 0.4;
        ctx.fillStyle = colorToRgba(colors.secondary, 0.2 + shieldRatio * 0.25);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.arc(px, py, SHIELD_RADIUS, player.angle - SHIELD_ARC / 2, player.angle + SHIELD_ARC / 2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = colorToRgba(colors.primary, isSelf ? 0.9 : 0.8);
        ctx.lineWidth = 5.5;
        ctx.shadowColor = colorToRgba(colors.primary, 0.65);
        ctx.shadowBlur = 14 + shieldRatio * 6;
        ctx.beginPath();
        ctx.arc(px, py, SHIELD_RADIUS, player.angle - SHIELD_ARC / 2, player.angle + SHIELD_ARC / 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.arc(px, py, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(player.angle) * 20, py + Math.sin(player.angle) * 20);
      ctx.stroke();
      ctx.restore();

      const barWidth = 34;
      const barHeight = 6;
      const barX = px - barWidth / 2;
      const barY = py - 26;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(barX, barY, barWidth, barHeight);
      ctx.fillStyle = player.health > 50 ? '#4dffae' : player.health > 25 ? '#ffbf4d' : '#ff4d7a';
      ctx.fillRect(barX, barY, (player.health / 100) * barWidth, barHeight);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.font = '12px "Roboto Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(player.name || player.id.slice(0, 5), px, py - 32);
    });

    const me = this.players[this.playerId];
    if (me && me.alive) {
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
      ctx.moveTo(pointerX - 12, pointerY);
      ctx.lineTo(pointerX + 12, pointerY);
      ctx.moveTo(pointerX, pointerY - 12);
      ctx.lineTo(pointerX, pointerY + 12);
      ctx.stroke();
      ctx.restore();
    }
  }
}
