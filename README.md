# БАШЭКО Online

Онлайн-экономическая игра для Android (Godot 4) с действием в Республике Башкортостан.
Дорожная карта — [ROADMAP.md](ROADMAP.md), механики Capitalism 2 и их адаптация — [docs/GAME_DESIGN.md](docs/GAME_DESIGN.md),
игровое время — [docs/TIME_MODEL.md](docs/TIME_MODEL.md), архитектура — [docs/GAME_ARCHITECTURE.md](docs/GAME_ARCHITECTURE.md),
протокол — [protocol/README.md](protocol/README.md).

Сервер — авторитетный: клиент отправляет только намерения, деньги, товары и собственность определяет сервер.

## Структура

| Каталог | Назначение |
|---|---|
| `server/` | Backend: TypeScript, Node.js, Fastify, `ws`, PostgreSQL (`pg`), Zod, Vitest |
| `protocol/` | Единый протокол (`protocol.json`) для сервера и Godot-клиента |
| `config/client_config.json` | Конфигурация Godot-клиента |
| `scripts/`, `scenes/`, `project.godot` | Godot 4 клиент |
| `.env.example` | Переменные окружения сервера (локальные безопасные значения) |
| `docker-compose.yml` | PostgreSQL только для локальной разработки/тестов |

## Быстрый старт (локально)

Требуется Node.js ≥ 20 и PostgreSQL 16 (локальный или через Docker).

```bash
# 1. PostgreSQL (вариант А — Docker; создаёт базы basheco_dev и basheco_test)
docker compose up -d postgres

# 1. PostgreSQL (вариант Б — уже установленный локально)
sudo -u postgres psql -c "CREATE USER basheco WITH PASSWORD 'basheco_dev_only' CREATEDB"
sudo -u postgres psql -c "CREATE DATABASE basheco_dev OWNER basheco"
sudo -u postgres psql -c "CREATE DATABASE basheco_test OWNER basheco"

# 2. Сервер
cd server
npm ci
cp ../.env.example .env      # необязательно: значения по умолчанию те же
npm run migrate              # миграции (сервер также применяет их при старте)
npm start                    # http://127.0.0.1:8080, WebSocket ws://127.0.0.1:8080/ws
curl http://127.0.0.1:8080/health

# 3. Тесты (нужна база basheco_test)
npm test
```

## Godot-клиент

1. Откройте корень репозитория в Godot 4.3+ (`project.godot`).
2. Адрес сервера — `config/client_config.json` (`websocket_url`) или переменная окружения `BASHECO_WEBSOCKET_URL`.
   Для Android-эмулятора вместо `127.0.0.1` используйте `10.0.2.2`.
3. Запустите сцену `scenes/main.tscn`: в шапке отображаются статус соединения и `server_tick`, ошибки сети — по-русски.
4. Автопроверка клиента против запущенного сервера (Godot 4.3, без окна):
   ```bash
   godot --headless --path . --script res://tests/godot/net_check.gd
   ```
5. Проверка карты (нужны запущенный сервер и виртуальный экран):
   ```bash
   xvfb-run -a godot --path . --rendering-driver opengl3 --script res://tests/godot/map_check.gd
   ```
6. При экспорте в Android добавьте `*.json` в фильтр ресурсов экспорта (Export → Resources → Filters to export non-resource files),
   иначе `config/client_config.json` и `protocol/protocol.json` не попадут в APK.

## Переменные конфигурации сервера

Все переменные необязательны: значения по умолчанию безопасны для локального запуска. Секреты в git не хранятся.

| Переменная | По умолчанию | Описание |
|---|---|---|
| `ENVIRONMENT` | `development` | `development` / `test` / `production`. В `production` запрещён dev-пароль БД |
| `HOST` | `127.0.0.1` | Адрес прослушивания (по умолчанию только localhost) |
| `PORT` | `8080` | Порт HTTP/WebSocket |
| `SERVER_URL` | `http://127.0.0.1:8080` | Публичный HTTP-адрес сервера |
| `WEBSOCKET_URL` | `ws://127.0.0.1:8080/ws` | Публичный WebSocket-адрес (для клиента и логов) |
| `DATABASE_URL` | `postgres://basheco:basheco_dev_only@127.0.0.1:5432/basheco_dev` | Строка подключения к PostgreSQL |
| `PROTOCOL_VERSION` | `1` | Версия протокола; клиенты с другой версией отклоняются |
| `TICK_RATE` | `10` | Тиков мира в секунду |
| `SNAPSHOT_RATE` | `2` | Рассылок snapshot в секунду (≤ `TICK_RATE`) |
| `RECONNECT_TIMEOUT` | `60` | Секунды, в течение которых можно восстановить сессию |
| `MAX_MESSAGE_SIZE` | `16384` | Максимальный размер сообщения в байтах |
| `HEARTBEAT_INTERVAL_MS` | `5000` | Интервал heartbeat; соединение рвётся после 3 пропущенных |
| `WORLD_ID` | `main` | Идентификатор мира (часы и журнал тиков хранятся по нему) |
| `WORLD_SEED` | `20241114` | Seed мира: детерминированный ГСЧ тиков |
| `WORLD_EPOCH` | ближайшее 09:00 по Уфе | Начало месяца №0, ISO; должно быть ровно 09:00 по Уфе (04:00 UTC). Применяется при создании мира |
| `GAME_START_YEAR` / `GAME_START_MONTH` | `2026` / `1` | Стартовая игровая дата |
| `TIME_SPEED` | `1` | Ускорение игрового времени (только dev/test; в production только 1). Менять в существующем мире нельзя — `npm run world:reset` |
| `TICKS_ENABLED` | `true` | `false` — планировщик тиков выключен (тесты запускают `TickRunner` вручную) |
| `RATE_LIMIT_BURST` | `30` | Размер «ведра» запросов на соединение |
| `RATE_LIMIT_PER_SECOND` | `10` | Скорость пополнения «ведра» |

Для тестов можно задать `TEST_DATABASE_URL` (по умолчанию база `basheco_test` на localhost).

Клиентский `config/client_config.json`: `server_url`, `websocket_url`, `protocol_version`, `heartbeat_interval_ms`,
`reconnect_timeout`, `max_message_size`, `environment`.

## Игровое время

1 игровой месяц = 1 реальные сутки (с 09:00 по Уфе), неделя = 6 часов, мир пересчитывается каждую неделю. Подробности — [docs/TIME_MODEL.md](docs/TIME_MODEL.md).
Для разработки: `TIME_SPEED=3600 npm start` (неделя = 6 секунд), сброс мира — `npm run world:reset`.

## Ограничения

Это локальный прототип. Production, VPS и публикация APK не настроены.

## Графика

Изометрические спрайты — Kenney (CC0), см. [assets/art/iso/CREDITS.md](assets/art/iso/CREDITS.md). Референсы стиля — `assets/art/reference/`.
