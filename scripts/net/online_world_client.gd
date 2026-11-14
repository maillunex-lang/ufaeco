class_name OnlineWorldClient
extends Node
## Клиент общего онлайн-мира БАШЭКО (протокол v1, см. protocol/README.md).
## Клиент отправляет только намерения (command); деньги, товары и собственность определяет сервер.

signal connection_state_changed(state: String)
signal world_snapshot_received(snapshot: Dictionary)
signal server_tick_changed(tick: int)
## Начался новый игровой день (изменился номер игрового тика; раз в реальный час).
signal game_tick_changed(game_tick: int)
signal command_result_received(request_id: String, payload: Dictionary)
signal network_error(message_ru: String)

const CONFIG_PATH := "res://config/client_config.json"
const PROTOCOL_PATH := "res://protocol/protocol.json"
const BACKOFF_SECONDS: Array[float] = [1.0, 2.0, 4.0, 8.0]

const STATE_LABELS_RU := {
	"disconnected": "не подключено",
	"connecting": "подключение…",
	"authenticating": "авторизация…",
	"online": "в сети",
	"reconnecting": "переподключение…",
	"failed": "нет связи с сервером",
}

const ERROR_TEXTS_RU := {
	"invalid_message": "Сервер не понял сообщение клиента.",
	"unsupported_protocol_version": "Версия игры устарела. Обновите приложение.",
	"unknown_message_type": "Сервер не знает такого типа сообщения.",
	"unknown_command": "Неизвестная команда.",
	"invalid_payload": "Сервер отклонил данные запроса.",
	"not_authenticated": "Сначала нужно войти в мир.",
	"already_authenticated": "Вход в мир уже выполнен.",
	"auth_timeout": "Время входа в мир истекло.",
	"invalid_session": "Сессия не найдена. Выполняется новый вход.",
	"session_expired": "Сессия истекла. Выполняется новый вход.",
	"request_id_required": "Запрос отправлен без идентификатора.",
	"request_id_conflict": "Идентификатор запроса уже использован.",
	"rate_limited": "Слишком много запросов. Подождите немного.",
	"message_too_large": "Сообщение слишком большое.",
	"internal_error": "Внутренняя ошибка сервера. Попробуйте позже.",
	"invalid_credentials": "Неверный логин или пароль.",
	"login_taken": "Этот логин уже занят.",
	"account_locked": "Слишком много неудачных попыток входа. Подождите минуту.",
	"forbidden": "Нет прав на эту компанию.",
	"not_found": "Объект не найден.",
	"insufficient_funds": "Недостаточно средств.",
	"limit_reached": "Достигнут лимит компаний.",
	"company_name_taken": "Название компании уже занято.",
	"enterprise_name_taken": "Предприятие с таким названием уже есть.",
	"unknown_product": "Неизвестный товар.",
	"insufficient_inventory": "Недостаточно товара на складе.",
	"company_bankrupt": "Компания обанкротилась: операции недоступны.",
	"loan_limit_exceeded": "Превышен лимит кредита.",
	"invalid_amount": "Неверная сумма.",
	"cell_not_for_sale": "Эта клетка не продаётся (дорога, вода, парк или вне города).",
	"cell_occupied": "На клетке уже есть здание.",
	"cell_taken": "Клетка уже принадлежит другой компании.",
	"cells_not_owned": "Эти клетки вам не принадлежат.",
	"out_of_bounds": "За границами города.",
	"zoning_violation": "Это здание нельзя строить в данной зоне.",
}

const DISCONNECT_TEXTS_RU := {
	"replaced_by_new_connection": "Вход выполнен с другого устройства.",
	"heartbeat_timeout": "Соединение потеряно: сервер не получал сигналов.",
	"rate_limited": "Соединение закрыто: слишком много запросов.",
	"protocol_error": "Соединение закрыто из-за ошибки протокола.",
	"server_shutdown": "Сервер перезапускается. Идёт переподключение.",
}

