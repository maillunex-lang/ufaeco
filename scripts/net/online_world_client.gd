class_name OnlineWorldClient
extends Node

signal connection_state_changed(state: String)
signal world_snapshot_received(snapshot: Dictionary)

var server_url: String = "wss://api.basheco.example/world"
var connected: bool = false
var last_server_tick: int = 0

func connect_to_world(url: String = "") -> void:
    if not url.is_empty():
        server_url = url
    # Транспорт будет подключён на сетевом этапе.
    connected = false
    connection_state_changed.emit("transport_pending")

func submit_intent(intent: Dictionary) -> bool:
    if intent.is_empty():
        return false
    # Клиент отправляет намерения; деньги, товары и права подтверждает сервер.
    return connected

func apply_snapshot(snapshot: Dictionary) -> void:
    if not snapshot.has("server_tick"):
        return
    last_server_tick = int(snapshot.server_tick)
    world_snapshot_received.emit(snapshot)
