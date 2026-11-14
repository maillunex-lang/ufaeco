class_name CityMapView
extends Node2D
## Городская карта в стиле Capitalism 2: сетка тайлов, дороги, река, участки земли с зонами.
## Управление: перетаскивание — сдвиг, колесо/щипок — масштаб, касание/клик по участку — выбор.

signal lot_selected(lot: Dictionary)

const TILE := 32.0
const MIN_ZOOM := 0.4
const MAX_ZOOM := 2.5
const TAP_SLOP := 10.0

var city: Dictionary = {}
var my_company_id: String = ""
var selected_lot_id: String = ""

var _lots_by_id: Dictionary = {}
var _grid_lot: Dictionary = {} # "x,y" -> lot
var _dragging := false
var _press_pos := Vector2.ZERO
var _moved := 0.0
var _touches: Dictionary = {}
var _pinch_start_dist := 0.0
var _pinch_start_zoom := 1.0
var viewport_size := Vector2(1280, 720)

const ZONE_COLORS := {
	"residential": Color("#cfe9c3"),
	"commercial": Color("#f6e2a0"),
	"industrial": Color("#bfd0d6"),
	"park": Color("#7fc47a"),
}


func set_city(data: Dictionary) -> void:
	city = data
	_lots_by_id.clear()
	_grid_lot.clear()
	for lot in city.get("lots", []):
		_lots_by_id[lot["id"]] = lot
		for dy in range(int(lot["h"])):
			for dx in range(int(lot["w"])):
				_grid_lot["%d,%d" % [int(lot["x"]) + dx, int(lot["y"]) + dy]] = lot
	queue_redraw()


## Обновляет данные без сброса камеры (после покупки).
func refresh_city(data: Dictionary) -> void:
	set_city(data)


func fit_to_view(size: Vector2) -> void:
	viewport_size = size
	if city.is_empty():
		return
	var map_px := Vector2(float(city["width"]), float(city["height"])) * TILE
	var z := minf(size.x / map_px.x, size.y / map_px.y) * 0.95
	scale = Vector2(z, z)
	position = (size - map_px * z) / 2.0


func selected_lot() -> Dictionary:
	return _lots_by_id.get(selected_lot_id, {})


func _draw() -> void:
	if city.is_empty():
		return
	var w := int(city["width"])
	var h := int(city["height"])
	var tiles: Array = city["tiles"]
	draw_rect(Rect2(-8, -8, w * TILE + 16, h * TILE + 16), BashPalette.GREEN_DEEP.lerp(BashPalette.MINT, 0.6))
	for y in range(h):
		var row: String = tiles[y]
		for x in range(w):
			var r := Rect2(x * TILE, y * TILE, TILE, TILE)
			match row[x]:
				"#":
					draw_rect(r, BashPalette.ROAD)
					_road_marks(x, y, tiles, w, h)
				"~":
					draw_rect(r, BashPalette.TEAL)
					if (x + y) % 3 == 0:
						draw_line(r.position + Vector2(6, 12), r.position + Vector2(20, 12), BashPalette.TEAL_LIGHT, 2.0)
				"=":
					draw_rect(r, BashPalette.ROAD.lerp(BashPalette.WHITE, 0.2))
					if y % 5 == 0: # мост вдоль улицы: перила сверху и снизу
						draw_rect(Rect2(r.position, Vector2(TILE, 3)), BashPalette.TEAL_DEEP)
						draw_rect(Rect2(r.position + Vector2(0, TILE - 3), Vector2(TILE, 3)), BashPalette.TEAL_DEEP)
					else: # набережная вдоль реки: перила по бокам
						draw_rect(Rect2(r.position, Vector2(3, TILE)), BashPalette.TEAL_DEEP)
						draw_rect(Rect2(r.position + Vector2(TILE - 3, 0), Vector2(3, TILE)), BashPalette.TEAL_DEEP)
				_:
					draw_rect(r, BashPalette.MINT.lerp(BashPalette.CREAM, 0.5))
	for lot in city["lots"]:
		_draw_lot(lot)


