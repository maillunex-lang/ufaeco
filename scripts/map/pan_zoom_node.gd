class_name PanZoomNode2D
extends Node2D
## Узел с управлением камерой: перетаскивание — сдвиг, колесо/щипок — масштаб, касание/клик — tapped.

signal tapped(screen_pos: Vector2)
signal zoomed

const TAP_SLOP := 10.0

var min_zoom := 0.12
var max_zoom := 1.6
var _dragging := false
var _moved := 0.0
var _touches := {}
var _pinch_start_dist := 0.0
var _pinch_start_zoom := 1.0


func _unhandled_input(event: InputEvent) -> void:
	if not is_visible_in_tree():
		return
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_WHEEL_UP and mb.pressed:
			zoom_at(mb.position, 1.12)
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN and mb.pressed:
			zoom_at(mb.position, 1.0 / 1.12)
		elif mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
				_dragging = true
				_moved = 0.0
			else:
				if _dragging and _moved < TAP_SLOP:
					tapped.emit(mb.position)
				_dragging = false
	elif event is InputEventMouseMotion and _dragging:
		var mm := event as InputEventMouseMotion
		position += mm.relative
		_moved += mm.relative.length()
	elif event is InputEventScreenTouch:
		var st := event as InputEventScreenTouch
		if st.pressed:
			_touches[st.index] = st.position
			if _touches.size() == 1:
				_moved = 0.0
			elif _touches.size() == 2:
				_pinch_start_dist = _touch_distance()
				_pinch_start_zoom = scale.x
		else:
			var was_single := _touches.size() == 1
			_touches.erase(st.index)
			if was_single and _moved < TAP_SLOP:
				tapped.emit(st.position)
	elif event is InputEventScreenDrag:
		var sd := event as InputEventScreenDrag
		_touches[sd.index] = sd.position
		if _touches.size() == 1:
			position += sd.relative
			_moved += sd.relative.length()
		elif _touches.size() == 2 and _pinch_start_dist > 0.0:
			var target := clampf(_pinch_start_zoom * _touch_distance() / _pinch_start_dist, min_zoom, max_zoom)
			zoom_at(_touch_center(), target / scale.x)
			position += sd.relative * 0.5
			_moved += TAP_SLOP


func _touch_distance() -> float:
	var pts := _touches.values()
	return (pts[0] as Vector2).distance_to(pts[1] as Vector2)


func _touch_center() -> Vector2:
	var pts := _touches.values()
	return ((pts[0] as Vector2) + (pts[1] as Vector2)) / 2.0


func zoom_at(screen_pos: Vector2, factor: float) -> void:
	var new_zoom := clampf(scale.x * factor, min_zoom, max_zoom)
	var f := new_zoom / scale.x
	position = screen_pos - (screen_pos - position) * f
	scale = Vector2(new_zoom, new_zoom)
	zoomed.emit()


## Экран → локальные координаты узла.
func to_map(screen_pos: Vector2) -> Vector2:
	return (screen_pos - position) / scale.x
