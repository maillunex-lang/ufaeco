extends Node2D

const EconomicWorld = preload("res://scripts/core/economic_world.gd")
const OnlineWorldClient = preload("res://scripts/net/online_world_client.gd")

var world: EconomicWorld
var network: OnlineWorldClient

func _ready() -> void:
    world = EconomicWorld.new()
    world.register_company("demo-farmer", "Демо-Агро", 1500000)
    world.register_company("demo-retail", "Демо-Маркет", 900000)
    world.add_mixed_use_building("ufa-residential-001", "ufa", 12)
    network = OnlineWorldClient.new()
    add_child(network)
    network.connection_state_changed.connect(_on_connection_state_changed)
    network.connect_to_world()
    queue_redraw()

func _draw() -> void:
    draw_rect(Rect2(0, 0, 1280, 720), Color("#101b25"))
    draw_circle(Vector2(640, 360), 245.0, Color("#1c4a50"))
    draw_circle(Vector2(640, 360), 170.0, Color("#24616a"))
    draw_string(ThemeDB.fallback_font, Vector2(470, 365), "Башкортостан • общий рынок", HORIZONTAL_ALIGNMENT_LEFT, -1, 24, Color("#e5f2ed"))
    draw_string(ThemeDB.fallback_font, Vector2(500, 405), "Уфа  |  Стерлитамак  |  Салават", HORIZONTAL_ALIGNMENT_LEFT, -1, 16, Color("#b6d5d0"))
    draw_rect(Rect2(100, 500, 220, 52), Color("#203640"))
    draw_string(ThemeDB.fallback_font, Vector2(120, 533), "Аренда помещений", HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color("#f3bf67"))
    draw_rect(Rect2(360, 500, 220, 52), Color("#203640"))
    draw_string(ThemeDB.fallback_font, Vector2(380, 533), "Контракты игроков", HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color("#f3bf67"))
    draw_rect(Rect2(620, 500, 220, 52), Color("#203640"))
    draw_string(ThemeDB.fallback_font, Vector2(640, 533), "Общий рынок", HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color("#f3bf67"))

func _on_connection_state_changed(state: String) -> void:
    var status := get_node_or_null("Hud/Status")
    if status:
        status.text = "Серверный мир: %s" % state
