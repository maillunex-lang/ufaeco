class_name CityMapView
extends PanZoomNode2D
## Изометрическая карта города на сетке клеток. Всё привязано к клеткам: земля, дороги, вода — тайлы 1×1; здания — прямоугольники W×H клеток
## (рисуются по габаритам, без растягивания спрайтов); участки — отдельные клетки с владельцем. Слои: зоны, стоимость земли, трафик, доступные клетки.
## Управление: перетаскивание — сдвиг, колесо/щипок — масштаб, касание/клик по клетке — выбор.

signal cell_selected(x: int, y: int)

const HALF_W := 66.0   # половина ширины ромба клетки
const HALF_H := 33.0   # половина высоты ромба клетки
const FLOOR_PX := 20.0 # высота этажа
const START_ZOOM := 0.5
const DIR := "res://assets/art/iso/"

# Стили городской застройки: стены/крыша (палитра проекта: бирюза, зелень, крем, золото).
const NPC_STYLE := {
	"house": {"wall": Color("#f1e6cf"), "roof": Color("#c97b5a")},
	"cottage": {"wall": Color("#ecdcc0"), "roof": Color("#b9694f")},
	"block": {"wall": Color("#e9e4d6"), "roof": Color("#8fa9a3")},
	"tower": {"wall": Color("#cfe3e6"), "roof": Color("#5c8f99"), "glass": true},
	"kiosk": {"wall": Color("#f6d88a"), "roof": Color("#2f9bb0")},
	"shop_row": {"wall": Color("#f3e3b0"), "roof": Color("#1f8fa8")},
	"mall": {"wall": Color("#f6efe0"), "roof": Color("#e0b23a"), "glass": true},
	"office": {"wall": Color("#bfe0ea"), "roof": Color("#3d7f92"), "glass": true},
	"shed": {"wall": Color("#b7c4c6"), "roof": Color("#7d8c8f")},
	"depot": {"wall": Color("#b3c2c5"), "roof": Color("#6f8286")},
	"workshop": {"wall": Color("#a9bcc0"), "roof": Color("#5d7479")},
	"warehouse": {"wall": Color("#c5d0cf"), "roof": Color("#6b8a8c"), "ridge": true},
	"plant": {"wall": Color("#9fb3b6"), "roof": Color("#566d72"), "chimney": true},
}

# Здания игроков: заметнее и ярче; floors — высота в этажах.
const PLAYER_STYLE := {
	"shop": {"wall": Color("#ffe9a8"), "roof": Color("#1f8fa8"), "floors": 2, "awning": true},
	"bakery": {"wall": Color("#ffd9a0"), "roof": Color("#c9602f"), "floors": 2, "chimney": true},
	"construction_office": {"wall": Color("#d9ecf2"), "roof": Color("#e0b23a"), "floors": 4, "glass": true},
	"mill": {"wall": Color("#e8dcc4"), "roof": Color("#7a5a3c"), "floors": 3, "ridge": true},
	"elevator": {"wall": Color("#f0e6b8"), "roof": Color("#8a9aa0"), "floors": 7, "silo": true},
	"farm": {"wall": Color("#e6cf9a"), "roof": Color("#5fae4f"), "floors": 2, "ridge": true},
}

const ZONE_TINT := {
	"r": Color(0.55, 0.85, 0.55, 0.28),
	"c": Color(0.95, 0.75, 0.2, 0.34),
	"i": Color(0.45, 0.55, 0.62, 0.34),
	"p": Color(0.2, 0.6, 0.2, 0.28),
}

var city: Dictionary = {}
var my_company_id: String = ""
var overlay: String = "" # "", "zones", "land", "traffic", "buyable"
var selected := Vector2i(-1, -1)
## Предпросмотр прямоугольника: {x, y, w, h, valid}; пустой — нет
var preview: Dictionary = {}
var viewport_size := Vector2(1280, 720)

var _tex := {}
var _owner_by_cell := {}   # "x,y" -> индекс владельца
var _building_at := {}     # "x,y" -> здание
var _sorted: Array = []    # здания, отсортированные по глубине


func _init() -> void:
	tapped.connect(_on_tapped)
	texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	min_zoom = 0.12
	max_zoom = 1.8
	for n in ["ground_grass", "water", "road", "bridge", "park_tree"]:
		_tex[n] = load(DIR + n + ".png")


static func iso(gx: float, gy: float) -> Vector2:
	return Vector2((gx - gy) * HALF_W, (gx + gy) * HALF_H)


