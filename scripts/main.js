import { OfflineGame } from './game-offline.js';
import { OnlineGame } from './game-online.js';

const lobby = document.getElementById('lobby');
const gameStage = document.getElementById('game-stage');
const playOfflineBtn = document.getElementById('play-offline');
const difficultySelect = document.getElementById('offline-difficulty');
const playerNameInput = document.getElementById('player-name');
const canvas = document.getElementById('game-canvas');
const modeLabel = document.getElementById('mode-label');
const statusText = document.getElementById('status-text');
const healthFill = document.getElementById('health-fill');
const healthValue = document.getElementById('health-value');
const shieldFill = document.getElementById('shield-fill');
const shieldValue = document.getElementById('shield-value');
const dashReady = document.getElementById('dash-ready');
const dashCharges = document.getElementById('dash-charges');
const scoreboard = document.getElementById('scoreboard');
const leaveGameBtn = document.getElementById('leave-game');
const respawnOverlay = document.getElementById('respawn-overlay');
const respawnBtn = document.getElementById('respawn-btn');
const mobileControls = document.getElementById('mobile-controls');
const mobileFire = document.getElementById('mobile-fire');
const mobileShield = document.getElementById('mobile-shield');
const mobileDash = document.getElementById('mobile-dash');
const moveJoystick = document.getElementById('move-joystick');
const aimJoystick = document.getElementById('aim-joystick');
const openControlsBtn = document.getElementById('open-controls');
const controlsDialog = document.getElementById('controls-dialog');
const closeControlsBtn = document.getElementById('close-controls');
const notificationsRoot = document.getElementById('notifications');
const onlineStatusPill = document.getElementById('online-status');
const roomList = document.getElementById('room-list');
const roomNameInput = document.getElementById('room-name');
const createRoomBtn = document.getElementById('create-room');
const refreshRoomsBtn = document.getElementById('refresh-rooms');
const joinOnlineBtn = document.getElementById('join-online');
const debugPanel = document.getElementById('debug-panel');
const debugApiOrigin = document.getElementById('debug-api-origin');
const debugWsOrigin = document.getElementById('debug-ws-origin');
const debugStatus = document.getElementById('debug-status');
const debugLastError = document.getElementById('debug-last-error');
const debugHealth = document.getElementById('debug-health');

const DEFAULT_API_ORIGIN = 'https://irgri.uk';
const DEFAULT_WS_ORIGIN = 'wss://irgri.uk';
const HEALTH_TIMEOUT_MS = 6000;
const HEALTH_RETRY_BASE_MS = 4000;
const HEALTH_SUCCESS_POLL_MS = 20000;
const HEALTH_RETRY_MAX_MS = 30000;
const WS_RECONNECT_MAX_MS = 10000;

const SHIELD_KEY_CODES = new Set(['ShiftLeft', 'ShiftRight']);
const SHIELD_KEY_FALLBACKS = new Set(['q', 'e']);

const inputState = {
  keys: new Set(),
  pointer: { x: canvas.width / 2, y: canvas.height / 2 },
  fire: false,
  shield: false,
  dashRequested: false,
  moveVector: { x: 0, y: 0 },
  aimVector: { x: 0, y: 0, active: false },
  consumeDashRequest() {
    const pending = this.dashRequested;
    this.dashRequested = false;
    return pending;
  },
};

const state = {
  currentGame: null,
  currentMode: null,
};

const onlineState = {
  available: false,
  loading: false,
  rooms: [],
  selectedRoomId: null,
  apiOrigin: '',
  wsOrigin: '',
  lastError: null,
  lastHealthStatus: '',
  healthTimer: null,
  wsState: 'idle',
  lastWsEvent: null,
  wasEverAvailable: false,
};

const dashChargeElements = dashCharges ? Array.from(dashCharges.querySelectorAll('.hud__charge')) : [];

const SHIELD_UI_FULL_A = { r: 77, g: 246, b: 255 };
const SHIELD_UI_FULL_B = { r: 255, g: 44, b: 251 };
const SHIELD_UI_DRAINED_A = { r: 48, g: 104, b: 132 };
const SHIELD_UI_DRAINED_B = { r: 120, g: 76, b: 126 };

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

