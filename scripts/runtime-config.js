(function setCrosslineConfig(globalObject) {
  const urlParams = (() => {
    const locationSearch = globalObject?.location?.search;
    if (!locationSearch) return null;
    try { return new URLSearchParams(locationSearch); }
    catch (_) { return null; }
  })();

  const fromProcessEnv = (name) => {
    if (typeof process === 'undefined' || !process?.env) return undefined;
    return process.env[name];
  };

  const apiOrigin =
    (urlParams && urlParams.get('server')) ||
    globalObject?.CROSSLINE_API_URL ||
    fromProcessEnv('CROSSLINE_API_URL') ||
    '';

  const wsOriginExplicit =
    (urlParams && urlParams.get('ws')) ||
    globalObject?.CROSSLINE_WS_URL ||
    fromProcessEnv('CROSSLINE_WS_URL') ||
    '';

  if (apiOrigin) {
    globalObject.CROSSLINE_API_URL = apiOrigin;
  }

  if (wsOriginExplicit) {
    globalObject.CROSSLINE_WS_URL = wsOriginExplicit;
    return;
  }

  if (!apiOrigin) return;

  try {
    const parsed = new URL(apiOrigin);
    const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    globalObject.CROSSLINE_WS_URL = `${wsProtocol}//${parsed.host}`;
  } catch (e) {
    console.warn('WS URL config error', e);
  }
})(typeof window !== 'undefined' ? window : globalThis);

