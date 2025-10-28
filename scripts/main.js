import { OnlineGame } from './game-online.js';
import { OfflineGame } from './game-offline.js';

const lobby = document.getElementById('lobby');
const gameStage = document.getElementById('game-stage');
const roomsList = document.getElementById('rooms-list');
const refreshRoomsBtn = document.getElementById('refresh-rooms');
const createRoomForm = document.getElementById('create-room-form');
const roomNameInput = document.getElementById('room-name');
const playOnlineBtn = document.getElementById('play-online');
const playOfflineBtn = document.getElementById('play-offline');
const difficultySelect = document.getElementById('offline-difficulty');
const playerNameInput = document.getElementById('player-name');
const canvas = document.getElementById('game-canvas');
const modeLabel = document.getElementById('mode-label');
const statusText = document.getElementById('status-text');
const healthFill = document.getElementById('health-fill');
const healthValue = document.getElementById('health-value');
const scoreboard = document.getElementById('scoreboard');
const leaveGameBtn = document.getElementById('leave-game');
const respawnOverlay = document.getElementById('respawn-overlay');
const respawnBtn = document.getElementById('respawn-btn');
const mobileControls = document.getElementById('mobile-controls');
const mobileFire = document.getElementById('mobile-fire');
const roomTemplate = document.getElementById('room-template');

const inputState = {
  keys: new Set(),
  pointer: { x: canvas.width / 2, y: canvas.height / 2 },
  fire: false,
};

const state = {
  selectedRoomId: null,
  selectedRoomElement: null,
  currentGame: null,
  currentMode: null,
};

const ui = {
  reset() {
    modeLabel.textContent = '—';
    statusText.textContent = 'загрузка…';
    statusText.dataset.state = 'neutral';
    updateHealthBar(100);
    updateScoreboard([]);
    respawnOverlay.classList.add('hidden');
    respawnBtn.disabled = false;
  },
  setMode(mode, subtitle = '') {
    modeLabel.textContent = mode;
    if (subtitle) {
      modeLabel.dataset.subtitle = subtitle;
    } else {
      delete modeLabel.dataset.subtitle;
    }
  },
  setStatus(text, stateName = 'neutral') {
    statusText.textContent = text;
    statusText.dataset.state = stateName;
  },
  setHealth(value) {
    updateHealthBar(value);
  },
  setScoreboard(entries) {
    updateScoreboard(entries);
  },
  toggleRespawn(show) {
    respawnOverlay.classList.toggle('hidden', !show);
  },
  setRespawnEnabled(enabled) {
    respawnBtn.disabled = !enabled;
  },
};

function updateHealthBar(value) {
  const clamped = Math.max(0, Math.min(100, value));
  healthFill.style.width = `${clamped}%`;
  healthValue.textContent = Math.round(clamped).toString();
  if (clamped < 30) {
    healthFill.style.background = 'linear-gradient(120deg, #ff4d7a, #ff2cfb)';
  } else if (clamped < 60) {
    healthFill.style.background = 'linear-gradient(120deg, #ffbf4d, #ff784d)';
  } else {
    healthFill.style.background = 'linear-gradient(120deg, var(--accent), var(--accent-strong))';
  }
}

function updateScoreboard(entries) {
  scoreboard.innerHTML = '';
  entries
    .sort((a, b) => b.score - a.score)
    .forEach((entry) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      const score = document.createElement('span');
      name.textContent = entry.isSelf ? `${entry.name || 'You'} · you` : entry.name || 'Pilot';
      if (entry.isSelf) {
        name.style.color = 'var(--accent)';
      }
      score.textContent = entry.score.toString().padStart(2, '0');
      li.append(name, score);
      scoreboard.append(li);
    });
  if (!entries.length) {
    const li = document.createElement('li');
    li.textContent = 'Нет активных пилотов';
    scoreboard.append(li);
  }
}

function sanitizeName(value) {
  const clean = value.trim().replace(/[^a-zA-Z0-9а-яА-Я_\- ]/g, '');
  if (clean) {
    return clean.slice(0, 16);
  }
  return `Pilot-${Math.random().toString(16).slice(2, 6)}`;
}