function colorToCss({ r, g, b }) {
  const toHex = (value) => value.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function getShieldUiGradient(ratio) {
  const t = Math.min(1, Math.max(0, 1 - ratio));
  const start = mixColor(SHIELD_UI_FULL_A, SHIELD_UI_DRAINED_A, t);
  const end = mixColor(SHIELD_UI_FULL_B, SHIELD_UI_DRAINED_B, t);
  return { start: colorToCss(start), end: colorToCss(end) };
}

function updateShieldUi(ratio, active) {
  if (!shieldFill || !shieldValue) return;
  const clamped = Math.max(0, Math.min(1, ratio));
  const gradient = getShieldUiGradient(clamped);
  shieldFill.style.width = `${(clamped * 100).toFixed(1)}%`;
  shieldFill.style.background = `linear-gradient(120deg, ${gradient.start}, ${gradient.end})`;
  if (active) {
    shieldFill.dataset.state = 'active';
  } else if (clamped < 1) {
    shieldFill.dataset.state = 'recharging';
  } else {
    delete shieldFill.dataset.state;
  }
  shieldValue.textContent = `${Math.round(clamped * 100)}%`;
  shieldValue.style.color = gradient.end;
}

function updateDashUi(value) {
  if (!dashReady || !dashChargeElements.length) return;
  const clamped = Math.max(0, Math.min(dashChargeElements.length, value));
  dashReady.textContent = Math.floor(clamped).toString();
  dashChargeElements.forEach((node, index) => {
    const fill = Math.max(0, Math.min(1, clamped - index));
    node.style.setProperty('--fill', fill.toFixed(2));
    if (fill >= 0.99) {
      node.classList.add('hud__charge--ready');
    } else {
      node.classList.remove('hud__charge--ready');
    }
  });
}

const notifier = createNotifier(notificationsRoot);

const ui = {
  reset() {
    modeLabel.textContent = '—';
    statusText.textContent = 'загрузка…';
    statusText.dataset.state = 'neutral';
    updateHealthBar(100);
    updateShieldUi(1, false);
    updateDashUi(dashChargeElements.length || 3);
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
  setShield(ratio, active) {
    updateShieldUi(ratio, active);
  },
  setDash(value) {
    updateDashUi(value);
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
}

function createNotifier(container) {
  if (!container) {
    return {
      info() {},
      success() {},
      warning() {},
      error() {},
    };
  }

  const ICONS = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '⛔',
  };

  const show = (type, message, { timeout = 4200 } = {}) => {
    const node = document.createElement('div');
    node.className = `notification notification--${type}`;
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');

    const icon = document.createElement('span');
    icon.className = 'notification__icon';
    icon.textContent = ICONS[type] || ICONS.info;

    const body = document.createElement('div');
    body.className = 'notification__body';
    body.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'notification__close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Закрыть уведомление');
    closeBtn.textContent = '×';

    let hideTimer = null;
    const close = () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
      }
      node.dataset.state = 'closing';
      requestAnimationFrame(() => node.remove());
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

function resolveApiOrigin() {
  const raw = (window.CROSSLINE_API_URL || DEFAULT_API_ORIGIN || '').trim();
  try {
    const parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    parsed.pathname = parsed.pathname.replace(/\/$/, '');
    return parsed.origin;
  } catch (error) {
    console.warn('Invalid API origin; falling back to default', error);
    return DEFAULT_API_ORIGIN;
  }
}

function resolveWsOrigin() {
  const explicit = (window.CROSSLINE_WS_URL || '').trim();
  const base = explicit || onlineState.apiOrigin || resolveApiOrigin();
  try {
    const parsed = new URL(base.startsWith('http') || base.startsWith('ws') ? base : `https://${base}`);
    const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
    parsed.protocol = secure ? 'wss:' : 'ws:';
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.protocol}//${parsed.host}`;
  } catch (error) {
    console.warn('Invalid WS origin; using default', error);
    return DEFAULT_WS_ORIGIN;
  }
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
  inputState.aimVector.x = 0;
  inputState.aimVector.y = 0;
  inputState.aimVector.active = false;
}

function setPointerFromClientPosition(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width ? canvas.width / rect.width : 1;
  const scaleY = rect.height ? canvas.height / rect.height : 1;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;
  inputState.pointer.x = Math.max(0, Math.min(canvas.width, x));
  inputState.pointer.y = Math.max(0, Math.min(canvas.height, y));
}

function resetInputState() {
  inputState.keys.clear();
  inputState.fire = false;
  inputState.shield = false;
  inputState.dashRequested = false;
  inputState.moveVector.x = 0;
  inputState.moveVector.y = 0;
  inputState.aimVector.x = 0;
  inputState.aimVector.y = 0;
  inputState.aimVector.active = false;
}

function attachInputListeners() {
  const handleKey = (event, isDown) => {
    const key = event.code || event.key;
    const lower = typeof event.key === 'string' ? event.key.toLowerCase() : '';

    if (key === 'Space') {
      inputState.dashRequested = isDown;
      event.preventDefault();
      return;
    }

    if (SHIELD_KEY_CODES.has(key) || SHIELD_KEY_FALLBACKS.has(lower)) {
      inputState.shield = isDown;
      return;
    }

    if (isDown) {
      inputState.keys.add(key);
    } else {
      inputState.keys.delete(key);
    }

    updateMovementFromKeys();
  };

  window.addEventListener('keydown', (event) => {
    handleKey(event, true);
  });

  window.addEventListener('keyup', (event) => {
    handleKey(event, false);
  });

  canvas.addEventListener('mousedown', (event) => {
    if (event.button === 0) {
      inputState.fire = true;
    } else if (event.button === 2) {
      inputState.shield = true;
    }
    setPointerFromClientPosition(event.clientX, event.clientY);
  });

  canvas.addEventListener('mouseup', (event) => {
    if (event.button === 0) {
      inputState.fire = false;
    } else if (event.button === 2) {
      inputState.shield = false;
    }
  });

  canvas.addEventListener('mouseleave', () => {
    inputState.fire = false;
    inputState.shield = false;
  });

  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  canvas.addEventListener('mousemove', (event) => {
    setPointerFromClientPosition(event.clientX, event.clientY);
    inputState.aimVector.active = true;
  });

  canvas.addEventListener(
    'touchstart',
    (event) => {
      if (event.touches && event.touches.length) {
        setPointerFromClientPosition(event.touches[0].clientX, event.touches[0].clientY);
        inputState.fire = true;
        inputState.aimVector.active = true;
      }
    },
    { passive: true },
  );

  canvas.addEventListener(
    'touchmove',
    (event) => {
      if (event.touches && event.touches.length) {
        setPointerFromClientPosition(event.touches[0].clientX, event.touches[0].clientY);
      }
    },
    { passive: true },
  );

  canvas.addEventListener(
    'touchend',
    () => {
      inputState.fire = false;
    },
    { passive: true },
  );
}

function updateMovementFromKeys() {
  const direction = { x: 0, y: 0 };
  if (inputState.keys.has('KeyW') || inputState.keys.has('ArrowUp')) direction.y -= 1;
  if (inputState.keys.has('KeyS') || inputState.keys.has('ArrowDown')) direction.y += 1;
  if (inputState.keys.has('KeyA') || inputState.keys.has('ArrowLeft')) direction.x -= 1;
  if (inputState.keys.has('KeyD') || inputState.keys.has('ArrowRight')) direction.x += 1;
  const length = Math.hypot(direction.x, direction.y) || 1;
  inputState.moveVector.x = direction.x / length;
  inputState.moveVector.y = direction.y / length;
}

function releaseActiveInputs() {
  inputState.fire = false;
  inputState.shield = false;
  inputState.keys.clear();
  inputState.moveVector.x = 0;
  inputState.moveVector.y = 0;
}

function attachMobileControls() {
  if (!mobileControls) return;

  const isTouch = () => 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  mobileControls.classList.toggle('hidden', !isTouch());

  const bindButton = (element, onDown, onUp) => {
    if (!element) return;
    const start = (event) => {
      event.preventDefault();
      onDown();
    };
    const end = (event) => {
      if (event) event.preventDefault();
      if (onUp) onUp();
    };
    element.addEventListener('mousedown', start);
    element.addEventListener('touchstart', start, { passive: false });
    element.addEventListener('mouseup', end);
    element.addEventListener('mouseleave', end);
    element.addEventListener('touchend', end, { passive: false });
  };

  const bindJoystick = (joystick, onMove) => {
    if (!joystick) return;
    const stick = joystick.querySelector('.joystick__stick');
    let active = false;

    const update = (event) => {
      if (!active) return;
      const rect = joystick.getBoundingClientRect();
      const touch = event.touches ? event.touches[0] : event;
      const x = Math.max(0, Math.min(rect.width, touch.clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height, touch.clientY - rect.top));
      const dx = x - rect.width / 2;
      const dy = y - rect.height / 2;
      const max = rect.width / 2;
      const magnitude = Math.min(1, Math.hypot(dx, dy) / max);
      const angle = Math.atan2(dy, dx);
      const vector = { x: Math.cos(angle) * magnitude, y: Math.sin(angle) * magnitude };
      if (stick) {
        stick.style.transform = `translate(${vector.x * max * 0.6}px, ${vector.y * max * 0.6}px)`;
      }
      onMove(vector);
    };

    const start = (event) => {
      active = true;
      joystick.classList.add('joystick--active');
      update(event);
    };

    const end = () => {
      active = false;
      joystick.classList.remove('joystick--active');
      if (stick) {
        stick.style.transform = 'translate(0, 0)';
      }
      onMove({ x: 0, y: 0 });
    };

    joystick.addEventListener('mousedown', start);
    joystick.addEventListener('touchstart', start, { passive: false });
    window.addEventListener('mousemove', update);
    window.addEventListener('touchmove', update, { passive: false });
    window.addEventListener('mouseup', end);
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
  };

  bindJoystick(moveJoystick, (vector) => {
    inputState.moveVector.x = vector.x;
    inputState.moveVector.y = vector.y;
  });

  bindJoystick(aimJoystick, (vector) => {
    inputState.aimVector.x = vector.x;
    inputState.aimVector.y = vector.y;
    inputState.aimVector.active = Math.hypot(vector.x, vector.y) > 0.05;
  });

  bindButton(
    mobileFire,
    () => {
      inputState.fire = true;
    },
    () => {
      inputState.fire = false;
    },
  );

  bindButton(
    mobileShield,
    () => {
      inputState.shield = true;
      inputState.fire = false;
    },
    () => {
      inputState.shield = false;
    },
  );

  bindButton(mobileDash, () => {
    inputState.dashRequested = true;
  });

  window.addEventListener('blur', () => {
    releaseActiveInputs();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      releaseActiveInputs();
    }
  });
}

