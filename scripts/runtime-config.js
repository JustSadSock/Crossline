// Runtime configuration for the Crossline client.
//
// Set `tunnelOrigin` to the public URL of the ngrok (или другого) туннеля,
// через который проброшен локальный сервер. Этот файл разворачивается вместе
// с клиентом (например, на Netlify) и позволяет игрокам автоматически
// подключаться к нужному серверу.
//
// Пример: const tunnelOrigin = 'https://abcd-1234.eu.ngrok.app';
// После обновления значения задеплойте сайт ещё раз, чтобы клиенты получили
// новую конфигурацию.
(function setCrosslineConfig() {
  const tunnelOrigin = '';

  if (!tunnelOrigin) {
    return;
  }

  window.CROSSLINE_API_URL = tunnelOrigin;

  try {
    const parsed = new URL(tunnelOrigin);
    const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    window.CROSSLINE_WS_URL = `${wsProtocol}//${parsed.host}`;
  } catch (error) {
    console.warn('Не удалось сконфигурировать WebSocket URL', error);
  }
})();
