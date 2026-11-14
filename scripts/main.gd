extends Node2D

const MAP_VIEW := preload("res://scripts/map/city_map_view.gd")

var network: OnlineWorldClient
var map_view: CityMapView
var company_id: String = ""
var company_name: String = ""
var balance_cents: int = 0
var _pending: Dictionary = {} # request_id -> Callable(payload)
var _bootstrapped := false

@onready var status_label: Label = %Status
@onready var error_label: Label = %NetError
@onready var lot_title: Label = %LotTitle
@onready var lot_info: Label = %LotInfo
@onready var buy_button: Button = %BuyButton


func _ready() -> void:
	RenderingServer.set_default_clear_color(BashPalette.GREEN_DEEP.lerp(BashPalette.MINT, 0.55))
	var ui := get_node("Hud/UI") as Control
	ui.theme = BashTheme.build()
	map_view = MAP_VIEW.new()
	map_view.viewport_size = get_viewport_rect().size
	add_child(map_view)
	map_view.lot_selected.connect(_on_lot_selected)
	buy_button.pressed.connect(_on_buy_pressed)
	network = OnlineWorldClient.new()
	add_child(network)
	network.connection_state_changed.connect(_on_connection_state_changed)
	network.server_tick_changed.connect(func(_t): _refresh_status())
	network.network_error.connect(func(m): error_label.text = m)
	network.command_result_received.connect(_on_command_result)
	network.connect_to_world()


func _call(command_name: String, args: Dictionary, on_ok: Callable) -> void:
	var rid := network.send_command(command_name, args)
	if rid != "":
		_pending[rid] = on_ok


func _on_command_result(request_id: String, payload: Dictionary) -> void:
	var cb = _pending.get(request_id)
	_pending.erase(request_id)
	if not payload.get("ok", false):
		var code := str(payload.get("error", {}).get("code", ""))
		error_label.text = OnlineWorldClient.ERROR_TEXTS_RU.get(code, "Операция отклонена сервером.")
		return
	error_label.text = ""
	if cb != null:
		cb.call(payload.get("result", {}))


func _on_connection_state_changed(state: String) -> void:
	_refresh_status()
	if state == "online" and not _bootstrapped:
		_bootstrapped = true
		_call("company.list", {}, _on_company_list)


func _on_company_list(result: Dictionary) -> void:
	var list: Array = result.get("companies", [])
	if list.is_empty():
		_call("company.create", {"name": "Компания %d" % (randi() % 9000 + 1000)}, func(r): _use_company(r["company"]))
	else:
		_use_company(list[0])


func _use_company(c: Dictionary) -> void:
	company_id = str(c["id"])
	company_name = str(c["name"])
	balance_cents = int(c["balance_cents"])
	map_view.my_company_id = company_id
	_refresh_status()
	_load_city(true)


func _load_city(fit: bool) -> void:
	_call("map.get_city", {"city_id": "ufa"}, func(r):
		map_view.set_city(r["city"])
		if fit:
			map_view.fit_to_view(get_viewport_rect().size)
		_on_lot_selected(map_view.selected_lot()))


func _on_lot_selected(lot: Dictionary) -> void:
	if lot.is_empty():
		lot_title.text = "Выберите участок"
		lot_info.text = "Нажмите на участок карты. Перетаскивание — сдвиг, колесо или щипок — масштаб."
		buy_button.disabled = true
		return
	lot_title.text = "%s • %d×%d" % [BashFormat.zone(str(lot["zone"])), int(lot["w"]), int(lot["h"])]
	var price := int(lot["price_cents"])
	var owner = lot.get("owner_company_id")
	if str(lot["zone"]) == "park":
		lot_info.text = "Городской парк. Не продаётся."
		buy_button.disabled = true
	elif owner != null:
		lot_info.text = "Владелец: %s%s" % [str(lot.get("owner_name", "—")), " (вы)" if str(owner) == company_id else ""]
		buy_button.disabled = true
	else:
		lot_info.text = "Участок %s\nЦена: %s\nПокупает: %s" % [str(lot["id"]), BashFormat.money(price), company_name]
		buy_button.disabled = company_id == "" or price > balance_cents


func _on_buy_pressed() -> void:
	var lot := map_view.selected_lot()
	if lot.is_empty() or company_id == "":
		return
	buy_button.disabled = true
	_call("map.buy_lot", {"company_id": company_id, "lot_id": str(lot["id"])}, func(r):
		balance_cents = int(r["purchase"]["balance_cents"])
		_refresh_status()
		_load_city(false))


func _refresh_status() -> void:
	var money := "" if company_id == "" else " • %s: %s" % [company_name, BashFormat.money(balance_cents)]
	status_label.text = "Сервер: %s • день %d%s" % [network.status_text_ru(), network.economy_day, money]