let lastFocusedBeforeModal = null;

function isControlsModalOpen() {
  return Boolean(controlsDialog && !controlsDialog.classList.contains('hidden'));
}

function showControlsModal() {
  if (!controlsDialog) return;
  if (isControlsModalOpen()) return;
  releaseActiveInputs();
  lastFocusedBeforeModal = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  controlsDialog.classList.remove('hidden');
  controlsDialog.setAttribute('aria-hidden', 'false');
  if (openControlsBtn) {
    openControlsBtn.setAttribute('aria-expanded', 'true');
  }
  const focusTarget = closeControlsBtn || controlsDialog.querySelector('button, [href], [tabindex="0"]');
  if (focusTarget instanceof HTMLElement) {
    focusTarget.focus();
  }
}

function hideControlsModal() {
  if (!controlsDialog) return;
  if (!isControlsModalOpen()) return;
  controlsDialog.classList.add('hidden');
  controlsDialog.setAttribute('aria-hidden', 'true');
  if (openControlsBtn) {
    openControlsBtn.setAttribute('aria-expanded', 'false');
  }
  if (lastFocusedBeforeModal && document.contains(lastFocusedBeforeModal)) {
    lastFocusedBeforeModal.focus();
  } else if (openControlsBtn) {
    openControlsBtn.focus();
  }
}

