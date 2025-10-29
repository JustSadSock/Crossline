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

  const apiOrigin =
    normalizeHttpOrigin(urlParams && urlParams.get('server')) ||
    normalizeHttpOrigin(scopedGlobal?.CROSSLINE_API_URL) ||
    normalizeHttpOrigin(fromProcessEnv('CROSSLINE_API_URL')) ||
    (isPrivateHost(locationHostname) ? normalizeHttpOrigin(locationOrigin) : '');

  const wsOriginExplicit =
    normalizeWsOrigin(urlParams && urlParams.get('ws')) ||
    normalizeWsOrigin(scopedGlobal?.CROSSLINE_WS_URL) ||
    normalizeWsOrigin(fromProcessEnv('CROSSLINE_WS_URL')) ||
    '';

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

  if (apiOrigin) {
    scopedGlobal.CROSSLINE_API_URL = apiOrigin;
  }

  if (wsOriginExplicit) {
    scopedGlobal.CROSSLINE_WS_URL = wsOriginExplicit;
  } else if (apiOrigin) {
    setWsFromHttpOrigin(apiOrigin);
  }

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
            if (!scopedGlobal.CROSSLINE_API_URL) {
              scopedGlobal.CROSSLINE_API_URL = sameOrigin;
            }
            if (!scopedGlobal.CROSSLINE_WS_URL) {
              setWsFromHttpOrigin(sameOrigin);
            }
          })
          .catch(() => {});
      })
      .catch(() => {});
  };

  const configReadyPromise = ensureSameOriginConfig();

  if (configReadyPromise && typeof configReadyPromise.then === 'function') {
    scopedGlobal.__crosslineConfigReady = configReadyPromise.catch(() => {});
  } else {
    scopedGlobal.__crosslineConfigReady = Promise.resolve();
  }
})(typeof window !== 'undefined' ? window : globalThis);

