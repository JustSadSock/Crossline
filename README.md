# Crossline

Браузерная арена с офлайновым режимом и опциональной онлайн-игрой.

## Режимы
- **Офлайн** — работает сразу из `index.html`, сервер не нужен.
- **Онлайн** — требует запущенный сервер (`/server`) и публичный доступ через туннель/хостинг (по умолчанию `https://irgri.uk`).

## Подготовка окружения
- Node.js и npm
- cloudflared с настроенным туннелем `irgri-tunnel` (конфиг по умолчанию: `%USERPROFILE%\.cloudflared\config.yml`)

## Быстрый старт (Windows)
1. Клонируйте репозиторий и откройте его в проводнике.
2. Установите зависимости: в терминале/PowerShell выполните `npm install` (или `npm ci`, если не меняли `package-lock.json`).
3. Запустите один файл `run-server-and-tunnel.bat` из корня проекта. Скрипт:
   - ставит зависимости (`npm ci` или `npm install`),
   - выставляет `PORT=3000`, `CROSSLINE_CLUSTER=0`, `CROSSLINE_CLUSTER_WORKERS=1`,
   - запускает сервер и ждёт доступности `http://127.0.0.1:%PORT%/health` (до 30 секунд),
   - после готовности запускает `cloudflared ... tunnel run irgri-tunnel` в отдельном окне,
   - удерживает главное окно открытым и показывает коды выхода при ошибках.
4. Проверьте `http://localhost:3000/health` и `http://localhost:3000/rooms` — должны вернуть JSON без ошибок.
5. Откройте игру через `https://irgri.uk` (через туннель) или локально через `index.html`.

## Ручной запуск сервера
```bash
npm install            # или npm ci
PORT=3000 CROSSLINE_CLUSTER=0 CROSSLINE_CLUSTER_WORKERS=1 npm run server
```

## npm-скрипты
- `npm run server` — запустить сервер (`node server/index.js`).
- `npm run dev` — алиас `npm run server`.
- `npm test` — заглушка (автотестов нет).

## Проверка здоровья
- `GET http://localhost:3000/health` — статус сервера и метрики.
- `GET http://localhost:3000/rooms` — текущий список комнат.
