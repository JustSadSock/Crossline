(function setCrosslineConfig(globalObject) {
  const scopedGlobal = typeof globalObject === 'undefined' ? {} : globalObject;

  const urlParams = (() => {
    const locationSearch = scopedGlobal?.location?.search;
    if (!locationSearch) return null;
    try {
      return new URLSearchParams(locationSearch);
    } catch (_) {
      return null;
    }
  })();

  const fromProcessEnv = (name) => {
    if (typeof process === 'undefined' || !process?.env) return undefined;
    return process.env[name];
  };

  const isPrivateHost = (hostname) => {
    if (!hostname) return false;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.endsWith('.local') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('127.')
    );
  };

  const sanitizeRawValue = (value) => {
    if (value == null) return '';
    const raw = typeof value === 'string' ? value.trim() : `${value}`.trim();
    if (!raw) return '';
    const lowered = raw.toLowerCase();
    if (lowered === 'undefined' || lowered === 'null' || lowered === 'false') {
      return '';
    }
    if (/^<%=\s*process\.env/i.test(raw)) {
      return '';
    }
    return raw;
  };

  const normalizeHttpOrigin = (value) => {
    const raw = sanitizeRawValue(value);
    if (!raw) return '';
    try {
      const parsed = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return '';
      }
      if (parsed.protocol === 'http:' && !isPrivateHost(parsed.hostname)) {
        parsed.protocol = 'https:';
      }
      parsed.hash = '';
      const cleanedPath = parsed.pathname.replace(/\/+$/, '');
      const path = cleanedPath && cleanedPath !== '/' ? cleanedPath : '';
      return `${parsed.origin}${path}`;
    } catch (error) {
      console.warn('Invalid server URL provided, ignoring', error);
      return '';
    }
  };

  const normalizeWsOrigin = (value) => {
    const raw = sanitizeRawValue(value);
    if (!raw) return '';
    try {
      const parsed = raw.includes('://') ? new URL(raw) : new URL(`wss://${raw}`);
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        return '';
      }
      if (parsed.protocol === 'ws:' && !isPrivateHost(parsed.hostname)) {
        parsed.protocol = 'wss:';
      }
      parsed.hash = '';
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
    } catch (error) {
      console.warn('Invalid WebSocket URL provided, ignoring', error);
      return '';
    }
  };

  const locationHostname = scopedGlobal?.location?.hostname || '';
  const locationOrigin = scopedGlobal?.location?.origin || '';

  const readInlineRuntimeConfig = () => {
    const doc = scopedGlobal?.document;
    if (!doc || typeof doc.querySelector !== 'function') return null;
    const script = doc.querySelector('script[type="application/json"][data-crossline-config]');
    if (!script) return null;
    const text = script.textContent || script.innerText;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      console.warn('Unable to parse inline Crossline config', error);
      return null;
    }
  };

  const pickConfigValue = (config, keys) => {
    if (!config || typeof config !== 'object') return '';
    for (const key of keys) {
      const candidate = config[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }
    for (const key of keys) {
      const upperKey = key.toUpperCase();
      if (upperKey === key) continue;
      const candidate = config[upperKey];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }
    return '';
  };

  const inlineRuntimeConfig = readInlineRuntimeConfig();

  let apiOrigin = '';
  let wsOriginExplicit = '';

  const setWsFromHttpOrigin = (httpOrigin) => {
    if (!httpOrigin || wsOriginExplicit) return;
    try {
      const parsed = new URL(httpOrigin);
      const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      const needsSecure = !isPrivateHost(parsed.hostname);
      const finalProtocol = needsSecure ? 'wss:' : wsProtocol;
      scopedGlobal.CROSSLINE_WS_URL = `${finalProtocol}//${parsed.host}`;
    } catch (error) {
      console.warn('WS URL config error', error);
    }
  };

  const setApiOrigin = (candidate) => {
    if (apiOrigin) return false;
    const normalized = normalizeHttpOrigin(candidate);
    if (!normalized) return false;
    apiOrigin = normalized;
    scopedGlobal.CROSSLINE_API_URL = normalized;
    if (!wsOriginExplicit) {
      setWsFromHttpOrigin(normalized);
    }
    return true;
  };

  const setWsOriginExplicit = (candidate) => {
    if (wsOriginExplicit) return false;
    const normalized = normalizeWsOrigin(candidate);
    if (!normalized) return false;
    wsOriginExplicit = normalized;
    scopedGlobal.CROSSLINE_WS_URL = normalized;
    return true;
  };

  const inlineApiCandidate = pickConfigValue(inlineRuntimeConfig, [
    'apiOrigin',
    'apiUrl',
    'api',
    'httpOrigin',
    'http',
    'server',
    'serverUrl',
    'origin',
    'CROSSLINE_API_URL',
  ]);

  const inlineWsCandidate = pickConfigValue(inlineRuntimeConfig, [
    'wsOrigin',
    'wsUrl',
    'ws',
    'socket',
    'socketUrl',
    'CROSSLINE_WS_URL',
  ]);

  const presetApiGlobal = scopedGlobal?.CROSSLINE_API_URL;
  const presetWsGlobal = scopedGlobal?.CROSSLINE_WS_URL;

  setApiOrigin(urlParams && urlParams.get('server'));
  setApiOrigin(inlineApiCandidate);
  setApiOrigin(presetApiGlobal);
  setApiOrigin(fromProcessEnv('CROSSLINE_API_URL'));
  if (!apiOrigin && isPrivateHost(locationHostname)) {
    setApiOrigin(locationOrigin);
  }

  setWsOriginExplicit(urlParams && urlParams.get('ws'));
  setWsOriginExplicit(inlineWsCandidate);
  setWsOriginExplicit(presetWsGlobal);
  setWsOriginExplicit(fromProcessEnv('CROSSLINE_WS_URL'));

  if (apiOrigin && !wsOriginExplicit) {
    setWsFromHttpOrigin(apiOrigin);
  }

  const parseEnvConfig = (text) => {
    if (typeof text !== 'string' || !text.trim()) return null;
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .reduce((acc, line) => {
        const separator = line.indexOf('=');
        if (separator <= 0) return acc;
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (key) {
          acc[key] = value;
        }
        return acc;
      }, {});
  };

  const applyConfigObject = (config) => {
    if (!config || typeof config !== 'object') return false;
    const apiApplied = setApiOrigin(pickConfigValue(config, [
      'apiOrigin',
      'apiUrl',
      'api',
      'httpOrigin',
      'http',
      'server',
      'serverUrl',
      'origin',
      'CROSSLINE_API_URL',
    ]));
    const wsApplied = setWsOriginExplicit(pickConfigValue(config, [
      'wsOrigin',
      'wsUrl',
      'ws',
      'socket',
      'socketUrl',
      'CROSSLINE_WS_URL',
    ]));
    if (apiApplied && !wsOriginExplicit) {
      setWsFromHttpOrigin(apiOrigin);
    }
    return apiApplied || wsApplied;
  };

  const tryLoadConfigAsset = (path, parser) => {
    if (typeof scopedGlobal.fetch !== 'function') return Promise.resolve(false);
    return scopedGlobal
      .fetch(path, { cache: 'no-store', credentials: 'same-origin' })
      .then((response) => {
        if (!response || !response.ok) return false;
        return parser(response)
          .then((payload) => applyConfigObject(payload))
          .catch(() => false);
      })
      .catch(() => false);
  };

  const loadBundledRuntimeConfig = () => {
    if (apiOrigin && wsOriginExplicit) return Promise.resolve(false);
    return tryLoadConfigAsset('./scripts/crossline-runtime-config.json', (response) => response.json())
      .then((applied) => {
        if (applied || (apiOrigin && wsOriginExplicit)) {
          return applied;
        }
        return tryLoadConfigAsset('./scripts/.crossline-tunnel.env', (response) =>
          response
            .text()
            .then((text) => parseEnvConfig(text) || {})
        );
      });
  };

  const ensureSameOriginConfig = () => {
    if (apiOrigin) return Promise.resolve();
    const sameOrigin = normalizeHttpOrigin(locationOrigin);
    if (!sameOrigin) return Promise.resolve();
    const canFetch = typeof scopedGlobal.fetch === 'function';
    if (!canFetch) return Promise.resolve();
    return scopedGlobal
      .fetch('/health', { cache: 'no-store', credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) return;
        return response
          .json()
          .then((payload) => {
            if (!payload || payload.status !== 'ok') return;
            setApiOrigin(sameOrigin);
          })
          .catch(() => {});
      })
      .catch(() => {});
  };

  const configReadyPromise = loadBundledRuntimeConfig().then(() => ensureSameOriginConfig());

  if (configReadyPromise && typeof configReadyPromise.then === 'function') {
    scopedGlobal.__crosslineConfigReady = configReadyPromise.catch(() => {});
  } else {
    scopedGlobal.__crosslineConfigReady = Promise.resolve();
  }
})(typeof window !== 'undefined' ? window : globalThis);

