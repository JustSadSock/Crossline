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
const roomTemplate = document.getElementById('room-template');
const notificationsRoot = document.getElementById('notifications');

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
  selectedRoomId: null,
  selectedRoomElement: null,
  currentGame: null,
  currentMode: null,
};

const dashChargeElements = dashCharges ? Array.from(dashCharges.querySelectorAll('.hud__charge')) : [];

const MOVEMENT_KEY_MAP = {
  KeyW: 'w',
  ArrowUp: 'w',
  KeyS: 's',
  ArrowDown: 's',
  KeyA: 'a',
  ArrowLeft: 'a',
  KeyD: 'd',
  ArrowRight: 'd',
};

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

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '::1'];

function isLocalEnvironment() {
  const { hostname } = window.location;
  if (!hostname) {
    return false;
  }
  return (
    LOCAL_HOSTNAMES.includes(hostname) ||
    hostname.endsWith('.local') ||
    hostname.startsWith('127.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.')
  );
}

function normalizeHttpUrl(rawUrl) {
  const value = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!value) {
    return '';
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    parsed.hash = '';
    const cleanedPath = parsed.pathname.replace(/\/+$/, '');
    const path = cleanedPath && cleanedPath !== '/' ? cleanedPath : '';
    return `${parsed.origin}${path}`;
  } catch (error) {
    console.warn('Invalid server URL provided, ignoring', error);
    return '';
  }
}