func set_city(data: Dictionary) -> void:
	city = data
	_owner_by_cell.clear()
	_building_at.clear()
	for run in city["parcels"]["runs"]:
		for i in range(int(run[2])):
			_owner_by_cell["%d,%d" % [int(run[1]) + i, int(run[0])]] = int(run[3])
	for b in city["buildings"]:
		for dy in range(int(b["h"])):
			for dx in range(int(b["w"])):
				_building_at["%d,%d" % [int(b["x"]) + dx, int(b["y"]) + dy]] = b
	_sorted = (city["buildings"] as Array).duplicate()
	_sorted.sort_custom(func(a, b):
		var da: int = int(a["x"]) + int(a["w"]) + int(a["y"]) + int(a["h"])
		var db: int = int(b["x"]) + int(b["w"]) + int(b["y"]) + int(b["h"])
		return da < db or (da == db and int(a["x"]) < int(b["x"])))
	queue_redraw()


func refresh_city(data: Dictionary) -> void:
	set_city(data)


func fit_to_view(size: Vector2) -> void:
	viewport_size = size
	if city.is_empty():
		return
	var c: Dictionary = city.get("center", {"x": float(city["width"]) * 0.5, "y": float(city["height"]) * 0.5})
	var center := iso(float(c["x"]), float(c["y"])) + Vector2(0, HALF_H)
	scale = Vector2(START_ZOOM, START_ZOOM)
	position = size / 2.0 - center * START_ZOOM


func set_overlay(name: String) -> void:
	overlay = name
	queue_redraw()


func set_selected(x: int, y: int) -> void:
	selected = Vector2i(x, y)
	queue_redraw()


func set_preview(p: Dictionary) -> void:
	preview = p
	queue_redraw()


# ------------------------------------------------------------------ данные клетки

func in_bounds(x: int, y: int) -> bool:
	return not city.is_empty() and x >= 0 and y >= 0 and x < int(city["width"]) and y < int(city["height"])


func hex_at(rows: Array, x: int, y: int) -> int:
	return String(rows[y]).substr(x * 2, 2).hex_to_int()


func building_at(x: int, y: int) -> Dictionary:
	return _building_at.get("%d,%d" % [x, y], {})


## Индекс владельца клетки в city["parcels"]["owners"] или -1.
func owner_at(x: int, y: int) -> int:
	return _owner_by_cell.get("%d,%d" % [x, y], -1)


func owner_company_at(x: int, y: int) -> String:
	var i := owner_at(x, y)
	return "" if i < 0 else str(city["parcels"]["owners"][i]["id"])


## Цена клетки по формуле сервера: база × (0,35 + 1,65 × стоимость земли/100) × множитель города; 0 — не продаётся.
func price_at(x: int, y: int) -> int:
	if not is_buyable(x, y):
		return 0
	var lv := hex_at(city["cells"]["land_value"], x, y)
	return int(round(float(city["land_base_cents"]) * (0.35 + 1.65 * float(lv) / 100.0) * float(city["price_factor"])))


## Можно ли вообще купить клетку (земля у дорог, не парк, без здания и владельца).
func is_buyable(x: int, y: int) -> bool:
	return in_bounds(x, y) and String(city["cells"]["buyable"][y])[x] == "1" and building_at(x, y).is_empty() and owner_at(x, y) < 0


func zone_at(x: int, y: int) -> String:
	return String(city["cells"]["zones"][y])[x]


func cell_info(x: int, y: int) -> Dictionary:
	if not in_bounds(x, y):
		return {}
	var info := {
		"x": x, "y": y, "tile": String(city["tiles"][y])[x], "zone": zone_at(x, y),
		"land_value": hex_at(city["cells"]["land_value"], x, y), "traffic": hex_at(city["cells"]["traffic"], x, y),
		"buyable": is_buyable(x, y), "price_cents": price_at(x, y), "owner_company_id": owner_company_at(x, y),
		"owner_name": "", "building": building_at(x, y),
	}
	var oi := owner_at(x, y)
	if oi >= 0:
		info["owner_name"] = str(city["parcels"]["owners"][oi]["name"])
	return info


# ------------------------------------------------------------------ рисование

func _diamond(x: float, y: float, w: float = 1.0, h: float = 1.0) -> PackedVector2Array:
	return PackedVector2Array([iso(x, y), iso(x + w, y), iso(x + w, y + h), iso(x, y + h)])


