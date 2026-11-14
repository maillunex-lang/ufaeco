extends SceneTree
## Проверка карты: масштаб, перетаскивание, выбор участка. Нужен запущенный сервер и окно (xvfb-run, --rendering-driver opengl3):
## xvfb-run -a godot --path . --rendering-driver opengl3 --script res://tests/godot/map_check.gd
var _fails := 0
func _check(c: bool, m: String) -> void:
	print(("  ok   " if c else "  FAIL ") + m)
	if not c:
		_fails += 1
func _initialize() -> void:
	var main = load("res://scenes/main.tscn").instantiate()
	root.add_child(main)
	await create_timer(3.0).timeout
	main._open_city("ufa")
	await create_timer(1.5).timeout
	var mv = main.map_view
	var z0: float = mv.scale.x
	var p0: Vector2 = mv.position
	# колесо: приближение
	var wheel := InputEventMouseButton.new()
	wheel.button_index = MOUSE_BUTTON_WHEEL_UP; wheel.pressed = true; wheel.position = Vector2(640, 360)
	Input.parse_input_event(wheel)
	await process_frame
	_check(mv.scale.x > z0, "колесо увеличивает масштаб (%.3f → %.3f)" % [z0, mv.scale.x])
	# перетаскивание
	var press := InputEventMouseButton.new()
	press.button_index = MOUSE_BUTTON_LEFT; press.pressed = true; press.position = Vector2(600, 400)
	Input.parse_input_event(press)
	var mot := InputEventMouseMotion.new()
	mot.position = Vector2(660, 430); mot.relative = Vector2(60, 30)
	Input.parse_input_event(mot)
	var rel := InputEventMouseButton.new()
	rel.button_index = MOUSE_BUTTON_LEFT; rel.pressed = false; rel.position = Vector2(660, 430)
	Input.parse_input_event(rel)
	await process_frame
	var before: Vector2 = mv.position
	_check(before != p0, "перетаскивание сдвигает карту")
	# тап по участку
	# выбрать клетку, ближайшую к точке (560, 380)
	var target := Vector2i(-1, -1)
	var best := 1e9
	for y in range(int(mv.city["height"])):
		for x in range(int(mv.city["width"])):
			var d: float = mv.cell_screen_center(x, y).distance_to(Vector2(560, 380))
			if d < best:
				best = d
				target = Vector2i(x, y)
	var screen: Vector2 = mv.cell_screen_center(target.x, target.y)
	var tp := InputEventMouseButton.new()
	tp.button_index = MOUSE_BUTTON_LEFT; tp.pressed = true; tp.position = screen
	Input.parse_input_event(tp)
	var tr := InputEventMouseButton.new()
	tr.button_index = MOUSE_BUTTON_LEFT; tr.pressed = false; tr.position = screen
	Input.parse_input_event(tr)
	await process_frame
	_check(mv.selected == target, "тап выбирает клетку %s" % str(target))
	_check(main.cell_title.text.begins_with("Клетка"), "панель клетки заполнена: " + main.cell_title.text)
	var gp: Vector2i = mv.grid_at(screen)
	_check(gp == target, "обратная проекция совпадает с клеткой")
	print("ИТОГО: %s" % ("УСПЕХ" if _fails == 0 else "ПРОВАЛ"))
	quit(0 if _fails == 0 else 1)