function httpToWs(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${parsed.host}`;
  } catch (error) {
    console.warn('Unable to derive WebSocket URL from base', error);
    return '';
  }
}

function getApiBaseUrl() {
  const globalUrl = normalizeHttpUrl(window.CROSSLINE_API_URL);
  if (globalUrl) {
    return globalUrl;
  }
  if (isLocalEnvironment()) {
    return window.location.origin;
  }
  return '';
}

function getWsBaseUrl() {
  if (window.CROSSLINE_WS_URL) {
    return window.CROSSLINE_WS_URL;
  }
  if (isLocalEnvironment()) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
  }
  return '';
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

async function loadRooms() {
  roomsList.innerHTML = '<p class="room-card__meta">Загрузка комнат…</p>';
  playOnlineBtn.disabled = true;
  state.selectedRoomId = null;
  state.selectedRoomElement = null;
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    roomsList.innerHTML = '';
    const hint = document.createElement('p');
    hint.className = 'room-card__meta';
    hint.textContent = 'Сервер недоступен. Попробуйте позже.';
    roomsList.append(hint);
    const now = Date.now();
    if (now - lastRoomsErrorAt > ROOMS_ERROR_COOLDOWN) {
      notifier.warning('Онлайн-сервер сейчас недоступен. Проверьте туннель и попробуйте снова.', {
        timeout: 6500,
      });
      lastRoomsErrorAt = now;
    }
    return;
  }
  try {
    const response = await fetch(`${baseUrl}/rooms`, { cache: 'no-store' });
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
    const baseUrl = getApiBaseUrl();
    if (!baseUrl) {
      notifier.warning('Сервер недоступен. Попробуйте позже.');
      return;
    }
    const response = await fetch(`${baseUrl}/rooms`, {
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
  inputState.shield = false;
  inputState.dashRequested = false;
  inputState.moveVector.x = 0;
  inputState.moveVector.y = 0;
  inputState.aimVector.x = 0;
  inputState.aimVector.y = 0;
  inputState.aimVector.active = false;
  centerPointer();
}

function isTextInput(target) {
  return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
}

function updateMovementKeys(event, pressed) {
  const target = event.target;
  if (isTextInput(target) && target !== document.body) {
    return false;
  }
  if (controlsDialog && !controlsDialog.classList.contains('hidden')) {
    return false;
  }
  const mapped = MOVEMENT_KEY_MAP[event.code] || null;
  let handled = false;
  if (mapped) {
    handled = true;
    if (pressed) {
      inputState.keys.add(mapped);
    } else {
      inputState.keys.delete(mapped);
    }
  } else {
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (['w', 'a', 's', 'd'].includes(key)) {
      handled = true;
      if (pressed) {
        inputState.keys.add(key);
      } else {
        inputState.keys.delete(key);
      }
    }
  }
  if (handled && event.cancelable) {
    event.preventDefault();
  }
  return handled;
}

function releaseActiveInputs() {
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
  document.addEventListener('keydown', (event) => {
    if (controlsDialog && !controlsDialog.classList.contains('hidden')) {
      if (event.key === 'Escape') {
        hideControlsModal();
      }
      return;
    }
    updateMovementKeys(event, true);
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (event.code === 'Space' && !isTextInput(event.target)) {
      event.preventDefault();
      if (!event.repeat) {
        inputState.dashRequested = true;
      }
    } else if (
      !isTextInput(event.target) &&
      (SHIELD_KEY_CODES.has(event.code) || SHIELD_KEY_FALLBACKS.has(key))
    ) {
      if (event.cancelable) {
        event.preventDefault();
      }
      inputState.shield = true;
      inputState.fire = false;
    }
  });
  document.addEventListener('keyup', (event) => {
    if (controlsDialog && !controlsDialog.classList.contains('hidden')) {
      return;
    }
    updateMovementKeys(event, false);
    if (event.code === 'Space' && !isTextInput(event.target)) {
      if (event.cancelable) {
        event.preventDefault();
      }
    } else if (
      !isTextInput(event.target) &&
      (SHIELD_KEY_CODES.has(event.code) || SHIELD_KEY_FALLBACKS.has((event.key || '').toLowerCase()))
    ) {
      if (event.cancelable) {
        event.preventDefault();
      }
      inputState.shield = false;
    }
  });
  canvas.addEventListener('mousemove', (event) => {
    setPointerFromClientPosition(event.clientX, event.clientY);
  });
  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });
  canvas.addEventListener('mousedown', (event) => {
    if (event.button === 2) {
      inputState.shield = true;
      inputState.fire = false;
    } else if (event.button === 0) {
      if (!inputState.shield) {
        inputState.fire = true;
      }
    }
  });
  document.addEventListener('mouseup', (event) => {
    if (event.button === 2) {
      inputState.shield = false;
    }
    if (event.button === 0) {
      inputState.fire = false;
    }
  });
  canvas.addEventListener('touchstart', (event) => {
    if (event.cancelable) {
      event.preventDefault();
    }
    const touch = event.changedTouches[0];
    setPointerFromClientPosition(touch.clientX, touch.clientY);
    if (!inputState.shield) {
      inputState.fire = true;
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', (event) => {
    if (event.cancelable) {
      event.preventDefault();
    }
    const touch = event.changedTouches[0];
    setPointerFromClientPosition(touch.clientX, touch.clientY);
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
  const isTouch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  mobileControls.classList.toggle('mobile-controls--active', isTouch);
  if (!isTouch) {
    return;
  }

  const bindButton = (element, onDown, onUp) => {
    if (!element) return;
    element.addEventListener('touchstart', (event) => {
      if (event.cancelable) event.preventDefault();
      onDown();
    }, { passive: false });
    element.addEventListener('touchend', (event) => {
      if (event.cancelable) event.preventDefault();
      if (onUp) onUp();
    }, { passive: false });
    element.addEventListener('touchcancel', () => {
      if (onUp) onUp();
    });
  };

  const setupJoystick = (root, onChange) => {
    if (!root) return;
    const stick = root.querySelector('.joystick__stick');
    if (!stick) return;
    let active = false;
    let identifier = null;

    const reset = () => {
      active = false;
      identifier = null;
      stick.style.transform = 'translate(-50%, -50%)';
      onChange({ x: 0, y: 0, active: false });
    };

    const updateFromTouch = (touch) => {
      const rect = root.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = touch.clientX - centerX;
      const dy = touch.clientY - centerY;
      const maxRadius = rect.width / 2;
      const distance = Math.min(Math.hypot(dx, dy), maxRadius);
      const angle = Math.atan2(dy, dx);
      const normalized = maxRadius > 0 ? distance / maxRadius : 0;
      const normX = Math.cos(angle) * normalized;
      const normY = Math.sin(angle) * normalized;
      const travel = maxRadius - stick.clientWidth / 2;
      const offsetX = normX * travel;
      const offsetY = normY * travel;
      stick.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px))`;
      onChange({ x: normX, y: normY, active: normalized > 0.1 });
    };

    root.addEventListener('touchstart', (event) => {
      if (active) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      if (event.cancelable) event.preventDefault();
      active = true;
      identifier = touch.identifier;
      updateFromTouch(touch);
    }, { passive: false });

    root.addEventListener('touchmove', (event) => {
      if (!active) return;
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === identifier);
      if (!touch) return;
      if (event.cancelable) event.preventDefault();
      updateFromTouch(touch);
    }, { passive: false });

    const handleEnd = (event) => {
      if (!active) return;
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === identifier);
      if (!touch) return;
      if (event.cancelable) event.preventDefault();
      reset();
    };

    root.addEventListener('touchend', handleEnd, { passive: false });
    root.addEventListener('touchcancel', reset);
  };

  setupJoystick(moveJoystick, ({ x, y, active }) => {
    inputState.moveVector.x = active ? x : 0;
    inputState.moveVector.y = active ? y : 0;
  });

  setupJoystick(aimJoystick, ({ x, y, active }) => {
    inputState.aimVector.x = x;
    inputState.aimVector.y = y;
    inputState.aimVector.active = active;
  });

  bindButton(mobileFire, () => {
    inputState.fire = true;
  }, () => {
    inputState.fire = false;
  });

  bindButton(mobileShield, () => {
    inputState.shield = true;
    inputState.fire = false;
  }, () => {
    inputState.shield = false;
  });

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

async function startOnlineGame() {
  if (!state.selectedRoomId) {
    notifier.warning('Сначала выберите комнату или создайте новую арену.');
    return;
  }
  const wsBaseUrl = getWsBaseUrl();
  if (!wsBaseUrl) {
    notifier.warning('Укажите URL туннеля сервера, чтобы подключиться.');
    return;
  }
  stopCurrentGame();
  toggleView(true);
  ui.reset();
  state.currentMode = 'online';
  const name = sanitizeName(playerNameInput.value || '');
  const game = new OnlineGame({ canvas, inputState, ui, wsBaseUrl });
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
  loadRooms();
}

init();
