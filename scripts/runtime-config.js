(function setCrosslineConfig() {
  // Поставь сюда свой текущий ngrok-URL
  const tunnelOrigin = 'https://7e3199ebec98.ngrok-free.app';

  if (!tunnelOrigin) return;

  // HTTP API
  window.CROSSLINE_API_URL = tunnelOrigin;

  // WS = wss://<host> (для https)
  try {
    const parsed = new URL(tunnelOrigin);
    const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    window.CROSSLINE_WS_URL = `${wsProtocol}//${parsed.host}`;
  } catch (e) { console.warn('WS URL config error', e); }
})();

