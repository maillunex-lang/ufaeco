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
	var target: Dictionary = {}
	var best := 1e9
	for l in mv.city["lots"]:
		var sp: Vector2 = mv.position + (Vector2(float(l["x"]) + 1.0, float(l["y"]) + 1.0)) * mv.TILE * mv.scale.x
		var d := sp.distance_to(Vector2(560, 380))
		if d < best:
			best = d
			target = l
	var local: Vector2 = (Vector2(float(target["x"]) + 0.5, float(target["y"]) + 0.5)) * mv.TILE
	var screen: Vector2 = mv.position + local * mv.scale.x
	var tp := InputEventMouseButton.new()
	tp.button_index = MOUSE_BUTTON_LEFT; tp.pressed = true; tp.position = screen
	Input.parse_input_event(tp)
	var tr := InputEventMouseButton.new()
	tr.button_index = MOUSE_BUTTON_LEFT; tr.pressed = false; tr.position = screen
	Input.parse_input_event(tr)
	await process_frame
	_check(mv.selected_lot_id == target["id"], "тап выбирает участок %s" % target["id"])
	_check(main.lot_title.text != "Выберите участок", "панель участка заполнена: " + main.lot_title.text)
	print("ИТОГО: %s" % ("УСПЕХ" if _fails == 0 else "ПРОВАЛ"))
	quit(0 if _fails == 0 else 1)