if (controlsDialog) {
  controlsDialog.setAttribute('aria-hidden', controlsDialog.classList.contains('hidden') ? 'true' : 'false');
}

function resizeCanvas() {
  const ratio = 16 / 9;
  const wrapper = canvas.parentElement;
  const wrapperWidth = wrapper ? wrapper.clientWidth : canvas.clientWidth;
  const wrapperHeight = wrapper ? wrapper.clientHeight : canvas.clientHeight;
  let width = Math.max(wrapperWidth, 320);
  let height = width / ratio;
  if (wrapperHeight && height > wrapperHeight) {
    height = wrapperHeight;
    width = height * ratio;
  }
  width = Math.max(320, width);
  height = Math.max(180, height);
  canvas.width = width;
  canvas.height = height;
}

window.addEventListener('resize', () => {
  if (!gameStage.classList.contains('hidden')) {
    resizeCanvas();
  }
});

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
  if (state.currentGame instanceof OnlineGame) {
    setWsState('idle');
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

function setOnlinePill(text, stateName = 'neutral') {
  if (!onlineStatusPill) return;
  onlineStatusPill.textContent = text;
  onlineStatusPill.classList.remove('pill--success', 'pill--error', 'pill--neutral');
  onlineStatusPill.classList.add(`pill--${stateName}`);
}

function setRoomControlsDisabled(disabled) {
  if (createRoomBtn) createRoomBtn.disabled = disabled;
  if (refreshRoomsBtn) refreshRoomsBtn.disabled = disabled;
  if (joinOnlineBtn) joinOnlineBtn.disabled = disabled || !onlineState.selectedRoomId;
  if (roomNameInput) roomNameInput.disabled = disabled;
}

function renderRoomList() {
  if (!roomList) return;
  roomList.innerHTML = '';
  if (!onlineState.available) {
    const info = document.createElement('p');
    info.className = 'mode-card__subtitle';
    info.textContent = 'Сервер недоступен. Попробуйте позже или сыграйте офлайн.';
    roomList.append(info);
    setRoomControlsDisabled(true);
    return;
  }

  if (!onlineState.rooms.length) {
    const empty = document.createElement('p');
    empty.className = 'mode-card__subtitle';
    empty.textContent = 'Пока нет комнат. Создайте новую, чтобы открыть лобби.';
    roomList.append(empty);
    return;
  }

  onlineState.rooms.forEach((room) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'room-card';
    card.setAttribute('role', 'listitem');
    card.dataset.roomId = room.id;

    const title = document.createElement('h4');
    title.className = 'room-card__title';
    title.textContent = room.name || room.id;

    const meta = document.createElement('p');
    meta.className = 'room-card__meta';
    const playersLabel = `${room.players || 0}/${room.maxPlayers || 0} пилотов`;
    const statusLabel = room.status === 'live' ? 'идёт матч' : 'ожидает';
    meta.textContent = `${playersLabel} • ${statusLabel}`;

    if (onlineState.selectedRoomId === room.id) {
      card.classList.add('room-card--selected');
    }

    card.addEventListener('click', () => {
      onlineState.selectedRoomId = room.id;
      renderRoomList();
      setRoomControlsDisabled(onlineState.loading);
    });

    card.append(title, meta);
    roomList.append(card);
  });
}

