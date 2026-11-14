class_name CityMapView
extends Node2D
## Изометрическая городская карта (стиль Capitalism 2): тайлы земли, дороги, река, участки и застройка.
## Спрайты — Kenney, CC0 (assets/art/iso/CREDITS.md). Здания на участках пока декоративные.
## Управление: перетаскивание — сдвиг, колесо/щипок — масштаб, касание/клик по участку — выбор.

signal lot_selected(lot: Dictionary)

const HALF_W := 66.0   # половина ширины ромба тайла (132 px)
const HALF_H := 33.0   # половина высоты ромба (66 px)
const MIN_ZOOM := 0.12
const MAX_ZOOM := 1.6
const START_ZOOM := 0.42
const TAP_SLOP := 10.0
const DIR := "res://assets/art/iso/"

# Наборы зданий по зонам (номера buildingTiles_NNN из Kenney Isometric Buildings #1).
const BUILDINGS := {
	"commercial": [1, 2, 3, 4, 9, 10, 16, 17, 18, 20, 26, 28, 34, 41, 99, 100, 101, 108, 109, 113, 115, 116, 117, 123, 124, 125],
	"residential": [14, 21, 22, 29, 30, 32, 36, 37, 38, 39, 42, 43, 44, 45, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56],
	"industrial": [11, 19, 27, 35, 85, 92, 93, 106, 114, 122],
}

var city: Dictionary = {}
var my_company_id: String = ""
var selected_lot_id: String = ""
var viewport_size := Vector2(1280, 720)

# Игровые здания: вид предприятия → спрайт (номер buildingTiles), оттенок и высота. Ширина ×2 — под участок 2×2, высота — tall.
const KIND_STYLE := {
	"shop": {"tall": 2.4, "sprite": 108, "tint": Color(1, 1, 1)},
	"bakery": {"tall": 2.4, "sprite": 113, "tint": Color(1, 0.95, 0.85)},
	"construction_office": {"tall": 3.0, "sprite": 123, "tint": Color(0.9, 0.95, 1)},
	"mill": {"tall": 2.8, "sprite": 106, "tint": Color(0.85, 0.95, 1)},
	"elevator": {"tall": 3.8, "sprite": 85, "tint": Color(1, 0.93, 0.7)},
	"farm": {"tall": 2.0, "sprite": 27, "tint": Color(0.8, 1, 0.75)},
}

var _tex := {}
var _bld_tex := {}
var _offsets := {}
var _lots_by_id := {}
var _grid_lot := {}
var _objects: Array = [] # [depth, gx, Texture2D, Vector2 pos, Vector2 scale, Color tint]
var _labels: Array = [] # [Vector2 anchor, String text]
var _dragging := false
var _moved := 0.0
var _touches := {}
var _pinch_start_dist := 0.0
var _pinch_start_zoom := 1.0


func _init() -> void:
	texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	for n in ["ground_grass", "water", "road_ew", "road_ns", "road_cross", "bridge", "park_tree"]:
		_tex[n] = load(DIR + n + ".png")
	for k in KIND_STYLE:
		var id: int = KIND_STYLE[k]["sprite"]
		if not _bld_tex.has(id):
			_bld_tex[id] = load(DIR + "buildings/b%03d.png" % id)
	for zone in BUILDINGS:
		for id in BUILDINGS[zone]:
			if not _bld_tex.has(id):
				_bld_tex[id] = load(DIR + "buildings/b%03d.png" % id)


static func iso(gx: float, gy: float) -> Vector2:
	return Vector2((gx - gy) * HALF_W, (gx + gy) * HALF_H)


## Вертикальный сдвиг здания, чтобы его верхняя грань совпала с гранью земли (по левой вершине ромба).
func _offset(tex: Texture2D) -> float:
	if _offsets.has(tex):
		return _offsets[tex]
	var img := tex.get_image()
	var y := 0
	while y < img.get_height() and img.get_pixel(3, y).a < 0.5:
		y += 1
	var off := float(y) - 33.0
	_offsets[tex] = off
	return off


func set_city(data: Dictionary) -> void:
	city = data
	_lots_by_id.clear()
	_grid_lot.clear()
	_objects.clear()
	_labels.clear()
	for lot in city.get("lots", []):
		_lots_by_id[lot["id"]] = lot
		var zone: String = lot["zone"]
		var lot_seed: int = hash(str(lot["id"]))
		var building = lot.get("building")
		if building != null:
			_add_building(lot, building)
		for dy in range(int(lot["h"])):
			for dx in range(int(lot["w"])):
				var gx := int(lot["x"]) + dx
				var gy := int(lot["y"]) + dy
				_grid_lot["%d,%d" % [gx, gy]] = lot
				if building != null:
					continue # вместо декора на участке стоит игровое здание
				var tex: Texture2D
				if zone == "park":
					tex = _tex["park_tree"]
				else:
					var set_: Array = BUILDINGS[zone]
					tex = _bld_tex[set_[absi(hash("%d:%d:%d" % [lot_seed, gx, gy])) % set_.size()]]
				var pos := iso(gx, gy) - Vector2(tex.get_width() / 2.0, _offset(tex))
				_objects.append([gx + gy, gx, tex, pos, Vector2.ONE, Color.WHITE])
	_objects.sort_custom(func(a, b): return a[0] < b[0] or (a[0] == b[0] and a[1] < b[1]))
	queue_redraw()


