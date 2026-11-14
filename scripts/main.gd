extends Node2D

const MAP_VIEW := preload("res://scripts/map/city_map_view.gd")
const REGION_VIEW := preload("res://scripts/map/region_map_view.gd")
const CHART := preload("res://scripts/ui/line_chart.gd")

var network: OnlineWorldClient
var map_view: CityMapView
var region_view: RegionMapView
var mode := "region" # region | city
var city_id := ""
var city_name := ""
var region: Dictionary = {}
var overlay_name := ""
var region_panel: PanelContainer
var region_title: Label
var region_info: Label
var region_chart: LineChart
var region_open: Button
var nav_region: HBoxContainer
var nav_city: HBoxContainer
var legend: PanelContainer
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
	status_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	status_label.custom_minimum_size = Vector2(520, 0)
	region_view = REGION_VIEW.new()
	add_child(region_view)
	region_view.city_selected.connect(_on_region_city_selected)
	region_view.site_selected.connect(_on_region_site_selected)
	map_view = MAP_VIEW.new()
	map_view.viewport_size = get_viewport_rect().size
	add_child(map_view)
	map_view.lot_selected.connect(_on_lot_selected)
	_build_extra_ui(ui)
	_set_mode("region")
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
	_load_region(true)


## Город растёт по игровым неделям: при смене недели подтягиваем свежую карту.
func _on_snapshot(_snapshot: Dictionary) -> void:
	_refresh_status()


func _on_game_tick(_tick: int) -> void:
	if company_id == "":
		return
	if mode == "region":
		_load_region(false)
	else:
		_load_city(false)