function describeError(error) {
  if (!error) return 'неизвестно';
  if (error.type === 'http') {
    return `HTTP ${error.status}${error.statusText ? ` ${error.statusText}` : ''}`.trim();
  }
  if (error.type === 'network') {
    if (error.message === 'timeout') return 'таймаут';
    return error.message || 'network error';
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'ошибка';
}

function registerError(source, error) {
  onlineState.lastError = {
    source,
    message: describeError(error),
    at: Date.now(),
  };
  updateDebugPanel();
}

function fetchWithTimeout(url, { timeoutMs, ...options }) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const mergedOptions = { ...options, signal: controller.signal };
  return fetch(url, mergedOptions)
    .catch((error) => {
      if (controller.signal.aborted || error.name === 'AbortError') {
        const timeoutError = new Error('timeout');
        timeoutError.type = 'network';
        throw timeoutError;
      }
      const networkError = new Error(error.message || 'network error');
      networkError.type = 'network';
      throw networkError;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

async function fetchJson(path, options = {}) {
  const apiOrigin = onlineState.apiOrigin || resolveApiOrigin();
  const url = `${apiOrigin}${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const response = await fetchWithTimeout(url, { cache: 'no-store', ...options, headers, timeoutMs: options.timeoutMs });
  const contentType = (response.headers && response.headers.get('content-type')) || '';
  let data = null;
  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch (parseError) {
      data = null;
    }
  }
  if (!response.ok) {
    const error = new Error('HTTP error');
    error.type = 'http';
    error.status = response.status;
    error.statusText = response.statusText || '';
    error.data = data;
    throw error;
  }
  return { data, response };
}

function updateDebugPanel() {
  if (!debugPanel) return;
  if (debugApiOrigin) {
    debugApiOrigin.textContent = onlineState.apiOrigin || resolveApiOrigin();
  }
  if (debugWsOrigin) {
    debugWsOrigin.textContent = onlineState.wsOrigin || resolveWsOrigin();
  }
  if (debugStatus) {
    const wsLabel = onlineState.wsState ? ` / ws: ${onlineState.wsState}` : '';
    debugStatus.textContent = `${onlineState.available ? 'online' : 'offline'}${wsLabel}`;
  }
  if (debugHealth) {
    debugHealth.textContent = onlineState.lastHealthStatus || '—';
  }
  if (debugLastError) {
    debugLastError.textContent = onlineState.lastError ? `${onlineState.lastError.source}: ${onlineState.lastError.message}` : '—';
  }
}

function scheduleHealthCheck(delayMs, attempt) {
  if (onlineState.healthTimer) {
    clearTimeout(onlineState.healthTimer);
  }
  onlineState.healthTimer = setTimeout(() => {
    runHealthCheck(attempt);
  }, delayMs);
}

async function runHealthCheck(attempt = 0) {
  onlineState.apiOrigin = resolveApiOrigin();
  onlineState.wsOrigin = resolveWsOrigin();
  setOnlinePill('поиск сервера…', 'neutral');
  updateDebugPanel();
  try {
    const { data, response } = await fetchJson('/health', { timeoutMs: HEALTH_TIMEOUT_MS });
    if (!data || data.status !== 'ok') {
      const invalidError = new Error('Неверный ответ /health');
      invalidError.type = 'network';
      throw invalidError;
    }
    onlineState.available = true;
    onlineState.lastHealthStatus = `HTTP ${response.status} ${response.statusText || ''}`.trim();
    if (!onlineState.wasEverAvailable) {
      notifier.success('Сервер найден: irgri.uk', { timeout: 3200 });
    }
    onlineState.lastError = null;
    onlineState.wasEverAvailable = true;
    setOnlinePill('сервер онлайн', 'success');
    renderRoomList();
    await loadRooms();
    setRoomControlsDisabled(false);
    updateDebugPanel();
    scheduleHealthCheck(HEALTH_SUCCESS_POLL_MS, 0);
    return;
  } catch (error) {
    onlineState.available = false;
    onlineState.rooms = [];
    onlineState.selectedRoomId = null;
    onlineState.lastHealthStatus = '—';
    registerError('health', error);
    setOnlinePill(`нет связи (${describeError(error)})`, 'error');
    renderRoomList();
    setRoomControlsDisabled(true);
    if (onlineState.wasEverAvailable) {
      notifier.warning('Сервер перестал отвечать. Можно играть офлайн.', { timeout: 5200 });
    }
    const nextDelay = Math.min(HEALTH_RETRY_BASE_MS * Math.max(1, attempt + 1), HEALTH_RETRY_MAX_MS);
    scheduleHealthCheck(nextDelay, Math.min(attempt + 1, 5));
  }
}

async function loadRooms() {
  if (!onlineState.available) {
    renderRoomList();
    return;
  }
  onlineState.loading = true;
  setRoomControlsDisabled(true);
  try {
    const { data } = await fetchJson('/rooms', { timeoutMs: HEALTH_TIMEOUT_MS });
    onlineState.rooms = Array.isArray(data) ? data : [];
    if (!onlineState.rooms.some((room) => room.id === onlineState.selectedRoomId)) {
      onlineState.selectedRoomId = onlineState.rooms[0] ? onlineState.rooms[0].id : null;
    }
    renderRoomList();
  } catch (error) {
    registerError('rooms', error);
    notifier.error(`Не удалось получить список комнат (${describeError(error)}).`, { timeout: 4200 });
  } finally {
    onlineState.loading = false;
    setRoomControlsDisabled(false);
  }
}

async function createRoom() {
  if (!onlineState.available || onlineState.loading) return;
  const rawName = roomNameInput ? roomNameInput.value : '';
  const name = sanitizeName(rawName || 'Neon Squad');
  onlineState.loading = true;
  setRoomControlsDisabled(true);
  try {
    const { data } = await fetchJson('/rooms', {
      method: 'POST',
      body: JSON.stringify({ name }),
      timeoutMs: HEALTH_TIMEOUT_MS,
    });
    const room = data || {};
    notifier.success(`Комната «${room.name || name}» создана.`, { timeout: 3600 });
    if (roomNameInput) {
      roomNameInput.value = '';
    }
    onlineState.selectedRoomId = room.id || null;
    await loadRooms();
  } catch (error) {
    registerError('rooms', error);
    notifier.error(`Не удалось создать комнату (${describeError(error)}).`, { timeout: 3600 });
  } finally {
    onlineState.loading = false;
    setRoomControlsDisabled(false);
  }
}

function setWsState(stateName, event) {
  onlineState.wsState = stateName;
  if (event) {
    onlineState.lastWsEvent = { ...event, at: Date.now() };
  }
  updateDebugPanel();
}

async function startOnlineGame() {
  if (!onlineState.available || !onlineState.selectedRoomId) return;
  stopCurrentGame();
  toggleView(true);
  ui.reset();
  state.currentMode = 'online';
  const playerName = sanitizeName(playerNameInput.value || '');
  const room = onlineState.rooms.find((entry) => entry.id === onlineState.selectedRoomId);
  const subtitle = room ? room.name : 'arena';
  const game = new OnlineGame({ canvas, inputState, ui, wsBaseUrl: onlineState.wsOrigin });
  game.onConnectionEvent = (event) => {
    setWsState(event.state || 'unknown', event);
    if (event.type === 'close' || event.type === 'error') {
      registerError('websocket', new Error(event.reason || 'ws closed'));
    }
  };
  state.currentGame = game;
  ui.setMode('online', subtitle);
  ui.setStatus('Подключение к серверу…', 'neutral');
  setWsState('connecting');
  notifier.info('Открываем соединение с ареной…', { timeout: 2600 });
  try {
    await game.start({ roomId: onlineState.selectedRoomId, playerName });
    ui.setStatus('Связь установлена, бой начался!', 'success');
    notifier.success('Вы подключились к онлайн-арене.', { timeout: 3600 });
    setWsState('connected');
  } catch (error) {
    console.error('Online start failed', error);
    ui.setStatus('Не удалось подключиться', 'error');
    notifier.error(`Не удалось подключиться к серверу (${describeError(error)}).`, { timeout: 3600 });
    registerError('websocket', error);
    returnToLobby();
    setWsState('error');
  }
}

async function init() {
  attachInputListeners();
  attachMobileControls();
  playOfflineBtn.addEventListener('click', startOfflineGame);
  leaveGameBtn.addEventListener('click', returnToLobby);
  respawnBtn.addEventListener('click', () => {
    if (state.currentGame && typeof state.currentGame.respawn === 'function') {
      state.currentGame.respawn();
    }
  });
  if (openControlsBtn) {
    openControlsBtn.setAttribute('aria-expanded', 'false');
    openControlsBtn.addEventListener('click', (event) => {
      event.preventDefault();
      showControlsModal();
    });
  }
  if (closeControlsBtn) {
    closeControlsBtn.addEventListener('click', (event) => {
      event.preventDefault();
      hideControlsModal();
    });
  }
  if (controlsDialog) {
    controlsDialog.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.dataset.close === 'controls') {
        hideControlsModal();
      }
    });
  }
  if (createRoomBtn) {
    createRoomBtn.addEventListener('click', () => createRoom());
  }
  if (refreshRoomsBtn) {
    refreshRoomsBtn.addEventListener('click', () => loadRooms());
  }
  if (joinOnlineBtn) {
    joinOnlineBtn.addEventListener('click', () => startOnlineGame());
  }
  ui.reset();
  await (window.__crosslineConfigReady || Promise.resolve());
  runHealthCheck();
}

init().catch((error) => {
  console.error('Failed to initialize Crossline lobby', error);
});
