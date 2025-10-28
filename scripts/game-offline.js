const GAME_WIDTH = 960;
const GAME_HEIGHT = 540;
const PLAYER_RADIUS = 16;
const BULLET_RADIUS = 4;
const MOVE_SPEED = 4.2;
const BULLET_SPEED = 9;
const DAMAGE = 22;

const BOT_DIFFICULTY = {
  easy: { speed: 2.6, fireRate: 650, accuracy: 0.6 },
  normal: { speed: 3.2, fireRate: 480, accuracy: 0.75 },
  hard: { speed: 3.9, fireRate: 360, accuracy: 0.9 },
};

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
  }

  start({ difficulty = 'normal', playerName = 'Pilot' }) {
    this.settings = BOT_DIFFICULTY[difficulty] || BOT_DIFFICULTY.normal;
    this.playerName = playerName || 'Pilot';
    this.resetState();
    this.running = true;
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
      },
    };
    this.bullets = [];
    this.lastShotAt = 0;
    this.botShotAt = 0;
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
  }

  spawnBot(bot) {
    bot.x = GAME_WIDTH * 0.75;
    bot.y = GAME_HEIGHT * 0.5;
    bot.health = 100;
    bot.alive = true;
  }

  loop() {
    if (!this.running) return;
    this.update();
    this.render();
    this.animationId = requestAnimationFrame(() => this.loop());
  }

  update() {
    const player = this.players.player;
    const bot = this.players.bot;
    if (!player || !bot) return;

    if (player.alive) {
      this.updatePlayer(player);
    }
    if (bot.alive) {
      this.updateBot(bot, player);
    }

    this.updateBullets();
    this.updateUi();
  }

  updatePlayer(player) {
    let moveX = 0;
    let moveY = 0;
    if (this.input.keys.has('a')) moveX -= 1;
    if (this.input.keys.has('d')) moveX += 1;
    if (this.input.keys.has('w')) moveY -= 1;
    if (this.input.keys.has('s')) moveY += 1;
    if (moveX !== 0 || moveY !== 0) {
      const length = Math.hypot(moveX, moveY) || 1;
      player.x += (moveX / length) * MOVE_SPEED;
      player.y += (moveY / length) * MOVE_SPEED;
    }
    player.x = Math.max(PLAYER_RADIUS, Math.min(GAME_WIDTH - PLAYER_RADIUS, player.x));
    player.y = Math.max(PLAYER_RADIUS, Math.min(GAME_HEIGHT - PLAYER_RADIUS, player.y));

    const scaleX = GAME_WIDTH / this.canvas.width;
    const scaleY = GAME_HEIGHT / this.canvas.height;
    const targetX = this.input.pointer.x * scaleX;
    const targetY = this.input.pointer.y * scaleY;
    player.angle = Math.atan2(targetY - player.y, targetX - player.x);

    const now = performance.now();
    if (this.input.fire && now - this.lastShotAt > 220 && player.alive) {
      this.spawnBullet(player);
      this.lastShotAt = now;
    }
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

    ctx.fillStyle = '#060812';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.strokeStyle = 'rgba(77, 246, 255, 0.1)';
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

    this.bullets.forEach((bullet) => {
      const bx = bullet.x * scaleX;
      const by = bullet.y * scaleY;
      ctx.fillStyle = bullet.owner === 'player' ? '#4df6ff' : '#ff4d7a';
      ctx.beginPath();
      ctx.arc(bx, by, 4, 0, Math.PI * 2);
      ctx.fill();
    });

    Object.values(this.players).forEach((player) => {
      const px = player.x * scaleX;
      const py = player.y * scaleY;
      ctx.fillStyle = player.id === 'player' ? '#4df6ff' : '#ff2cfb';
      ctx.globalAlpha = player.alive ? 1 : 0.2;
      ctx.beginPath();
      ctx.arc(px, py, PLAYER_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(player.angle) * 22, py + Math.sin(player.angle) * 22);
      ctx.stroke();

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
      ctx.strokeStyle = 'rgba(77, 246, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pointerX, pointerY, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pointerX - 10, pointerY);
      ctx.lineTo(pointerX + 10, pointerY);
      ctx.moveTo(pointerX, pointerY - 10);
      ctx.lineTo(pointerX, pointerY + 10);
      ctx.stroke();
    }
  }
}