var server_url: String = "http://127.0.0.1:8080"
var websocket_url: String = "ws://127.0.0.1:8080/ws"
var connected: bool = false
var last_server_tick: int = 0
## Игровые часы мира из snapshot: tick (игровой день), year, month, month_name, day (1..24), week (1..4), day_of_week (1..6),
## next_day_at, next_week_at, next_month_at, server_time (мс Unix).
var clock: Dictionary = {}
var _clock_offset_ms: float = 0.0 # server_time − локальное время на момент получения snapshot
var player_id: String = ""
var session_id: String = ""
var state: String = "disconnected"

var _protocol_version: int = 1
var _heartbeat_interval: float = 5.0
var _reconnect_timeout: float = 60.0
var _resume_token: String = ""
## Данные первого входа (пароль хранится только в памяти до успешной авторизации).
var _first_auth: Dictionary = {}
var _password_account: bool = false
var _peer: WebSocketPeer = null
var _was_open: bool = false
var _intentional_close: bool = false
var _no_retry: bool = false
var _heartbeat_left: float = 0.0
var _attempt: int = 0
var _retry_left: float = -1.0
var _outage_started_msec: int = 0


func _ready() -> void:
	set_process(true)


## Загружает конфигурацию и подключается. url — необязательное переопределение websocket_url.
func connect_to_world(url: String = "") -> void:
	_load_config()
	if not url.is_empty():
		websocket_url = url
	_intentional_close = false
	_no_retry = false
	_password_account = false if _first_auth.is_empty() else _password_account
	_attempt = 0
	_outage_started_msec = 0
	_open_socket("connecting")


## Регистрация аккаунта по логину и паролю (после успеха клиент в сети).
func register_account(login: String, password: String, display_name: String = "") -> void:
	var payload := {"login": login, "password": password}
	if not display_name.is_empty():
		payload["display_name"] = display_name
	_first_auth = {"type": "register", "payload": payload}
	connect_to_world()


## Вход по логину и паролю.
func login_with_password(login: String, password: String) -> void:
	_first_auth = {"type": "login", "payload": {"login": login, "password": password}}
	connect_to_world()


## Корректно завершает сессию (повторное подключение к ней станет невозможным).
func disconnect_from_world() -> void:
	_intentional_close = true
	_retry_left = -1.0
	if _peer != null and connected:
		_send("disconnect", {"reason": "client_closing"})
		_peer.close(1000, "client_closing")
	elif _peer != null:
		_peer.close()
	session_id = ""
	_resume_token = ""
	_set_state("disconnected")


## Отправляет намерение серверу. Возвращает request_id или "" если клиент не в сети.
func send_command(command_name: String, args: Dictionary = {}) -> String:
	if not connected or command_name.is_empty():
		return ""
	var request_id := _uuid4()
	_send("command", {"name": command_name, "args": args}, request_id)
	return request_id


func submit_intent(intent: Dictionary) -> bool:
	if intent.is_empty() or not intent.has("name"):
		return false
	return send_command(str(intent["name"]), intent.get("args", {})) != ""


func apply_snapshot(snapshot: Dictionary) -> void:
	if not snapshot.has("server_tick"):
		return
	var new_clock: Dictionary = snapshot.get("clock", {})
	if not new_clock.is_empty():
		_clock_offset_ms = float(new_clock["server_time"]) - Time.get_unix_time_from_system() * 1000.0
		var changed := clock.is_empty() or int(new_clock["tick"]) != int(clock["tick"])
		clock = new_clock
		if changed:
			game_tick_changed.emit(int(clock["tick"]))
	var tick := int(snapshot["server_tick"])
	if tick != last_server_tick:
		last_server_tick = tick
		server_tick_changed.emit(tick)
	world_snapshot_received.emit(snapshot)


## «Март 2026 • день 9 (неделя 2) • новый день через 12 мин»; пусто, пока часы не получены.
func clock_text_ru() -> String:
	if clock.is_empty():
		return ""
	var now_server := Time.get_unix_time_from_system() * 1000.0 + _clock_offset_ms
	var left_ms := maxf(float(clock["next_day_at"]) - now_server, 0.0)
	return "%s %d • день %d (неделя %d) • новый день через %s" % [str(clock["month_name"]), int(clock["year"]), int(clock["day"]), int(clock["week"]), _duration_ru(left_ms)]