func _draw() -> void:
	if city.is_empty():
		return
	var w := int(city["width"])
	var h := int(city["height"])
	var tiles: Array = city["tiles"]
	# 1. Земля: от дальних клеток к ближним.
	for s in range(w + h - 1):
		for gx in range(maxi(0, s - h + 1), mini(w - 1, s) + 1):
			var gy := s - gx
			var t: Texture2D
			match String(tiles[gy])[gx]:
				"#":
					t = _tex["road"]
				"~":
					t = _tex["water"]
				"=":
					t = _tex["bridge"]
				_:
					t = _tex["ground_grass"]
			draw_texture(t, iso(gx, gy) - Vector2(HALF_W, 0))
	# 2. Слои клеток и владение.
	_draw_overlay(w, h)
	_draw_parcels()
	# 3. Парки — деревья на клетках парковой зоны (без зданий).
	for gy in range(h):
		var zrow := String(city["cells"]["zones"][gy])
		for gx in range(w):
			if zrow[gx] == "p" and building_at(gx, gy).is_empty():
				draw_texture(_tex["park_tree"], iso(gx, gy) - Vector2(HALF_W, 0) + Vector2(0, -14))
	# 4. Здания по габаритам (по глубине).
	for b in _sorted:
		_draw_building(b)
	# 5. Предпросмотр и выделение.
	if not preview.is_empty():
		var col := Color(0.3, 0.8, 0.35, 0.55) if preview.get("valid", false) else Color(0.9, 0.25, 0.2, 0.55)
		var pts := _diamond(float(preview["x"]), float(preview["y"]), float(preview["w"]), float(preview["h"]))
		draw_colored_polygon(pts, col)
		var loop := pts.duplicate()
		loop.append(pts[0])
		draw_polyline(loop, Color.WHITE, 4.0)
	if selected.x >= 0:
		var sp := _diamond(float(selected.x), float(selected.y))
		sp.append(sp[0])
		draw_polyline(sp, BashPalette.GOLD_SOFT, 6.0)
	# 6. Подписи зданий игроков.
	_draw_labels()


func _draw_overlay(w: int, h: int) -> void:
	if overlay == "":
		return
	for gy in range(h):
		var zrow := String(city["cells"]["zones"][gy])
		for gx in range(w):
			var z := zrow[gx]
			if z == "-":
				continue
			var col := Color(0, 0, 0, 0)
			match overlay:
				"zones":
					col = ZONE_TINT.get(z, col)
				"land", "traffic":
					if z == "p" and overlay == "land":
						continue
					col = _heat(hex_at(city["cells"]["land_value" if overlay == "land" else "traffic"], gx, gy))
				"buyable":
					if is_buyable(gx, gy):
						col = Color(0.3, 0.85, 0.4, 0.35)
			if col.a > 0.0:
				draw_colored_polygon(_diamond(gx, gy), col)


## Тепловая карта: чем ярче, тем дороже земля / оживлённее трафик (как оверлеи в Capitalism).
func _heat(v: int) -> Color:
	if v < 25:
		return Color(0, 0, 0, 0)
	if v < 55:
		return Color(1.0, 0.92, 0.3, 0.5)
	if v < 80:
		return Color(1.0, 0.6, 0.15, 0.6)
	return Color(0.9, 0.2, 0.15, 0.68)


func _draw_parcels() -> void:
	var owners: Array = city["parcels"]["owners"]
	for run in city["parcels"]["runs"]:
		var oi := int(run[3])
		var mine := str(owners[oi]["id"]) == my_company_id
		var fill := Color(BashPalette.GOLD, 0.28) if mine else Color(BashPalette.TEAL, 0.28)
		var edge := BashPalette.GOLD if mine else BashPalette.TEAL_DEEP
		for i in range(int(run[2])):
			var x := int(run[1]) + i
			var y := int(run[0])
			var pts := _diamond(x, y)
			draw_colored_polygon(pts, fill)
			pts.append(pts[0])
			draw_polyline(pts, edge, 2.0)


