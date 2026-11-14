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
# --- панель клетки (город)
var cell_panel: PanelContainer
var cell_title: Label
var cell_info: Label
var cell_mode := "inspect" # inspect | buy | build
var buy_w: SpinBox
var buy_h: SpinBox
var buy_row: VBoxContainer
var build_row: VBoxContainer
var buy_label: Label
var build_label: Label
var buy_button: Button
var build_button: Button
var demolish_button: Button
var kind_option: OptionButton
var rotate_check: CheckButton
var build_name: LineEdit
var mode_buy_button: Button
var mode_build_button: Button
var sel := Vector2i(-1, -1)
var server_dialog: PanelContainer
var server_edit: LineEdit
var server_hint: Label
var server_button: Button
var _ever_online := false
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
	map_view.cell_selected.connect(_on_cell_selected)
	_build_extra_ui(ui)
	var blocker := Callable(self, "_over_ui")
	region_view.is_blocked = blocker
	map_view.is_blocked = blocker
	_set_mode("region")
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
	if state == "online":
		_ever_online = true
		server_dialog.visible = false
	elif (state == "reconnecting" or state == "failed") and not _ever_online:
		_show_server_dialog(true)
	if state == "online" and not _bootstrapped:
		_bootstrapped = true
		_call("catalog.get", {}, func(r):
			for k in r["enterprise_kinds"]:
				catalog[str(k["kind"])] = k
			_fill_kind_options()
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


## Города растут по игровым неделям; часы в шапке обновляются с каждым snapshot.
func _on_snapshot(_snapshot: Dictionary) -> void:
	_refresh_status()


func _on_game_tick(_tick: int) -> void:
	# Города и показатели меняются раз в игровую неделю — карту перезагружаем только тогда.
	if company_id == "" or not bool(network.clock.get("is_week_start", false)):
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
		_refresh_cell_panel())


# ------------------------------------------------------------------ клетки: покупка и постройка

func _on_cell_selected(x: int, y: int) -> void:
	sel = Vector2i(x, y)
	_refresh_cell_panel()


func _clear_cell() -> void:
	sel = Vector2i(-1, -1)
	cell_mode = "inspect"
	map_view.set_selected(-1, -1)
	map_view.set_preview({})
	_refresh_cell_panel()


func _kind_footprint(kind: String) -> Vector2i:
	var fp: Dictionary = catalog.get(kind, {}).get("footprint", {"w": 1, "h": 1})
	var w := int(fp["w"])
	var h := int(fp["h"])
	return Vector2i(h, w) if rotate_check.button_pressed else Vector2i(w, h)


func _selected_kind() -> String:
	var idx := kind_option.selected
	return "" if idx < 0 or idx >= _build_kinds.size() else _build_kinds[idx]


func _set_cell_mode(m: String) -> void:
	cell_mode = m if cell_mode != m else "inspect"
	_refresh_cell_panel()


## Проверка покупки прямоугольника на клиенте (окончательно решает сервер): все клетки продаются и свободны.
func _rect_buyable(x: int, y: int, w: int, h: int) -> bool:
	for yy in range(y, y + h):
		for xx in range(x, x + w):
			if not map_view.is_buyable(xx, yy):
				return false
	return true


func _rect_total_price(x: int, y: int, w: int, h: int) -> int:
	var total := 0
	for yy in range(y, y + h):
		for xx in range(x, x + w):
			total += map_view.price_at(xx, yy)
	return total


## Проверка постройки: клетки свои, без зданий, зона подходит виду.
func _rect_buildable(kind: String, x: int, y: int, w: int, h: int) -> bool:
	var zones: Array = catalog.get(kind, {}).get("zones", [])
	for yy in range(y, y + h):
		for xx in range(x, x + w):
			if not map_view.in_bounds(xx, yy) or map_view.owner_company_at(xx, yy) != company_id or not map_view.building_at(xx, yy).is_empty():
				return false
			if not (BashFormat.zone_by_letter(map_view.zone_at(xx, yy)) in zones):
				return false
	return true


## Только зонирование (для проверок): подходит ли зона клеток виду здания, без учёта владения.
func _rect_buildable_zone_only(kind: String, x: int, y: int, w: int, h: int) -> bool:
	var zones: Array = catalog.get(kind, {}).get("zones", [])
	for yy in range(y, y + h):
		for xx in range(x, x + w):
			if not (BashFormat.zone_by_letter(map_view.zone_at(xx, yy)) in zones):
				return false
	return true


