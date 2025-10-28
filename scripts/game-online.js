const GAME_WIDTH = 960;
const GAME_HEIGHT = 540;
const MOVE_SPEED = 4.6;
const SHOT_COOLDOWN = 200;

export class OnlineGame {
  constructor({ canvas, inputState, ui }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.input = inputState;
    this.ui = ui;
    this.players = {};
    this.bullets = [];
    this.playerId = null;
    this.roomId = null;
    this.ws = null;
    this.running = false;
    this.animationId = null;
    this.lastSent = { x: null, y: null, angle: null };
    this.lastShotAt = 0;
    this.bounds = { width: GAME_WIDTH, height: GAME_HEIGHT };
  }

  start({ roomId, playerName }) {
    this.roomId = roomId;
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${protocol}//${window.location.host}/?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(playerName)}`;
      this.ws = new WebSocket(url);
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
          this.players = data.players || {};
          this.bullets = data.bullets || [];
          this.updateUiFromState();
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
  }

  loop() {
    if (!this.running) return;
    this.update();
    this.render();
    this.animationId = requestAnimationFrame(() => this.loop());
  }

  update() {
    const player = this.players[this.playerId];
    if (!player || !player.alive || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const speed = MOVE_SPEED;
    let moveX = 0;
    let moveY = 0;
    if (this.input.keys.has('a')) moveX -= 1;
    if (this.input.keys.has('d')) moveX += 1;
    if (this.input.keys.has('w')) moveY -= 1;
    if (this.input.keys.has('s')) moveY += 1;

    let newX = player.x;
    let newY = player.y;
    if (moveX !== 0 || moveY !== 0) {
      const length = Math.hypot(moveX, moveY) || 1;
      newX += (moveX / length) * speed;
      newY += (moveY / length) * speed;
      newX = Math.max(15, Math.min(this.bounds.width - 15, newX));
      newY = Math.max(15, Math.min(this.bounds.height - 15, newY));
    }

    const scaleX = this.bounds.width / this.canvas.width;
    const scaleY = this.bounds.height / this.canvas.height;
    const pointerX = this.input.pointer.x * scaleX;
    const pointerY = this.input.pointer.y * scaleY;
    const angle = Math.atan2(pointerY - player.y, pointerX - player.x);

    if (
      newX !== this.lastSent.x ||
      newY !== this.lastSent.y ||
      angle !== this.lastSent.angle
    ) {
      this.ws.send(JSON.stringify({
        type: 'move',
        x: newX,
        y: newY,
        angle,
      }));
      this.lastSent = { x: newX, y: newY, angle };
    }

    const now = performance.now();
    if (this.input.fire && now - this.lastShotAt > SHOT_COOLDOWN) {
      this.ws.send(JSON.stringify({ type: 'shoot' }));
      this.lastShotAt = now;
    }
  }

  respawn() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'respawn' }));
    }
  }

  updateUiFromState() {
    const player = this.players[this.playerId];
    if (player) {
      this.ui.setHealth(player.health);
      this.ui.toggleRespawn(!player.alive);
      this.ui.setRespawnEnabled(true);
    } else {
      this.ui.setHealth(0);
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

    ctx.fillStyle = '#070912';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.strokeStyle = 'rgba(77, 246, 255, 0.08)';
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

    this.bullets.forEach((bullet) => {
      const bx = bullet.x * scaleX;
      const by = bullet.y * scaleY;
      ctx.fillStyle = '#fffb7a';
      ctx.beginPath();
      ctx.arc(bx, by, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 251, 122, 0.5)';
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - Math.cos(bullet.angle) * 12, by - Math.sin(bullet.angle) * 12);
      ctx.stroke();
    });

    Object.values(this.players).forEach((player) => {
      if (!player.alive) {
        ctx.fillStyle = 'rgba(255, 77, 122, 0.18)';
        ctx.beginPath();
        ctx.arc(player.x * scaleX, player.y * scaleY, 16, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      const isSelf = player.id === this.playerId;
      const px = player.x * scaleX;
      const py = player.y * scaleY;
      ctx.fillStyle = isSelf ? '#4df6ff' : '#ff2cfb';
      ctx.beginPath();
      ctx.arc(px, py, 14, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(player.angle) * 20, py + Math.sin(player.angle) * 20);
      ctx.stroke();

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
      ctx.strokeStyle = 'rgba(77, 246, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pointerX, pointerY, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pointerX - 12, pointerY);
      ctx.lineTo(pointerX + 12, pointerY);
      ctx.moveTo(pointerX, pointerY - 12);
      ctx.lineTo(pointerX, pointerY + 12);
      ctx.stroke();
    }
  }
}
