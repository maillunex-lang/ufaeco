extends SceneTree
## Проверка офлайн-демо (сервер НЕ нужен): xvfb-run -a godot --path . --rendering-driver opengl3 --script res://tests/godot/demo_check.gd
var _fails := 0
func _check(c: bool, m: String) -> void:
	print(("  ok   " if c else "  FAIL ") + m)
	if not c:
		_fails += 1
func _initialize() -> void:
	var main = load("res://scenes/main.tscn").instantiate()
	root.add_child(main)
	await create_timer(1.0).timeout
	main._on_demo_pressed()
	await create_timer(1.5).timeout
	_check(main.network.demo_mode, "демо включено")
	_check(main.network.state == "demo", "состояние demo")
	_check(main.company_id == "demo-company", "демо-компания выбрана")
	_check(main.region.has("cities"), "регион загружен")
	main._open_city("ufa")
	await create_timer(1.5).timeout
	_check(main.map_view.visible, "карта города показана")
	_check(main.population > 0, "население Уфы: %d" % main.population)
	main.get_viewport().get_texture().get_image().save_png("/tmp/demo_city.png")
	main._call("map.buy_cells", {}, func(_r): pass)
	await create_timer(0.5).timeout
	_check(main.error_label.text.contains("Демо"), "действия в демо отклоняются: " + main.error_label.text)
	print("FAILS: %d" % _fails)
	quit(1 if _fails > 0 else 0)