func _refresh_cell_panel() -> void:
	buy_row.visible = cell_mode == "buy"
	build_row.visible = cell_mode == "build"
	demolish_button.visible = false
	map_view.set_preview({})
	mode_buy_button.button_pressed = cell_mode == "buy"
	mode_build_button.button_pressed = cell_mode == "build"
	if sel.x < 0:
		cell_title.text = "Выберите клетку"
		cell_info.text = "Нажмите на клетку карты. Перетаскивание — сдвиг, колесо или щипок — масштаб."
		mode_buy_button.disabled = true
		mode_build_button.disabled = true
		return
	map_view.set_selected(sel.x, sel.y)
	var info := map_view.cell_info(sel.x, sel.y)
	if info.is_empty():
		return
	cell_title.text = "Клетка %d, %d" % [sel.x, sel.y]
	var b: Dictionary = info["building"]
	var lines: Array[String] = []
	var tile: String = info["tile"]
	if tile == "#" or tile == "=":
		lines.append("Дорога")
	elif tile == "~":
		lines.append("Вода")
	else:
		lines.append("%s • стоимость земли %d • трафик %d" % [BashFormat.zone_by_letter_ru(info["zone"]), int(info["land_value"]), int(info["traffic"])])
	if not b.is_empty():
		if bool(b.get("city_owned", false)):
			lines.append("Городская застройка: %s %d×%d, этажей: %d" % [BashFormat.npc_kind(str(b["kind"])), int(b["w"]), int(b["h"]), int(b["floors"])])
		else:
			lines.append("%s «%s» %d×%d" % [BashFormat.kind(str(b["kind"])), str(b.get("name", "")), int(b["w"]), int(b["h"])])
			lines.append("Владелец: %s%s" % [str(b.get("owner_name", "—")), " (вы)" if str(b.get("owner_company_id")) == company_id else ""])
			demolish_button.visible = str(b.get("owner_company_id")) == company_id
	elif str(info["owner_company_id"]) != "":
		lines.append("Земля: %s%s" % [str(info["owner_name"]), " (вы)" if str(info["owner_company_id"]) == company_id else ""])
	elif bool(info["buyable"]):
		lines.append("Свободна. Цена: %s" % BashFormat.money(int(info["price_cents"])))
	elif tile == "." and info["zone"] == "p":
		lines.append("Городской парк. Не продаётся.")
	elif tile == ".":
		lines.append("Вне городской черты — не продаётся.")
	cell_info.text = "\n".join(lines)
	mode_buy_button.disabled = company_id == "" or not bool(info["buyable"])
	mode_build_button.disabled = company_id == "" or str(info["owner_company_id"]) != company_id or not b.is_empty()
	if cell_mode == "buy":
		_update_buy_preview()
	elif cell_mode == "build":
		_update_build_preview()


func _update_buy_preview() -> void:
	var w := int(buy_w.value)
	var h := int(buy_h.value)
	var ok := _rect_buyable(sel.x, sel.y, w, h)
	map_view.set_preview({"x": sel.x, "y": sel.y, "w": w, "h": h, "valid": ok})
	var total := _rect_total_price(sel.x, sel.y, w, h) if ok else 0
	buy_label.text = "Участок %d×%d = %d клеток" % [w, h, w * h] + ("\nЦена: %s" % BashFormat.money(total) if ok else "\nНельзя: есть занятые или не продающиеся клетки")
	buy_button.disabled = not ok or total > balance_cents
	buy_button.text = "Купить за %s" % BashFormat.money(total) if ok else "Купить"


func _update_build_preview() -> void:
	var kind := _selected_kind()
	if kind == "":
		build_label.text = "В этой зоне строить нечего."
		build_button.disabled = true
		return
	var fp := _kind_footprint(kind)
	var ok := _rect_buildable(kind, sel.x, sel.y, fp.x, fp.y)
	map_view.set_preview({"x": sel.x, "y": sel.y, "w": fp.x, "h": fp.y, "valid": ok})
	var cost := int(catalog[kind]["cost_cents"])
	build_label.text = "%s: %d×%d клеток" % [BashFormat.kind(kind), fp.x, fp.y] + ("" if ok else "\nНельзя: клетки должны быть вашими, свободными и подходящей зоны")
	build_button.disabled = not ok or cost > balance_cents
	build_button.text = "Построить за %s" % BashFormat.money(cost)


func _fill_kind_options() -> void:
	_build_kinds.clear()
	kind_option.clear()
	for k in catalog:
		_build_kinds.append(k)
		var fp: Dictionary = catalog[k]["footprint"]
		kind_option.add_item("%s %d×%d — %s" % [BashFormat.kind(k), int(fp["w"]), int(fp["h"]), BashFormat.money(int(catalog[k]["cost_cents"]))])


