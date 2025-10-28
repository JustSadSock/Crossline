// Game configuration
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const GAME_WIDTH = 800;
const GAME_HEIGHT = 600;
const PLAYER_SIZE = 30;
const BULLET_SIZE = 5;
const MOVE_SPEED = 5;

// Game state
let playerId = null;
let players = {};
let bullets = [];
let keys = {};
let mouseX = 0;
let mouseY = 0;
let mouseAngle = 0;
let lastShotTime = 0;
const SHOT_COOLDOWN = 200; // milliseconds

// UI elements
const healthFill = document.getElementById('health-fill');
const scoreValue = document.getElementById('score-value');
const statusValue = document.getElementById('status-value');
const respawnScreen = document.getElementById('respawn-screen');
const respawnBtn = document.getElementById('respawn-btn');

// WebSocket connection
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}`);

ws.onopen = () => {
  console.log('Connected to server');
  statusValue.textContent = 'Connected';
  statusValue.style.color = '#00ff00';
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.type === 'init') {
    playerId = data.playerId;
    console.log('Player ID:', playerId);
  } else if (data.type === 'gameState') {
    players = data.players;
    bullets = data.bullets;
    
    // Update UI for current player
    if (playerId && players[playerId]) {
      const player = players[playerId];
      const healthPercent = (player.health / 100) * 100;
      healthFill.style.width = healthPercent + '%';
      scoreValue.textContent = player.score;
      
      // Show respawn screen if dead
      if (!player.alive) {
        respawnScreen.style.display = 'block';
      } else {
        respawnScreen.style.display = 'none';
      }
    }
  }
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
  statusValue.textContent = 'Connection Error';
  statusValue.style.color = '#ff0000';
};

ws.onclose = () => {
  console.log('Disconnected from server');
  statusValue.textContent = 'Disconnected';
  statusValue.style.color = '#ff0000';
};

// Input handling
document.addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
});

document.addEventListener('keyup', (e) => {
  keys[e.key.toLowerCase()] = false;
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;
  
  if (playerId && players[playerId]) {
    const player = players[playerId];
    const dx = mouseX - player.x;
    const dy = mouseY - player.y;
    mouseAngle = Math.atan2(dy, dx);
  }
});

canvas.addEventListener('click', () => {
  const now = Date.now();
  if (playerId && players[playerId] && players[playerId].alive && now - lastShotTime > SHOT_COOLDOWN) {
    ws.send(JSON.stringify({
      type: 'shoot'
    }));
    lastShotTime = now;
  }
});

respawnBtn.addEventListener('click', () => {
  ws.send(JSON.stringify({
    type: 'respawn'
  }));
});

// Game loop
function gameLoop() {
  // Update player position based on input
  if (playerId && players[playerId] && players[playerId].alive) {
    const player = players[playerId];
    let newX = player.x;
    let newY = player.y;
    
    if (keys['w']) newY -= MOVE_SPEED;
    if (keys['s']) newY += MOVE_SPEED;
    if (keys['a']) newX -= MOVE_SPEED;
    if (keys['d']) newX += MOVE_SPEED;
    
    // Clamp to bounds
    newX = Math.max(PLAYER_SIZE / 2, Math.min(GAME_WIDTH - PLAYER_SIZE / 2, newX));
    newY = Math.max(PLAYER_SIZE / 2, Math.min(GAME_HEIGHT - PLAYER_SIZE / 2, newY));
    
    // Send update if position changed
    if (newX !== player.x || newY !== player.y || mouseAngle !== player.angle) {
      ws.send(JSON.stringify({
        type: 'move',
        x: newX,
        y: newY,
        angle: mouseAngle
      }));
    }
  }
  
  // Render
  render();
  
  requestAnimationFrame(gameLoop);
}

function render() {
  // Clear canvas
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  
  // Draw grid
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 1;
  for (let x = 0; x < GAME_WIDTH; x += 50) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, GAME_HEIGHT);
    ctx.stroke();
  }
  for (let y = 0; y < GAME_HEIGHT; y += 50) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(GAME_WIDTH, y);
    ctx.stroke();
  }
  
  // Draw bullets
  bullets.forEach(bullet => {
    ctx.fillStyle = '#ffff00';
    ctx.beginPath();
    ctx.arc(bullet.x, bullet.y, BULLET_SIZE, 0, Math.PI * 2);
    ctx.fill();
    
    // Draw bullet trail
    ctx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bullet.x, bullet.y);
    ctx.lineTo(
      bullet.x - Math.cos(bullet.angle) * 10,
      bullet.y - Math.sin(bullet.angle) * 10
    );
    ctx.stroke();
  });
  
  // Draw players
  for (const id in players) {
    const player = players[id];
    if (!player.alive) continue;
    
    const isCurrentPlayer = id === playerId;
    
    // Draw player body
    ctx.fillStyle = isCurrentPlayer ? '#00ff00' : '#ff0000';
    ctx.beginPath();
    ctx.arc(player.x, player.y, PLAYER_SIZE / 2, 0, Math.PI * 2);
    ctx.fill();
    
    // Draw player direction indicator
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(player.x, player.y);
    ctx.lineTo(
      player.x + Math.cos(player.angle) * PLAYER_SIZE,
      player.y + Math.sin(player.angle) * PLAYER_SIZE
    );
    ctx.stroke();
    
    // Draw health bar
    const healthBarWidth = PLAYER_SIZE;
    const healthBarHeight = 5;
    const healthBarX = player.x - healthBarWidth / 2;
    const healthBarY = player.y - PLAYER_SIZE / 2 - 10;
    
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(healthBarX, healthBarY, healthBarWidth, healthBarHeight);
    
    const healthPercent = player.health / 100;
    ctx.fillStyle = healthPercent > 0.5 ? '#00ff00' : healthPercent > 0.25 ? '#ffff00' : '#ff0000';
    ctx.fillRect(healthBarX, healthBarY, healthBarWidth * healthPercent, healthBarHeight);
    
    // Draw player name/ID
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(isCurrentPlayer ? 'You' : id.substr(0, 5), player.x, player.y - PLAYER_SIZE / 2 - 15);
  }
  
  // Draw crosshair
  if (playerId && players[playerId] && players[playerId].alive) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    const crosshairSize = 10;
    
    ctx.beginPath();
    ctx.moveTo(mouseX - crosshairSize, mouseY);
    ctx.lineTo(mouseX + crosshairSize, mouseY);
    ctx.moveTo(mouseX, mouseY - crosshairSize);
    ctx.lineTo(mouseX, mouseY + crosshairSize);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.arc(mouseX, mouseY, 5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Start game loop
gameLoop();