func _load_city(fit: bool) -> void:
	if city_id == "":
		return
	_call("map.get_city", {"city_id": city_id}, func(r):
		population = int(r["city"].get("population", 0))
		city_name = str(r["city"].get("name", city_id))
		_refresh_status()
		map_view.set_city(r["city"])
		map_view.set_overlay(overlay_name)
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
	if network == null:
		return
	var money := "" if company_id == "" else " • %s: %s" % [company_name, BashFormat.money(balance_cents)]
	var where := "Республика Башкортостан" if mode == "region" else city_name
	var pop := "" if (mode == "region" or population == 0) else " • население: %s" % BashFormat.thousands(population)
	var clock_text := network.clock_text_ru()
	status_label.text = "%s • %s%s%s%s" % [where, network.status_text_ru(), "" if clock_text == "" else " • " + clock_text, pop, money]


# ------------------------------------------------------------------ регион и навигация

func _load_region(fit: bool) -> void:
	_call("region.get", {}, func(r):
		region = r["region"]
		region_view.set_region(region)
		if fit:
			region_view.fit_to_view(get_viewport_rect().size)
		_on_region_city_selected(region_view.selected_city))


func _set_mode(m: String) -> void:
	mode = m
	var is_region := m == "region"
	region_view.visible = is_region
	map_view.visible = not is_region
	region_panel.visible = is_region
	legend.visible = is_region
	nav_region.visible = is_region
	nav_city.visible = not is_region
	get_node("Hud/UI/LotPanel").visible = not is_region
	_refresh_status()


func _on_region_city_selected(id: String) -> void:
	region_chart.visible = id != ""
	region_open.visible = id != ""
	if id == "":
		region_title.text = "Выберите город"
		region_info.text = "Нажмите на город или месторождение на карте региона. Перетаскивание — сдвиг, колесо или щипок — масштаб."
		return
	var c := region_view.city(id)
	if c.is_empty():
		return
	region_title.text = str(c["name"])
	region_info.text = "Население: %s\nСредняя зарплата: %s ₽/мес.\nЦена земли: %s за тайл\nПригодность земли для сельхоза: %d%%\nОтрасли: %s\nУчастков: %d, куплено: %d%s" % [
		BashFormat.thousands(int(c["population"])), BashFormat.thousands(int(c["wage_rub"])),
		BashFormat.money(int(c["land_base_cents_per_tile"])), int(float(c["farmland_index"]) * 100.0),
		BashFormat.tags(c["specialization"]), int(c["lots"]), int(c["owned_lots"]),
		"\nЛогистический хаб (внешний рынок)" if c.get("has_hub", false) else ""]
	_call("city.get_stats", {"city_id": id, "months": 24}, func(r):
		var hist: Array = r["stats"]["history"]
		var pops: Array = []
		for h in hist:
			pops.append(int(h["population"]))
		region_chart.set_data("Население по месяцам", pops))


func _on_region_site_selected(site: Dictionary) -> void:
	region_chart.visible = false
	region_open.visible = false
	region_title.text = str(site["name"])
	region_info.text = "%s\nЗапасы: %s из %s у.е.\nКачество: %d из 100\n%s" % [
		BashFormat.resource(str(site["resource"])), BashFormat.thousands(int(site["remaining"])), BashFormat.thousands(int(site["reserve"])),
		int(site["quality"]), "Принадлежит компании" if site.get("owned", false) else "Свободно (освоение — на следующих этапах)"]


func _open_city(id: String) -> void:
	if id == "":
		return
	city_id = id
	city_name = str(region_view.city(id).get("name", id))
	map_view.selected_lot_id = ""
	_on_lot_selected({})
	_set_mode("city")
	_load_city(true)


func _back_to_region() -> void:
	_set_mode("region")
	_load_region(false)


func _set_overlay(name: String) -> void:
	overlay_name = name
	map_view.set_overlay(name)


func _build_extra_ui(ui: Control) -> void:
	# Панель региона (справа внизу, на месте панели участка)
	region_panel = PanelContainer.new()
	region_panel.position = Vector2(920, 190)
	region_panel.size = Vector2(340, 510)
	ui.add_child(region_panel)
	var box := VBoxContainer.new()
	region_panel.add_child(box)
	region_title = Label.new()
	region_title.add_theme_font_size_override("font_size", 22)
	region_title.text = "Выберите город"
	box.add_child(region_title)
	region_info = Label.new()
	region_info.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	region_info.custom_minimum_size = Vector2(300, 0)
	box.add_child(region_info)
	region_chart = CHART.new()
	region_chart.custom_minimum_size = Vector2(300, 110)
	region_chart.visible = false
	box.add_child(region_chart)
	region_open = Button.new()
	region_open.text = "Открыть город"
	region_open.custom_minimum_size = Vector2(0, 56)
	region_open.visible = false
	region_open.pressed.connect(func(): _open_city(region_view.selected_city))
	box.add_child(region_open)
	# Слои региона
	nav_region = HBoxContainer.new()
	nav_region.position = Vector2(580, 24)
	ui.add_child(nav_region)
	for item in [["roads", "Дороги"], ["rails", "Ж/д"], ["resources", "Ресурсы"], ["hubs", "Хабы"]]:
		var cb := CheckButton.new()
		cb.text = item[1]
		cb.button_pressed = true
		var key: String = item[0]
		cb.toggled.connect(func(on): region_view.set_layer(key, on))
		nav_region.add_child(cb)
	# Навигация города
	nav_city = HBoxContainer.new()
	nav_city.position = Vector2(580, 24)
	ui.add_child(nav_city)
	var back := Button.new()
	back.text = "← Регион"
	back.custom_minimum_size = Vector2(140, 48)
	back.pressed.connect(_back_to_region)
	nav_city.add_child(back)
	var group := ButtonGroup.new()
	for item in [["", "Без слоя"], ["land", "Стоимость земли"], ["traffic", "Трафик"]]:
		var b := Button.new()
		b.text = item[1]
		b.toggle_mode = true
		b.button_group = group
		b.custom_minimum_size = Vector2(0, 48)
		b.button_pressed = item[0] == ""
		var key: String = item[0]
		b.pressed.connect(func(): _set_overlay(key))
		nav_city.add_child(b)
	# Легенда ресурсов
	legend = PanelContainer.new()
	legend.position = Vector2(24, 470)
	ui.add_child(legend)
	var lv := VBoxContainer.new()
	legend.add_child(lv)
	var lt := Label.new()
	lt.text = "Ресурсы"
	lv.add_child(lt)
	for k in RegionMapView.RESOURCE_COLORS:
		var row := HBoxContainer.new()
		var dot := ColorRect.new()
		dot.color = RegionMapView.RESOURCE_COLORS[k]
		dot.custom_minimum_size = Vector2(14, 14)
		row.add_child(dot)
		var l := Label.new()
		l.text = " " + BashFormat.resource(k)
		l.add_theme_font_size_override("font_size", 14)
		row.add_child(l)
		lv.add_child(row)
