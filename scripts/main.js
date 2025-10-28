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
const serverUrlInput = document.getElementById('server-url');
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
const notificationsRoot = document.getElementById('notifications');

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

// Helper functions to get current API configuration
function getServerUrlFromInput() {
  const value = serverUrlInput?.value;
  return typeof value === 'string' ? value.trim() : '';
}

function getApiBaseUrl() {
  const serverUrl = getServerUrlFromInput();
  if (serverUrl) {
    return serverUrl.replace(/\/$/, ''); // Remove trailing slash
  }
  if (window.CROSSLINE_API_URL) {
    return window.CROSSLINE_API_URL;
  }
  return window.location.origin;
}

function getWsBaseUrl() {
  const serverUrl = getServerUrlFromInput();
  if (serverUrl) {
    try {
      const url = new URL(serverUrl);
      const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${url.host}`;
    } catch (error) {
      console.warn('Invalid server URL, falling back to current host:', error);
      // Fall through to default behavior
    }
  }
  if (window.CROSSLINE_WS_URL) {
    return window.CROSSLINE_WS_URL;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

const notifier = createNotifier(notificationsRoot);
const ROOMS_ERROR_COOLDOWN = 4000;
let lastRoomsErrorAt = 0;

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

function createNotifier(container) {
  if (!container) {
    return {
      show() {},
      info() {},
      success() {},
      warning() {},
      error() {},
    };
  }
  const icons = {
    info: '🛈',
    success: '✔',
    warning: '⚠',
    error: '✖',
  };

  const show = (type, message, { timeout = 5000 } = {}) => {
    const node = document.createElement('div');
    node.className = `notification notification--${type}`;
    node.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const icon = document.createElement('span');
    icon.className = 'notification__icon';
    icon.textContent = icons[type] || icons.info;

    const body = document.createElement('div');
    body.className = 'notification__body';
    body.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'notification__close';
    closeBtn.setAttribute('aria-label', 'Закрыть уведомление');
    closeBtn.innerHTML = '&times;';

    let hideTimer = null;

    const close = () => {
      if (node.dataset.state === 'closing') return;
      node.dataset.state = 'closing';
    };

    if (timeout > 0) {
      hideTimer = setTimeout(close, timeout);
    }

    node.addEventListener('mouseenter', () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    });

    node.addEventListener('mouseleave', () => {
      if (timeout > 0 && !hideTimer && node.dataset.state !== 'closing') {
        hideTimer = setTimeout(close, 1600);
      }
    });

    closeBtn.addEventListener('click', close);

    node.addEventListener('animationend', (event) => {
      if (event.animationName === 'notification-out') {
        node.remove();
      }
    });

    node.append(icon, body, closeBtn);
    container.append(node);
    return { close };
  };

  return {
    show,
    info(message, options) {
      return show('info', message, options);
    },
    success(message, options) {
      return show('success', message, options);
    },
    warning(message, options) {
      return show('warning', message, options);
    },
    error(message, options) {
      return show('error', message, options);
    },
  };
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
    const response = await fetch(`${getApiBaseUrl()}/rooms`, { cache: 'no-store' });
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
    const now = Date.now();
    if (now - lastRoomsErrorAt > ROOMS_ERROR_COOLDOWN) {
      notifier.error('Не удалось получить список комнат. Проверьте сервер или туннель.', { timeout: 6000 });
      lastRoomsErrorAt = now;
    }
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
    const response = await fetch(`${getApiBaseUrl()}/rooms`, {
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
    notifier.success(`Комната «${room.name}» готова к старту.`, { timeout: 5000 });
  } catch (error) {
    console.error('Create room error', error);
    notifier.error('Не удалось создать комнату. Проверьте сервер.');
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
    notifier.warning('Сначала выберите комнату или создайте новую арену.');
    return;
  }
  stopCurrentGame();
  toggleView(true);
  ui.reset();
  state.currentMode = 'online';
  const name = sanitizeName(playerNameInput.value || '');
  const game = new OnlineGame({ canvas, inputState, ui, wsBaseUrl: getWsBaseUrl() });
  state.currentGame = game;
  try {
    await game.start({ roomId: state.selectedRoomId, playerName: name });
    ui.setMode('online', state.selectedRoomId);
    const roomTitle = state.selectedRoomElement?.querySelector('.room-card__title')?.textContent?.trim();
    notifier.success(`Вы подключены к комнате ${roomTitle ? `«${roomTitle}»` : state.selectedRoomId}.`, { timeout: 5200 });
  } catch (error) {
    console.error('Online game failed', error);
    ui.setStatus('Ошибка подключения', 'error');
    notifier.error('Не удалось подключиться к комнате. Попробуйте позже.', { timeout: 6000 });
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
  notifier.info('Офлайн бой запущен. Удачной охоты!', { timeout: 4500 });
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
  notifier.info('Вы вернулись в лобби.', { timeout: 3200 });
}

function init() {
  // Load saved server URL from localStorage
  const savedServerUrl = localStorage.getItem('crossline_server_url');
  if (savedServerUrl && serverUrlInput) {
    serverUrlInput.value = savedServerUrl;
  }
  
  // Save server URL to localStorage when it changes
  if (serverUrlInput) {
    serverUrlInput.addEventListener('input', () => {
      const url = serverUrlInput.value.trim();
      if (url) {
        localStorage.setItem('crossline_server_url', url);
      } else {
        localStorage.removeItem('crossline_server_url');
      }
    });
  }
  
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