func _on_buy_pressed() -> void:
	if sel.x < 0 or company_id == "":
		return
	var args := {"company_id": company_id, "city_id": city_id, "x": sel.x, "y": sel.y, "w": int(buy_w.value), "h": int(buy_h.value)}
	buy_button.disabled = true
	_call("map.buy_cells", args, func(r):
		balance_cents = int(r["purchase"]["balance_cents"])
		cell_mode = "inspect"
		_refresh_status()
		_load_city(false))


func _on_build_pressed() -> void:
	var kind := _selected_kind()
	if sel.x < 0 or kind == "" or company_id == "":
		return
	var name_text := build_name.text.strip_edges()
	if name_text.length() < 2:
		name_text = "%s №%d" % [BashFormat.kind(kind), randi() % 900 + 100]
	build_button.disabled = true
	_call("building.place", {"company_id": company_id, "city_id": city_id, "x": sel.x, "y": sel.y, "kind": kind,
		"rotated": rotate_check.button_pressed, "name": name_text}, func(r):
		balance_cents = int(r["enterprise"]["balance_cents"])
		cell_mode = "inspect"
		_refresh_status()
		_load_city(false))


func _on_demolish_pressed() -> void:
	var b := map_view.building_at(sel.x, sel.y)
	if b.is_empty():
		return
	_call("building.demolish", {"building_id": str(b["id"])}, func(_r): _load_city(false))


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
	cell_panel.visible = not is_region
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
	region_info.text = "Население: %s\nСредняя зарплата: %s ₽/мес.\nЦена земли: %s за клетку\nПригодность земли для сельхоза: %d%%\nОтрасли: %s\nЗданий: %d, клеток в собственности: %d%s" % [
		BashFormat.thousands(int(c["population"])), BashFormat.thousands(int(c["wage_rub"])),
		BashFormat.money(int(c["land_base_cents_per_tile"])), int(float(c["farmland_index"]) * 100.0),
		BashFormat.tags(c["specialization"]), int(c["buildings"]), int(c["owned_cells"]),
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
	_clear_cell()
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
	for item in [["", "Без слоя"], ["zones", "Зоны"], ["land", "Земля"], ["traffic", "Трафик"], ["buyable", "Купить"]]:
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
	_build_cell_panel(ui)
	_build_server_dialog(ui)


## Над панелью/кнопкой интерфейса ли точка экрана (карта такие касания игнорирует).
func _over_ui(pos: Vector2) -> bool:
	var ui := get_node("Hud/UI") as Control
	for n in ui.get_children():
		if n is Control and (n as Control).visible and (n as Control).get_global_rect().has_point(pos):
			return true
	return false


func _show_server_dialog(from_error: bool) -> void:
	server_edit.text = network.websocket_url
	server_hint.text = ("Не удалось подключиться к серверу. " if from_error else "") + "Введите адрес сервера (ws://адрес:порт/путь).\nЭмулятор Android: ws://10.0.2.2:8080/ws\nТелефон в той же сети: ws://IP-компьютера:8080/ws"
	server_dialog.visible = true


func _on_server_apply() -> void:
	if network.change_server(server_edit.text):
		server_dialog.visible = false
		_bootstrapped = false
		company_id = ""
		error_label.text = ""
	else:
		server_hint.text = "Неверный адрес. Пример: ws://192.168.0.10:8080/ws"


func _build_server_dialog(ui: Control) -> void:
	server_button = Button.new()
	server_button.text = "Сервер"
	server_button.position = Vector2(1130, 24)
	server_button.custom_minimum_size = Vector2(120, 48)
	server_button.pressed.connect(func(): _show_server_dialog(false))
	ui.add_child(server_button)
	server_dialog = PanelContainer.new()
	server_dialog.position = Vector2(300, 200)
	server_dialog.custom_minimum_size = Vector2(680, 0)
	ui.add_child(server_dialog)
	var box := VBoxContainer.new()
	server_dialog.add_child(box)
	var t := Label.new()
	t.text = "Адрес сервера"
	t.add_theme_font_size_override("font_size", 24)
	box.add_child(t)
	server_hint = Label.new()
	server_hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	server_hint.custom_minimum_size = Vector2(640, 0)
	box.add_child(server_hint)
	server_edit = LineEdit.new()
	server_edit.custom_minimum_size = Vector2(0, 56)
	server_edit.placeholder_text = "ws://192.168.0.10:8080/ws"
	box.add_child(server_edit)
	var row := HBoxContainer.new()
	box.add_child(row)
	var ok := Button.new()
	ok.text = "Подключиться"
	ok.custom_minimum_size = Vector2(220, 56)
	ok.pressed.connect(_on_server_apply)
	row.add_child(ok)
	var close := Button.new()
	close.text = "Закрыть"
	close.custom_minimum_size = Vector2(160, 56)
	close.pressed.connect(func(): server_dialog.visible = false)
	row.add_child(close)
	server_dialog.visible = false


func _build_cell_panel(ui: Control) -> void:
	cell_panel = PanelContainer.new()
	cell_panel.position = Vector2(890, 330)
	cell_panel.size = Vector2(370, 380)
	ui.add_child(cell_panel)
	var box := VBoxContainer.new()
	cell_panel.add_child(box)
	cell_title = Label.new()
	cell_title.add_theme_font_size_override("font_size", 20)
	box.add_child(cell_title)
	cell_info = Label.new()
	cell_info.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	cell_info.custom_minimum_size = Vector2(330, 0)
	box.add_child(cell_info)
	var modes := HBoxContainer.new()
	box.add_child(modes)
	mode_buy_button = Button.new()
	mode_buy_button.text = "Купить землю"
	mode_buy_button.toggle_mode = true
	mode_buy_button.custom_minimum_size = Vector2(150, 48)
	mode_buy_button.pressed.connect(func(): _set_cell_mode("buy"))
	modes.add_child(mode_buy_button)
	mode_build_button = Button.new()
	mode_build_button.text = "Построить"
	mode_build_button.toggle_mode = true
	mode_build_button.custom_minimum_size = Vector2(150, 48)
	mode_build_button.pressed.connect(func(): _set_cell_mode("build"))
	modes.add_child(mode_build_button)
	# покупка: размер прямоугольника
	buy_row = VBoxContainer.new()
	box.add_child(buy_row)
	var sizes := HBoxContainer.new()
	buy_row.add_child(sizes)
	var lw := Label.new()
	lw.text = "Ширина"
	sizes.add_child(lw)
	buy_w = SpinBox.new()
	buy_w.min_value = 1
	buy_w.max_value = 12
	buy_w.value = 2
	buy_w.value_changed.connect(func(_v): _update_buy_preview())
	sizes.add_child(buy_w)
	var lh := Label.new()
	lh.text = " Высота"
	sizes.add_child(lh)
	buy_h = SpinBox.new()
	buy_h.min_value = 1
	buy_h.max_value = 12
	buy_h.value = 2
	buy_h.value_changed.connect(func(_v): _update_buy_preview())
	sizes.add_child(buy_h)
	buy_label = Label.new()
	buy_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	buy_label.custom_minimum_size = Vector2(330, 0)
	buy_row.add_child(buy_label)
	buy_button = Button.new()
	buy_button.text = "Купить"
	buy_button.custom_minimum_size = Vector2(0, 52)
	buy_button.pressed.connect(_on_buy_pressed)
	buy_row.add_child(buy_button)
	# постройка
	build_row = VBoxContainer.new()
	box.add_child(build_row)
	kind_option = OptionButton.new()
	kind_option.custom_minimum_size = Vector2(0, 44)
	kind_option.item_selected.connect(func(_i): _update_build_preview())
	build_row.add_child(kind_option)
	rotate_check = CheckButton.new()
	rotate_check.text = "Повернуть на 90°"
	rotate_check.toggled.connect(func(_on): _update_build_preview())
	build_row.add_child(rotate_check)
	build_name = LineEdit.new()
	build_name.placeholder_text = "Название предприятия"
	build_name.max_length = 40
	build_name.custom_minimum_size = Vector2(0, 44)
	build_row.add_child(build_name)
	build_label = Label.new()
	build_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	build_label.custom_minimum_size = Vector2(330, 0)
	build_row.add_child(build_label)
	build_button = Button.new()
	build_button.text = "Построить"
	build_button.custom_minimum_size = Vector2(0, 52)
	build_button.pressed.connect(_on_build_pressed)
	build_row.add_child(build_button)
	demolish_button = Button.new()
	demolish_button.text = "Снести здание"
	demolish_button.custom_minimum_size = Vector2(0, 48)
	demolish_button.pressed.connect(_on_demolish_pressed)
	box.add_child(demolish_button)
	buy_row.visible = false
	build_row.visible = false
	demolish_button.visible = false
	cell_panel.visible = false
