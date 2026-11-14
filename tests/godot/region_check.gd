extends SceneTree
## Проверка региональной карты и навигации: регион → город → слои → назад.
## Нужны запущенный сервер и виртуальный экран:
## xvfb-run -a godot --path . --rendering-driver opengl3 --script res://tests/godot/region_check.gd

var _fails := 0

func _check(c: bool, m: String) -> void:
	print(("  ok   " if c else "  FAIL ") + m)
	if not c:
		_fails += 1

func _tap(pos: Vector2) -> void:
	var t := InputEventMouseButton.new()
	t.button_index = MOUSE_BUTTON_LEFT
	t.pressed = true
	t.position = pos
	Input.parse_input_event(t)
	var r := InputEventMouseButton.new()
	r.button_index = MOUSE_BUTTON_LEFT
	r.pressed = false
	r.position = pos
	Input.parse_input_event(r)

func _initialize() -> void:
	var main = load("res://scenes/main.tscn").instantiate()
	root.add_child(main)
	await create_timer(4.0).timeout
	var rv = main.region_view
	_check(main.mode == "region" and rv.visible, "стартовый режим — регион")
	_check(rv.region.get("cities", []).size() == 21, "21 город на карте региона")
	_check(rv.region.get("resources", []).size() >= 20, "месторождения загружены")
	_check(rv.region.get("outline", []).size() > 100, "контур региона загружен")

	_tap(rv.city_screen_pos("ufa"))
	await create_timer(0.8).timeout
	_check(rv.selected_city == "ufa" and main.region_title.text == "Уфа", "тап по городу выбирает его: " + main.region_title.text)
	_check(main.region_info.text.find("Население: 1 145 000") != -1, "в панели население Уфы")
	_check(main.region_open.visible, "кнопка «Открыть город» видна")

	rv.set_layer("rails", false)
	_check(rv.layers["rails"] == false, "слой ж/д отключается")
	rv.set_layer("rails", true)

	var z0: float = rv.scale.x
	rv.zoom_at(Vector2(640, 360), 1.5)
	_check(rv.scale.x > z0, "масштаб региона меняется")

	main.region_open.pressed.emit()
	await create_timer(1.5).timeout
	_check(main.mode == "city" and main.city_id == "ufa", "открыт город Уфа")
	_check(main.map_view.visible and not rv.visible, "показана карта города, регион скрыт")
	_check(main.map_view.city.get("lots", []).size() > 50, "участки города загружены")

	main._set_overlay("land")
	_check(main.map_view.overlay == "land", "оверлей «стоимость земли» включён")
	main._set_overlay("traffic")
	_check(main.map_view.overlay == "traffic", "оверлей «трафик» включён")

	main._back_to_region()
	await create_timer(1.0).timeout
	_check(main.mode == "region" and rv.visible and not main.map_view.visible, "возврат на карту региона")

	# месторождение
	var site: Dictionary = rv.region["resources"][0]
	var sp: Vector2 = rv.position + rv.project(float(site["lon"]), float(site["lat"])) * rv.scale.x
	_tap(sp)
	await create_timer(0.5).timeout
	_check(rv.selected_site != "" or rv.selected_city != "", "тап по месторождению/городу в точке ресурса выбирает объект")

	print("ИТОГО: %s" % ("УСПЕХ" if _fails == 0 else "ПРОВАЛ"))
	quit(0 if _fails == 0 else 1)