function toggleView(inGame) {
  if (inGame) {
    lobby.classList.add('hidden');
    gameStage.classList.remove('hidden');
    resizeCanvas();
    centerPointer();
  } else {
    lobby.classList.remove('hidden');
    gameStage.classList.add('hidden');
  }
}

function centerPointer() {
  inputState.pointer.x = canvas.width / 2;
  inputState.pointer.y = canvas.height / 2;
}

async function loadRooms() {
  roomsList.innerHTML = '<p class="room-card__meta">Загрузка комнат…</p>';
  playOnlineBtn.disabled = true;
  state.selectedRoomId = null;
  state.selectedRoomElement = null;
  try {
    const response = await fetch('/rooms', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const rooms = await response.json();
    roomsList.innerHTML = '';
    if (!rooms.length) {
      const empty = document.createElement('p');
      empty.className = 'room-card__meta';
      empty.textContent = 'Комнат пока нет. Создайте свою!';
      roomsList.append(empty);
      return;
    }
    rooms.forEach((room) => {
      const node = roomTemplate.content.firstElementChild.cloneNode(true);
      const title = node.querySelector('.room-card__title');
      const meta = node.querySelector('.room-card__meta');
      const joinBtn = node.querySelector('.room-card__join');
      title.textContent = room.name;
      meta.textContent = `${room.players}/${room.maxPlayers} • ${room.status}`;
      joinBtn.addEventListener('click', () => {
        selectRoom(room.id, node);
      });
      node.addEventListener('click', (event) => {
        if (event.target === joinBtn) return;
        selectRoom(room.id, node);
      });
      roomsList.append(node);
    });
  } catch (error) {
    console.error('Failed to load rooms', error);
    roomsList.innerHTML = '';
    const fail = document.createElement('p');
    fail.className = 'room-card__meta';
    fail.textContent = 'Не удалось получить список комнат.';
    roomsList.append(fail);
  }
}

function selectRoom(roomId, element) {
  state.selectedRoomId = roomId;
  playOnlineBtn.disabled = false;
  if (state.selectedRoomElement) {
    state.selectedRoomElement.classList.remove('room-card--selected');
  }
  state.selectedRoomElement = element;
  element.classList.add('room-card--selected');
}

async function handleCreateRoom(event) {
  event.preventDefault();
  const name = roomNameInput.value.trim();
  try {
    const response = await fetch('/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || 'Не удалось создать комнату');
    }
    const room = await response.json();
    roomNameInput.value = '';
    await loadRooms();
    const created = Array.from(roomsList.querySelectorAll('.room-card')).find((el) => {
      const title = el.querySelector('.room-card__title');
      return title && title.textContent === room.name;
    });
    if (created) {
      selectRoom(room.id, created);
      created.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch (error) {
    console.error('Create room error', error);
    alert('Не удалось создать комнату. Проверьте сервер.');
  }
}

function resetInputState() {
  inputState.keys.clear();
  inputState.fire = false;
  centerPointer();
}

function attachInputListeners() {
  document.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    if (['w', 'a', 's', 'd'].includes(key)) {
      inputState.keys.add(key);
    }
  });
  document.addEventListener('keyup', (event) => {
    const key = event.key.toLowerCase();
    if (['w', 'a', 's', 'd'].includes(key)) {
      inputState.keys.delete(key);
    }
  });
  canvas.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect();
    inputState.pointer.x = event.clientX - rect.left;
    inputState.pointer.y = event.clientY - rect.top;
  });
  canvas.addEventListener('mousedown', () => {
    inputState.fire = true;
  });
  document.addEventListener('mouseup', () => {
    inputState.fire = false;
  });
  canvas.addEventListener('touchstart', (event) => {
    if (event.cancelable) {
      event.preventDefault();
    }
    const touch = event.changedTouches[0];
    const rect = canvas.getBoundingClientRect();
    inputState.pointer.x = touch.clientX - rect.left;
    inputState.pointer.y = touch.clientY - rect.top;
    inputState.fire = true;
  }, { passive: false });
  canvas.addEventListener('touchmove', (event) => {
    if (event.cancelable) {
      event.preventDefault();
    }
    const touch = event.changedTouches[0];
    const rect = canvas.getBoundingClientRect();
    inputState.pointer.x = touch.clientX - rect.left;
    inputState.pointer.y = touch.clientY - rect.top;
  }, { passive: false });
  canvas.addEventListener('touchend', (event) => {
    if (event.cancelable) {
      event.preventDefault();
    }
    inputState.fire = false;
  }, { passive: false });
}