func _add_building(lot: Dictionary, building: Dictionary) -> void:
	var style: Dictionary = KIND_STYLE.get(building["kind"], KIND_STYLE["shop"])
	var tex: Texture2D = _bld_tex[style["sprite"]]
	var sc := float(lot["w"])
	var x := int(lot["x"])
	var y := int(lot["y"])
	var sy: float = float(style["tall"])
	var h := float(tex.get_height())
	# Низ спрайта остаётся на уровне участка; вверх здание растягивается до нужной высоты.
	var pos := iso(x, y) - Vector2(tex.get_width() * sc / 2.0, _offset(tex) * sc) + Vector2(0, h * sc - h * sy)
	_objects.append([x + y + int(lot["w"]) + int(lot["h"]) - 2, x + int(lot["w"]) - 1, tex, pos, Vector2(sc, sy), style["tint"]])
	var top := pos + Vector2(tex.get_width() * sc / 2.0, h * sy * 0.12)
	_labels.append([top, "%s «%s»" % [BashFormat.kind(str(building["kind"])), str(building["name"])]])


func refresh_city(data: Dictionary) -> void:
	set_city(data)


## Камера: центр города (коммерческий центр) при заданном масштабе.
func fit_to_view(size: Vector2) -> void:
	viewport_size = size
	if city.is_empty():
		return
	var center := iso(float(city["width"]) * 0.42, float(city["height"]) * 0.5) + Vector2(0, HALF_H)
	scale = Vector2(START_ZOOM, START_ZOOM)
	position = size / 2.0 - center * START_ZOOM


func selected_lot() -> Dictionary:
	return _lots_by_id.get(selected_lot_id, {})


func _draw() -> void:
	if city.is_empty():
		return
	var w := int(city["width"])
	var h := int(city["height"])
	var tiles: Array = city["tiles"]
	# 1. Земля: от дальних тайлов к ближним.
	for s in range(w + h - 1):
		for gx in range(maxi(0, s - h + 1), mini(w - 1, s) + 1):
			var gy := s - gx
			var t: Texture2D
			match String(tiles[gy])[gx]:
				"#":
					t = _tex["road_cross"] if (gx % 5 == 0 and gy % 5 == 0) else (_tex["road_ew"] if gy % 5 == 0 else _tex["road_ns"])
				"~":
					t = _tex["water"]
				"=":
					t = _tex["bridge"]
				_:
					t = _tex["ground_grass"]
			draw_texture(t, iso(gx, gy) - Vector2(HALF_W, 0))
	# 2. Здания и деревья (уже отсортированы по глубине).
	for o in _objects:
		var t: Texture2D = o[2]
		draw_texture_rect(t, Rect2(o[3], t.get_size() * (o[4] as Vector2)), false, o[5])
	# 3. Границы владения и выделение.
	for lot in city["lots"]:
		var owned = lot.get("owner_company_id") != null
		var sel: bool = lot["id"] == selected_lot_id
		if not owned and not sel:
			continue
		var x := float(lot["x"])
		var y := float(lot["y"])
		var pts := PackedVector2Array([iso(x, y), iso(x + lot["w"], y), iso(x + lot["w"], y + lot["h"]), iso(x, y + lot["h"]), iso(x, y)])
		if owned:
			var mine: bool = str(lot["owner_company_id"]) == my_company_id
			draw_polyline(pts, BashPalette.GOLD if mine else BashPalette.TEAL_DEEP, 7.0)
		if sel:
			draw_polyline(pts, BashPalette.GOLD_SOFT, 10.0)
	_draw_labels()


func _draw_labels() -> void:
	var font := ThemeDB.fallback_font
	for l in _labels:
		var text: String = l[1]
		var size := font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, 26)
		var r := Rect2(l[0] - Vector2(size.x / 2.0 + 10, size.y), size + Vector2(20, 12))
		draw_rect(r, Color(1, 1, 1, 0.85))
		draw_rect(r, BashPalette.TEAL_DEEP, false, 2.0)
		draw_string(font, r.position + Vector2(10, size.y - 2), text, HORIZONTAL_ALIGNMENT_LEFT, -1, 26, BashPalette.TEAL_DEEP)


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
			var target := clampf(_pinch_start_zoom * _touch_distance() / _pinch_start_dist, MIN_ZOOM, MAX_ZOOM)
			_zoom_at(_touch_center(), target / scale.x)
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


## Экран → сетка (обратная изометрическая проекция).
func grid_at(screen_pos: Vector2) -> Vector2i:
	var local := (screen_pos - position) / scale.x
	var u := local.x / HALF_W
	var v := local.y / HALF_H
	return Vector2i(floori((u + v) / 2.0), floori((v - u) / 2.0))


## Экран-центр участка (для тестов и подсветки).
func lot_screen_center(lot: Dictionary) -> Vector2:
	var c := iso(float(lot["x"]) + float(lot["w"]) / 2.0, float(lot["y"]) + float(lot["h"]) / 2.0)
	return position + c * scale.x


func _tap(screen_pos: Vector2) -> void:
	var g := grid_at(screen_pos)
	var key := "%d,%d" % [g.x, g.y]
	if _grid_lot.has(key):
		selected_lot_id = _grid_lot[key]["id"]
		lot_selected.emit(_grid_lot[key])
	else:
		selected_lot_id = ""
		lot_selected.emit({})
	queue_redraw()