func _road_marks(x: int, y: int, tiles: Array, w: int, h: int) -> void:
	var c := Vector2(x + 0.5, y + 0.5) * TILE
	var horiz: bool = (x > 0 and String(tiles[y])[x - 1] in "#=") and (x < w - 1 and String(tiles[y])[x + 1] in "#=")
	if horiz and y % 5 == 0:
		draw_line(c - Vector2(8, 0), c + Vector2(8, 0), BashPalette.WHITE, 2.0)
	elif x % 5 == 0:
		draw_line(c - Vector2(0, 8), c + Vector2(0, 8), BashPalette.WHITE, 2.0)


func _draw_lot(lot: Dictionary) -> void:
	var r := Rect2(float(lot["x"]) * TILE, float(lot["y"]) * TILE, float(lot["w"]) * TILE, float(lot["h"]) * TILE).grow(-2.0)
	var base: Color = ZONE_COLORS.get(lot["zone"], BashPalette.CREAM)
	draw_rect(r, base)
	var owned: bool = lot.get("owner_company_id") != null
	var mine: bool = owned and str(lot["owner_company_id"]) == my_company_id
	var border: Color = BashPalette.TEAL_DEEP.lerp(base, 0.55)
	var bw := 1.5
	if owned:
		border = BashPalette.GOLD if mine else BashPalette.TEAL_DEEP
		bw = 3.0
	draw_rect(r, border, false, bw)
	if owned:
		var flag := Rect2(r.position + Vector2(6, 6), Vector2(14, 14))
		draw_rect(flag, BashPalette.GOLD if mine else BashPalette.TEAL)
	if lot["id"] == selected_lot_id:
		draw_rect(r.grow(2.0), BashPalette.GOLD_SOFT, false, 4.0)


func _unhandled_input(event: InputEvent) -> void:
	if city.is_empty():
		return
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_WHEEL_UP and mb.pressed:
			_zoom_at(mb.position, 1.12)
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN and mb.pressed:
			_zoom_at(mb.position, 1.0 / 1.12)
		elif mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
				_dragging = true
				_press_pos = mb.position
				_moved = 0.0
			else:
				if _dragging and _moved < TAP_SLOP:
					_tap(mb.position)
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
				_press_pos = st.position
				_moved = 0.0
			elif _touches.size() == 2:
				_pinch_start_dist = _touch_distance()
				_pinch_start_zoom = scale.x
		else:
			var was_single := _touches.size() == 1
			_touches.erase(st.index)
			if was_single and _moved < TAP_SLOP:
				_tap(st.position)
	elif event is InputEventScreenDrag:
		var sd := event as InputEventScreenDrag
		_touches[sd.index] = sd.position
		if _touches.size() == 1:
			position += sd.relative
			_moved += sd.relative.length()
		elif _touches.size() == 2 and _pinch_start_dist > 0.0:
			var mid := _touch_center()
			var target := clampf(_pinch_start_zoom * _touch_distance() / _pinch_start_dist, MIN_ZOOM, MAX_ZOOM)
			_zoom_at(mid, target / scale.x)
			position += sd.relative * 0.5
			_moved += TAP_SLOP


func _touch_distance() -> float:
	var pts := _touches.values()
	return (pts[0] as Vector2).distance_to(pts[1] as Vector2)


func _touch_center() -> Vector2:
	var pts := _touches.values()
	return ((pts[0] as Vector2) + (pts[1] as Vector2)) / 2.0


func _zoom_at(screen_pos: Vector2, factor: float) -> void:
	var new_zoom := clampf(scale.x * factor, MIN_ZOOM, MAX_ZOOM)
	var f := new_zoom / scale.x
	position = screen_pos - (screen_pos - position) * f
	scale = Vector2(new_zoom, new_zoom)


func _tap(screen_pos: Vector2) -> void:
	var local := (screen_pos - position) / scale.x
	var key := "%d,%d" % [floori(local.x / TILE), floori(local.y / TILE)]
	if _grid_lot.has(key):
		selected_lot_id = _grid_lot[key]["id"]
		lot_selected.emit(_grid_lot[key])
	else:
		selected_lot_id = ""
		lot_selected.emit({})
	queue_redraw()
