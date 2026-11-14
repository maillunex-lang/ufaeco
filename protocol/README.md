# Протокол БАШЭКО Online (версия 1)

Единый источник констант протокола: [`protocol.json`](protocol.json).
Его читают и сервер (`server/src/protocol`), и Godot-клиент (`scripts/net/online_world_client.gd`).
Строгая проверка формы сообщений на сервере — Zod-схемы в `server/src/protocol/schemas.ts`.

## Конверт сообщения

Все сообщения — JSON в текстовых WebSocket-кадрах (UTF-8):

```json
{
  "protocol_version": 1,
  "message_id": "uuid",
  "type": "command",
  "request_id": "uuid",
  "payload": {}
}
```

- `protocol_version` — целое; при несовпадении сервер отвечает `error: unsupported_protocol_version` и закрывает соединение.
- `message_id` — UUID, уникален для каждого сообщения.
- `request_id` — UUID, обязателен для `command`. Ответ (`command_result`, `error`) на запрос несёт тот же `request_id`.
- Лишние поля в конверте и в `payload` запрещены (strict).

## Последовательность

```
клиент                      сервер
  | ---- WebSocket connect --> |
  | <------------- hello ----- |   protocol_version, heartbeat_interval_ms, auth_timeout_ms
  | -------------- auth -----> |   новый игрок (гость)
  | <----------- auth_ok ----- |   player_id, session_id, resume_token, server_tick, ...
  | <------ world_snapshot --- |   сразу после auth и затем snapshot_rate раз в секунду
  | ------- heartbeat -------> |
  | <------ heartbeat -------- |   server_time, server_tick
  | -------- command -------> |
  | <------ command_result --- |
```

Переподключение: после hello клиент шлёт `reconnect {session_id, resume_token}` вместо `auth`.
Если сессия не просрочена (`reconnect_timeout`), сервер отвечает `auth_ok` с теми же `player_id`/`session_id`.

## Сообщения клиент → сервер

| type | payload |
|---|---|
| `auth` | `{ client_name: string, client_version: string, display_name?: string }` |
| `register` | `{ client_name, client_version, login: /^[A-Za-z0-9_]{3,24}$/, password: 8..128, display_name? }` |
| `login` | `{ client_name, client_version, login, password }` |
| `reconnect` | `{ session_id: uuid, resume_token: string }` |
| `heartbeat` | `{ client_time: number }` |
| `command` | `{ name: string, args: object }` |
| `disconnect` | `{ reason: "client_closing" }` |

## Сообщения сервер → клиент

| type | payload |
|---|---|
| `hello` | `{ server_name, protocol_version, heartbeat_interval_ms, auth_timeout_ms, max_message_size }` |
| `auth_ok` | `{ player_id, session_id, resume_token, display_name, server_tick, heartbeat_interval_ms, reconnect_timeout_s, resumed }` |
| `heartbeat` | `{ client_time, server_time, server_tick }` |
| `world_snapshot` | `{ world_id, server_tick, server_time, players_online, players: [{player_id, display_name}] }` |
| `command_result` | `{ name, ok, duplicate, result?, error? }` |
| `error` | `{ code, message }` (message — по-русски, для логов; клиент показывает свой текст по `code`) |
| `disconnect` | `{ reason }` |

## Команды

Все команды требуют `request_id`. Бизнес-ошибка (`forbidden`, `insufficient_funds` …) возвращается как
`command_result` с `ok: false`; такая команда **не расходует** `request_id` (транзакция откатывается).
Деньги — целые копейки.

| команда | args | результат |
|---|---|---|
| `session.get_profile` | `{}` | `player_id, display_name, login, is_guest` |
| `session.set_display_name` | `{ display_name }` | профиль |
| `company.create` | `{ name: 2..64 }` | `company` (стартовый капитал проводится через журнал) |
| `company.list` | `{}` | `companies` (только свои) |
| `company.get` | `{ company_id }` | `company, inventory, enterprises` (только владелец) |
| `company.journal` | `{ company_id, limit?: 1..100 }` | `entries` (новые первыми) |
| `enterprise.create` | `{ company_id, kind, name }` | `enterprise` (стоимость списывается с баланса) |
| `economy.get_catalog` | `{}` | товары, виды предприятий (стоимость, зарплата, рецепт), параметры |
| `economy.get_prices` | `{}` | `economy_day`, `prices` (цена, базовая, последние спрос/предложение) |
| `economy.trade` | `{ company_id, product_id, side: buy\|sell, quantity: 1..10000 }` | сделка с NPC-торговым домом по цене ± спред; цену клиент не задаёт |
| `map.get_city` | `{ city_id }` | `city`: `width, height, tiles[], lots[]` (id, x, y, w, h, zone, price_cents, владелец) |
| `map.buy_lot` | `{ company_id, lot_id }` | `purchase` (цена задана сервером; парки и занятые участки не продаются) |
| `bank.get_loan` | `{ company_id }` | `loan_cents` |
| `bank.take_loan` | `{ company_id, amount_cents }` | `loan` |
| `bank.repay_loan` | `{ company_id, amount_cents }` | `loan` |

Операции над банкротом отклоняются кодом `company_bankrupt`. `world_snapshot` содержит `economy_day` и `prices` (копейки).

Виды предприятий и стоимости — гипотезы: `server/src/companies/catalog.ts`.
Команд «выдать деньги/товар» не существует; любое поле вроде `balance_cents` в `args` → `invalid_payload`.

## Идемпотентность

Каждая `command` обязана иметь `request_id`. Повторная отправка того же `request_id` тем же игроком
**не выполняет операцию повторно**: сервер возвращает сохранённый результат с `duplicate: true`.
Тот же `request_id` с другим телом → `error: request_id_conflict`.

## Недоверие к клиенту

Баланс, товары и собственность в протоколе не передаются от клиента.
Любое неизвестное поле (например, `balance` в `args`) отклоняется как `invalid_payload`.

## Ограничения

- Максимальный размер сообщения — `max_message_size` (по умолчанию 16384 байт). Превышение → закрытие кадром 1009.
- Rate limit: token bucket на соединение; при превышении `error: rate_limited`, при повторном злоупотреблении — `disconnect: rate_limited`.