static func _duration_ru(ms: float) -> String:
	var total := int(ms / 1000.0)
	if total >= 3600:
		return "%d ч %02d мин" % [total / 3600, (total % 3600) / 60]
	if total >= 60:
		return "%d мин %02d с" % [total / 60, total % 60]
	return "%d с" % total


func status_text_ru() -> String:
	return STATE_LABELS_RU.get(state, state)


# ------------------------------------------------------------------ внутреннее

func _load_config() -> void:
	var cfg := _read_json(CONFIG_PATH)
	server_url = str(cfg.get("server_url", server_url))
	websocket_url = str(cfg.get("websocket_url", websocket_url))
	_reconnect_timeout = float(cfg.get("reconnect_timeout", _reconnect_timeout))
	var override := OS.get_environment("BASHECO_WEBSOCKET_URL")
	if not override.is_empty():
		websocket_url = override
	var proto := _read_json(PROTOCOL_PATH)
	_protocol_version = int(proto.get("protocol_version", cfg.get("protocol_version", 1)))


func _read_json(path: String) -> Dictionary:
	if not FileAccess.file_exists(path):
		network_error.emit("Не найден файл конфигурации: %s" % path)
		return {}
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(path))
	if typeof(parsed) != TYPE_DICTIONARY:
		network_error.emit("Файл конфигурации повреждён: %s" % path)
		return {}
	return parsed


func _open_socket(new_state: String) -> void:
	_was_open = false
	connected = false
	_peer = WebSocketPeer.new()
	_peer.inbound_buffer_size = 8 * 1024 * 1024 # карта города — десятки/сотни КБ
	_peer.max_queued_packets = 4096
	var err := _peer.connect_to_url(websocket_url)
	if err != OK:
		_peer = null
		network_error.emit("Не удалось начать подключение к серверу (код %d)." % err)
		_handle_connection_lost(0)
		return
	_set_state(new_state)


func _process(delta: float) -> void:
	if _retry_left >= 0.0:
		_retry_left -= delta
		if _retry_left <= 0.0:
			_retry_left = -1.0
			_open_socket("reconnecting" if _outage_started_msec > 0 else "connecting")
		return
	if _peer == null:
		return
	_peer.poll()
	match _peer.get_ready_state():
		WebSocketPeer.STATE_OPEN:
			_was_open = true
			while _peer.get_available_packet_count() > 0:
				_on_message(_peer.get_packet().get_string_from_utf8())
				if _peer == null:
					return
			if connected:
				_heartbeat_left -= delta
				if _heartbeat_left <= 0.0:
					_heartbeat_left = _heartbeat_interval
					_send("heartbeat", {"client_time": Time.get_unix_time_from_system() * 1000.0})
		WebSocketPeer.STATE_CLOSED:
			var code := _peer.get_close_code()
			_peer = null
			connected = false
			_handle_connection_lost(code)