function attachMobileControls() {
  if (!mobileControls) return;
  mobileControls.querySelectorAll('.mobile-key').forEach((btn) => {
    const key = btn.dataset.key;
    const activate = () => inputState.keys.add(key);
    const deactivate = () => inputState.keys.delete(key);
    btn.addEventListener('touchstart', (event) => {
      if (event.cancelable) event.preventDefault();
      activate();
    }, { passive: false });
    btn.addEventListener('touchend', (event) => {
      if (event.cancelable) event.preventDefault();
      deactivate();
    }, { passive: false });
    btn.addEventListener('touchcancel', deactivate);
  });
  mobileFire.addEventListener('touchstart', (event) => {
    if (event.cancelable) event.preventDefault();
    inputState.fire = true;
  }, { passive: false });
  mobileFire.addEventListener('touchend', (event) => {
    if (event.cancelable) event.preventDefault();
    inputState.fire = false;
  }, { passive: false });
  mobileFire.addEventListener('touchcancel', () => {
    inputState.fire = false;
  });
}

function resizeCanvas() {
  const ratio = 16 / 9;
  const wrapperWidth = canvas.parentElement ? canvas.parentElement.clientWidth : canvas.clientWidth;
  const width = Math.max(wrapperWidth, 320);
  canvas.width = width;
  canvas.height = width / ratio;
}

window.addEventListener('resize', () => {
  if (!gameStage.classList.contains('hidden')) {
    resizeCanvas();
  }
});

async function startOnlineGame() {
  if (!state.selectedRoomId) {
    alert('Выберите комнату.');
    return;
  }
  stopCurrentGame();
  toggleView(true);
  ui.reset();
  state.currentMode = 'online';
  const name = sanitizeName(playerNameInput.value || '');
  const game = new OnlineGame({ canvas, inputState, ui });
  state.currentGame = game;
  try {
    await game.start({ roomId: state.selectedRoomId, playerName: name });
    ui.setMode('online', state.selectedRoomId);
  } catch (error) {
    console.error('Online game failed', error);
    ui.setStatus('Ошибка подключения', 'error');
  }
}

function startOfflineGame() {
  stopCurrentGame();
  toggleView(true);
  ui.reset();
  state.currentMode = 'offline';
  const difficulty = difficultySelect.value;
  const game = new OfflineGame({ canvas, inputState, ui });
  state.currentGame = game;
  game.start({ difficulty, playerName: sanitizeName(playerNameInput.value || '') });
  ui.setMode('offline', difficulty);
  ui.setStatus('Вы против синтетика', 'success');
}

function stopCurrentGame() {
  if (state.currentGame && typeof state.currentGame.stop === 'function') {
    state.currentGame.stop();
  }
  state.currentGame = null;
  state.currentMode = null;
  resetInputState();
}

function returnToLobby() {
  stopCurrentGame();
  toggleView(false);
  ui.reset();
}

function init() {
  attachInputListeners();
  attachMobileControls();
  refreshRoomsBtn.addEventListener('click', loadRooms);
  createRoomForm.addEventListener('submit', handleCreateRoom);
  playOnlineBtn.addEventListener('click', startOnlineGame);
  playOfflineBtn.addEventListener('click', startOfflineGame);
  leaveGameBtn.addEventListener('click', returnToLobby);
  respawnBtn.addEventListener('click', () => {
    if (state.currentGame && typeof state.currentGame.respawn === 'function') {
      state.currentGame.respawn();
    }
  });
  loadRooms();
}

init();