func _draw_building(b: Dictionary) -> void:
	var x := float(b["x"])
	var y := float(b["y"])
	var w := float(b["w"])
	var h := float(b["h"])
	var kind := str(b["kind"])
	var npc: bool = bool(b.get("city_owned", false))
	var style: Dictionary = (NPC_STYLE if npc else PLAYER_STYLE).get(kind, {"wall": Color("#e9e4d6"), "roof": Color("#8fa9a3")})
	var floors := int(b["floors"]) if npc else int(style.get("floors", 2))
	var height := floors * FLOOR_PX
	var wall: Color = style["wall"]
	var roof: Color = style["roof"]
	var A := iso(x, y)
	var B := iso(x + w, y)
	var C := iso(x + w, y + h)
	var D := iso(x, y + h)
	var up := Vector2(0, -height)
	# левая и правая грани, затем крыша
	draw_colored_polygon(PackedVector2Array([D, C, C + up, D + up]), wall.darkened(0.12))
	draw_colored_polygon(PackedVector2Array([C, B, B + up, C + up]), wall.darkened(0.28))
	draw_colored_polygon(PackedVector2Array([A + up, B + up, C + up, D + up]), roof)
	var rim := PackedVector2Array([A + up, B + up, C + up, D + up, A + up])
	draw_polyline(rim, roof.darkened(0.3), 2.0)
	_windows(D, C, floors, int(h), wall.darkened(0.12), bool(style.get("glass", false)))
	_windows(C, B, floors, int(w), wall.darkened(0.28), bool(style.get("glass", false)))
	if style.get("awning", false):
		var a0 := D + Vector2(0, -FLOOR_PX * 0.9)
		var a1 := C + Vector2(0, -FLOOR_PX * 0.9)
		draw_colored_polygon(PackedVector2Array([a0, a1, a1 + Vector2(0, 8), a0 + Vector2(0, 8)]), BashPalette.GOLD)
	if style.get("ridge", false):
		draw_line((A + D) / 2.0 + up, (B + C) / 2.0 + up, roof.lightened(0.35), 4.0)
	if style.get("chimney", false):
		var p := iso(x + w - 0.7, y + 0.7) + up
		draw_colored_polygon(PackedVector2Array([p + Vector2(-7, 0), p + Vector2(7, 0), p + Vector2(5, -34), p + Vector2(-5, -34)]), Color("#6b7478"))
	if style.get("silo", false):
		for k in range(2):
			var sp := iso(x + 0.8 + float(k) * (w - 1.6), y + h * 0.5) + up
			draw_colored_polygon(PackedVector2Array([sp + Vector2(-16, 0), sp + Vector2(16, 0), sp + Vector2(16, -52), sp + Vector2(-16, -52)]), Color("#d8dde0"))
			draw_circle(sp + Vector2(0, -52), 16.0, Color("#aab5ba"))


## Окна на грани: ряды по этажам, число окон ~ длина грани в клетках.
func _windows(p0: Vector2, p1: Vector2, floors: int, cells: int, base: Color, glass: bool) -> void:
	var col := Color("#9ed6e6") if glass else base.lightened(0.45)
	var n := maxi(cells, 1) * 2
	for f in range(floors):
		for i in range(n):
			var u0 := (float(i) + 0.25) / float(n)
			var u1 := (float(i) + 0.75) / float(n)
			var v0 := float(f) * FLOOR_PX + FLOOR_PX * 0.3
			var v1 := v0 + FLOOR_PX * 0.45
			var a := p0.lerp(p1, u0) + Vector2(0, -v0)
			var b := p0.lerp(p1, u1) + Vector2(0, -v0)
			draw_colored_polygon(PackedVector2Array([a, b, b + Vector2(0, -(v1 - v0)), a + Vector2(0, -(v1 - v0))]), col)


func _draw_labels() -> void:
	var font := ThemeDB.fallback_font
	for b in _sorted:
		if bool(b.get("city_owned", false)) or b.get("name") == null:
			continue
		var x := float(b["x"])
		var y := float(b["y"])
		var top := iso(x + float(b["w"]) / 2.0, y + float(b["h"]) / 2.0) + Vector2(0, -float(PLAYER_STYLE.get(str(b["kind"]), {"floors": 2})["floors"]) * FLOOR_PX - 20.0)
		var text := "%s «%s»" % [BashFormat.kind(str(b["kind"])), str(b["name"])]
		var size := font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, 24)
		var r := Rect2(top - Vector2(size.x / 2.0 + 8, size.y), size + Vector2(16, 10))
		draw_rect(r, Color(1, 1, 1, 0.88))
		draw_rect(r, BashPalette.TEAL_DEEP, false, 2.0)
		draw_string(font, r.position + Vector2(8, size.y - 2), text, HORIZONTAL_ALIGNMENT_LEFT, -1, 24, BashPalette.TEAL_DEEP)


# ------------------------------------------------------------------ ввод

## Экран → клетка (обратная изометрическая проекция).
func grid_at(screen_pos: Vector2) -> Vector2i:
	var local := to_map(screen_pos)
	var u := local.x / HALF_W
	var v := local.y / HALF_H
	return Vector2i(floori((u + v) / 2.0), floori((v - u) / 2.0))


## Экранная точка центра клетки (для тестов).
func cell_screen_center(x: int, y: int) -> Vector2:
	return position + iso(float(x) + 0.5, float(y) + 0.5) * scale.x


func _on_tapped(screen_pos: Vector2) -> void:
	if city.is_empty():
		return
	var g := grid_at(screen_pos)
	if not in_bounds(g.x, g.y):
		return
	selected = g
	queue_redraw()
	cell_selected.emit(g.x, g.y)
