extends Node2D

const MAP_VIEW := preload("res://scripts/map/city_map_view.gd")

var network: OnlineWorldClient
var map_view: CityMapView
var company_id: String = ""
var company_name: String = ""
var balance_cents: int = 0
var _pending: Dictionary = {} # request_id -> Callable(payload)
var _bootstrapped := false
var population: int = 0
var catalog: Dictionary = {} # kind -> {cost_cents, zones}
var _build_kinds: Array[String] = []

@onready var status_label: Label = %Status
@onready var error_label: Label = %NetError
@onready var lot_title: Label = %LotTitle
@onready var lot_info: Label = %LotInfo
@onready var buy_button: Button = %BuyButton
@onready var kind_option: OptionButton = %KindOption
@onready var build_name: LineEdit = %BuildName
@onready var build_button: Button = %BuildButton


func _ready() -> void:
	RenderingServer.set_default_clear_color(BashPalette.GREEN_DEEP.lerp(BashPalette.MINT, 0.55))
	var ui := get_node("Hud/UI") as Control
	ui.theme = BashTheme.build()
	map_view = MAP_VIEW.new()
	map_view.viewport_size = get_viewport_rect().size
	add_child(map_view)
	map_view.lot_selected.connect(_on_lot_selected)
	buy_button.pressed.connect(_on_buy_pressed)
	build_button.pressed.connect(_on_build_pressed)
	kind_option.item_selected.connect(func(_i): _update_build_button())
	network = OnlineWorldClient.new()
	add_child(network)
	network.connection_state_changed.connect(_on_connection_state_changed)
	network.server_tick_changed.connect(func(_t): _refresh_status())
	network.network_error.connect(func(m): error_label.text = m)
	network.command_result_received.connect(_on_command_result)
	network.world_snapshot_received.connect(_on_snapshot)
	network.game_tick_changed.connect(_on_game_tick)
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
		_call("catalog.get", {}, func(r):
			for k in r["enterprise_kinds"]:
				catalog[str(k["kind"])] = k
			_call("company.list", {}, _on_company_list))


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


## Город растёт по игровым неделям: при смене недели подтягиваем свежую карту.
func _on_snapshot(_snapshot: Dictionary) -> void:
	_refresh_status()


func _on_game_tick(_tick: int) -> void:
	if company_id != "":
		_load_city(false)


func _load_city(fit: bool) -> void:
	_call("map.get_city", {"city_id": "ufa"}, func(r):
		population = int(r["city"].get("population", 0))
		_refresh_status()
		map_view.set_city(r["city"])
		if fit:
			map_view.fit_to_view(get_viewport_rect().size)
		_on_lot_selected(map_view.selected_lot()))


func _on_lot_selected(lot: Dictionary) -> void:
	kind_option.visible = false
	build_name.visible = false
	build_button.visible = false
	buy_button.visible = true
	buy_button.disabled = true
	if lot.is_empty():
		lot_title.text = "Выберите участок"
		lot_info.text = "Нажмите на участок карты. Перетаскивание — сдвиг, колесо или щипок — масштаб."
		return
	lot_title.text = "%s • %d×%d" % [BashFormat.zone(str(lot["zone"])), int(lot["w"]), int(lot["h"])]
	var price := int(lot["price_cents"])
	var owner = lot.get("owner_company_id")
	var building = lot.get("building")
	if str(lot["zone"]) == "park":
		lot_info.text = "Городской парк. Не продаётся."
	elif building != null:
		buy_button.visible = false
		lot_info.text = _building_text(lot, building)
	elif owner != null and str(owner) == company_id:
		buy_button.visible = false
		lot_info.text = "Ваш участок %s. Построить предприятие:" % str(lot["id"])
		_show_build_ui(lot)
	elif owner != null:
		lot_info.text = "Владелец: %s" % str(lot.get("owner_name", "—"))
	elif not lot.get("for_sale", false):
		lot_info.text = "Застроено городом (уровень %d из 3). Не продаётся." % int(lot.get("development", 0))
	else:
		lot_info.text = "Участок %s\nЦена: %s\nПокупает: %s" % [str(lot["id"]), BashFormat.money(price), company_name]
		buy_button.disabled = company_id == "" or price > balance_cents


func _building_text(lot: Dictionary, building: Dictionary) -> String:
	var k := str(building["kind"])
	var text := "%s «%s»" % [BashFormat.kind(k), str(building["name"])]
	var info: Dictionary = catalog.get(k, {})
	if not info.is_empty():
		text += "\nСтоимость постройки: %s" % BashFormat.money(int(info["cost_cents"]))
	text += "\nПроизводство появится на следующих этапах."
	var owner = lot.get("owner_company_id")
	text += "\nВладелец: %s%s" % [str(lot.get("owner_name", "—")), " (вы)" if owner != null and str(owner) == company_id else ""]
	return text


func _show_build_ui(lot: Dictionary) -> void:
	_build_kinds.clear()
	kind_option.clear()
	for k in catalog:
		if str(lot["zone"]) in catalog[k]["zones"]:
			_build_kinds.append(k)
			kind_option.add_item("%s — %s" % [BashFormat.kind(k), BashFormat.money(int(catalog[k]["cost_cents"]))])
	if _build_kinds.is_empty():
		lot_info.text += "\nВ этой зоне строить нечего."
		return
	build_name.text = ""
	kind_option.visible = true
	build_name.visible = true
	build_button.visible = true
	_update_build_button()


func _update_build_button() -> void:
	var idx := kind_option.selected
	if idx < 0 or idx >= _build_kinds.size():
		return
	var k := _build_kinds[idx]
	var cost := int(catalog[k]["cost_cents"])
	build_button.text = "Построить за %s" % BashFormat.money(cost)
	build_button.disabled = cost > balance_cents


func _on_build_pressed() -> void:
	var lot := map_view.selected_lot()
	var idx := kind_option.selected
	if lot.is_empty() or idx < 0 or idx >= _build_kinds.size():
		return
	var k := _build_kinds[idx]
	var name_text := build_name.text.strip_edges()
	if name_text.length() < 2:
		name_text = "%s №%d" % [BashFormat.kind(k), randi() % 900 + 100]
	build_button.disabled = true
	_call("enterprise.create", {"company_id": company_id, "kind": k, "name": name_text, "lot_id": str(lot["id"])}, func(r):
		balance_cents = int(r["enterprise"]["balance_cents"])
		_refresh_status()
		_load_city(false))


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
	var pop := "" if population == 0 else " • население: %s" % BashFormat.thousands(population)
	var clock_text := network.clock_text_ru()
	status_label.text = "Сервер: %s%s%s%s%s" % [network.status_text_ru(), "" if clock_text == "" else " • " + clock_text, pop, money, ""]
