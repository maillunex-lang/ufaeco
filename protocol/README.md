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

## Команды (этап 1)

- `session.get_profile` — `args: {}`.
- `session.set_display_name` — `args: { display_name: string(2..32) }`.

Команды экономики (рынок, контракты, аренда) появятся на следующих этапах.

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