func _on_message(text: String) -> void:
	var msg = JSON.parse_string(text)
	if typeof(msg) != TYPE_DICTIONARY or not msg.has("type") or typeof(msg.get("payload")) != TYPE_DICTIONARY:
		network_error.emit("Получено некорректное сообщение от сервера.")
		return
	var payload: Dictionary = msg["payload"]
	match str(msg["type"]):
		"hello":
			_heartbeat_interval = maxf(float(payload.get("heartbeat_interval_ms", 5000)) / 1000.0, 0.5)
			_set_state("authenticating")
			if session_id != "" and _resume_token != "":
				_send("reconnect", {"session_id": session_id, "resume_token": _resume_token})
			elif not _first_auth.is_empty():
				var p: Dictionary = _first_auth["payload"].duplicate()
				p["client_name"] = "basheco-godot"
				p["client_version"] = "0.1.0"
				_send(str(_first_auth["type"]), p)
			else:
				_send("auth", {"client_name": "basheco-godot", "client_version": "0.1.0"})
		"auth_ok":
			_password_account = not _first_auth.is_empty()
			_first_auth = {} # пароль больше не хранится
			player_id = str(payload["player_id"])
			session_id = str(payload["session_id"])
			_resume_token = str(payload["resume_token"])
			_reconnect_timeout = float(payload.get("reconnect_timeout_s", _reconnect_timeout))
			_heartbeat_interval = maxf(float(payload.get("heartbeat_interval_ms", 5000)) / 1000.0, 0.5)
			_heartbeat_left = _heartbeat_interval
			_attempt = 0
			_outage_started_msec = 0
			connected = true
			_update_tick(int(payload.get("server_tick", 0)))
			_set_state("online")
		"heartbeat":
			_update_tick(int(payload.get("server_tick", last_server_tick)))
		"world_snapshot":
			apply_snapshot(payload)
		"command_result":
			command_result_received.emit(str(msg.get("request_id", "")), payload)
		"error":
			_on_server_error(str(payload.get("code", "")))
		"disconnect":
			var reason := str(payload.get("reason", ""))
			if reason == "replaced_by_new_connection":
				_no_retry = true
			network_error.emit(DISCONNECT_TEXTS_RU.get(reason, "Сервер закрыл соединение."))


func _on_server_error(code: String) -> void:
	if code == "invalid_session" or code == "session_expired":
		# Сессию не восстановить: следующее подключение выполнит новый вход.
		session_id = ""
		_resume_token = ""
		if _password_account:
			# Без пароля незаметно войти гостем нельзя: игрок должен войти заново.
			_no_retry = true
			network_error.emit("Сессия истекла. Войдите в аккаунт заново.")
			return
	elif code == "invalid_credentials" or code == "login_taken" or code == "account_locked":
		_first_auth = {}
		_no_retry = true
	network_error.emit(ERROR_TEXTS_RU.get(code, "Ошибка сервера: %s" % code))


func _handle_connection_lost(close_code: int) -> void:
	if _intentional_close:
		_set_state("disconnected")
		return
	if close_code == 1009:
		network_error.emit(ERROR_TEXTS_RU["message_too_large"])
	if _no_retry:
		_set_state("disconnected")
		return
	if _outage_started_msec == 0:
		_outage_started_msec = Time.get_ticks_msec()
	var elapsed := float(Time.get_ticks_msec() - _outage_started_msec) / 1000.0
	if elapsed > _reconnect_timeout:
		_outage_started_msec = 0
		session_id = ""
		_resume_token = ""
		network_error.emit("Не удалось восстановить соединение с сервером. Проверьте интернет.")
		_set_state("failed")
		return
	_retry_left = BACKOFF_SECONDS[mini(_attempt, BACKOFF_SECONDS.size() - 1)]
	_attempt += 1
	if _was_open or session_id != "":
		_set_state("reconnecting")
	else:
		network_error.emit("Нет связи с сервером. Повторная попытка через %d с." % int(_retry_left))
		_set_state("reconnecting")


func _update_tick(tick: int) -> void:
	if tick != last_server_tick:
		last_server_tick = tick
		server_tick_changed.emit(tick)


func _set_state(new_state: String) -> void:
	if state == new_state:
		return
	state = new_state
	connection_state_changed.emit(new_state)


func _send(type: String, payload: Dictionary, request_id: String = "") -> void:
	if _peer == null or _peer.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return
	var msg := {
		"protocol_version": _protocol_version,
		"message_id": _uuid4(),
		"type": type,
		"payload": payload,
	}
	if request_id != "":
		msg["request_id"] = request_id
	_peer.send_text(JSON.stringify(msg))


static func _uuid4() -> String:
	var b := Crypto.new().generate_random_bytes(16)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	var h := b.hex_encode()
	return "%s-%s-%s-%s-%s" % [h.substr(0, 8), h.substr(8, 4), h.substr(12, 4), h.substr(16, 4), h.substr(20, 12)]
