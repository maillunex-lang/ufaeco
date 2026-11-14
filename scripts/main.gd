extends Node2D

const EconomicWorld = preload("res://scripts/core/economic_world.gd")
const OnlineWorldClient = preload("res://scripts/net/online_world_client.gd")

var world: EconomicWorld
var network: OnlineWorldClient

func _ready() -> void:
    var ui := get_node_or_null("Hud/UI") as Control
    if ui:
        ui.theme = BashTheme.build()
    world = EconomicWorld.new()
    world.register_company("demo-farmer", "Демо-Агро", 1500000)
    world.register_company("demo-retail", "Демо-Маркет", 900000)
    world.add_mixed_use_building("ufa-residential-001", "ufa", 12)
    network = OnlineWorldClient.new()
    add_child(network)
    network.connection_state_changed.connect(_on_connection_state_changed)
    network.server_tick_changed.connect(_on_server_tick_changed)
    network.network_error.connect(_on_network_error)
    network.connect_to_world()
    queue_redraw()

const MAP_PLACEHOLDER := preload("res://assets/art/reference/city_overview.jpg")

func _draw() -> void:
    # Временный фон: референс арт-направления (assets/art/reference). Будет заменён игровой картой.
    draw_texture_rect(MAP_PLACEHOLDER, Rect2(0, 0, 1280, 720), false)

func _on_connection_state_changed(_state: String) -> void:
    _refresh_status()

func _on_server_tick_changed(_tick: int) -> void:
    _refresh_status()

func _on_network_error(message_ru: String) -> void:
    var label := get_node_or_null("Hud/UI/TopPanel/Box/NetError")
    if label:
        label.text = message_ru

func _refresh_status() -> void:
    var status := get_node_or_null("Hud/UI/TopPanel/Box/Status")
    if status:
        status.text = "Серверный мир: %s • тик: %d • экономический день: %d" % [network.status_text_ru(), network.last_server_tick, network.economy_day]
