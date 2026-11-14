class_name RegionMapView
extends PanZoomNode2D
## Карта Республики Башкортостан на сетке ячеек (≈ 8 км): земля и реки — ячейки, города занимают ячейки (3×3, 2×2, 1×1),
## месторождения — по одной ячейке, дороги и железные дороги идут по ячейкам. Данные — команда region.get (поле grid).

signal city_selected(city_id: String)
signal site_selected(site: Dictionary)

const CELL := 20.0

const RESOURCE_COLORS := {
	"oil": Color("#2b2b2b"),
	"copper_zinc": Color("#c8764a"),
	"gold": Color("#e0b23a"),
	"iron_ore": Color("#8a5a44"),
	"limestone": Color("#b9c4c9"),
	"timber": Color("#2f6b3a"),
	"clay_sand": Color("#d9c27a"),
}

var region: Dictionary = {}
var layers := {"roads": true, "rails": true, "resources": true, "hubs": true}
var selected_city := ""
var selected_site := ""

var _grid: Dictionary = {}


func _init() -> void:
	min_zoom = 0.25
	max_zoom = 3.0
	tapped.connect(_on_tap)
	zoomed.connect(queue_redraw)


func set_region(data: Dictionary) -> void:
	region = data
	_grid = region["grid"]
	queue_redraw()


func fit_to_view(_size: Vector2, area := Rect2(Vector2(260, 175), Vector2(640, 525))) -> void:
	if region.is_empty():
		return
	var extent := Vector2(float(_grid["width"]), float(_grid["height"])) * CELL
	var z := minf(area.size.x / extent.x, area.size.y / extent.y) * 0.97
	scale = Vector2(z, z)
	position = area.position + (area.size - extent * z) / 2.0


func city(id: String) -> Dictionary:
	for c in region.get("cities", []):
		if c["id"] == id:
			return c
	return {}


## Прямоугольник города в ячейках: {x, y, w, h}.
func city_rect(id: String) -> Rect2:
	var r: Dictionary = _grid["cities"][id]
	return Rect2(float(r["x"]), float(r["y"]), float(r["w"]), float(r["h"]))


func city_screen_pos(id: String) -> Vector2:
	var r := city_rect(id)
	return position + (r.position + r.size / 2.0) * CELL * scale.x


func resource_screen_pos(id: String) -> Vector2:
	var p: Dictionary = _grid["resources"][id]
	return position + (Vector2(float(p["x"]), float(p["y"])) + Vector2(0.5, 0.5)) * CELL * scale.x


func set_layer(name: String, on: bool) -> void:
	layers[name] = on
	queue_redraw()


func _center(id: String) -> Vector2:
	var r := city_rect(id)
	return (Vector2(floorf(r.position.x + floorf(r.size.x / 2.0)), floorf(r.position.y + floorf(r.size.y / 2.0))) + Vector2(0.5, 0.5)) * CELL


func _link_points(link: Dictionary) -> PackedVector2Array:
	var pts := PackedVector2Array()
	for c in link["cells"]:
		pts.append((Vector2(float(c[0]), float(c[1])) + Vector2(0.5, 0.5)) * CELL)
	return pts


func _draw() -> void:
	if region.is_empty():
		return
	var mask: Array = _grid["mask"]
	var w := int(_grid["width"])
	var h := int(_grid["height"])
	var land := BashPalette.MINT.lerp(BashPalette.CREAM, 0.45)
	var edge := Color(BashPalette.GREEN_DEEP, 0.18)
	for y in range(h):
		var row := String(mask[y])
		for x in range(w):
			var ch := row[x]
			if ch == " ":
				continue
			var r := Rect2(Vector2(x, y) * CELL, Vector2(CELL, CELL))
			draw_rect(r, BashPalette.TEAL if ch == "~" else land)
			draw_rect(r, edge, false, 1.0)
	if layers["roads"]:
		for link in _grid["roads"]:
			draw_polyline(_link_points(link), Color(0.5, 0.55, 0.58, 0.95), 4.0)
	if layers["rails"]:
		var pts_all: Array = []
		for link in _grid["rails"]:
			pts_all.append(_link_points(link))
		for pts in pts_all:
			for i in range(pts.size() - 1):
				draw_dashed_line(pts[i], pts[i + 1], BashPalette.TEAL_DEEP, 4.0, 8.0)
	var inv := 1.0 / scale.x
	if layers["resources"]:
		for r in region["resources"]:
			var cell: Dictionary = r["cell"]
			var rect := Rect2(Vector2(float(cell["x"]), float(cell["y"])) * CELL + Vector2(3, 3), Vector2(CELL - 6, CELL - 6))
			draw_rect(rect, RESOURCE_COLORS.get(r["resource"], Color.GRAY))
			draw_rect(rect, Color.WHITE, false, 2.0)
			if r["id"] == selected_site:
				draw_rect(rect.grow(4.0), BashPalette.GOLD, false, 4.0)
	var font := ThemeDB.fallback_font
	var fs := clampi(int(17.0 * inv), 14, 44)
	for c in region["cities"]:
		var rc := city_rect(c["id"])
		var rect := Rect2(rc.position * CELL, rc.size * CELL).grow(-1.0)
		if layers["hubs"] and c.get("has_hub", false):
			draw_rect(rect.grow(4.0), BashPalette.GOLD, false, 5.0)
		draw_rect(rect, BashPalette.CREAM)
		draw_rect(rect, BashPalette.TEAL_DEEP, false, 3.0)
		# «дома» внутри ячеек города: по клетке на ячейку
		for dy in range(int(rc.size.y)):
			for dx in range(int(rc.size.x)):
				var cr := Rect2((rc.position + Vector2(dx, dy)) * CELL + Vector2(5, 5), Vector2(CELL - 10, CELL - 10))
				draw_rect(cr, BashPalette.TEAL.lerp(BashPalette.CREAM, 0.35))
		if c["id"] == selected_city:
			draw_rect(rect.grow(7.0), BashPalette.GOLD, false, 5.0)
		draw_string(font, Vector2(rect.end.x + 6.0, rect.position.y + rect.size.y / 2.0 + fs * 0.35), str(c["name"]), HORIZONTAL_ALIGNMENT_LEFT, -1, fs, BashPalette.TEAL_DEEP)


func _on_tap(screen_pos: Vector2) -> void:
	if region.is_empty():
		return
	var local := to_map(screen_pos)
	var cx := floori(local.x / CELL)
	var cy := floori(local.y / CELL)
	# город: клик по любой ячейке его габарита (с допуском в одну ячейку вокруг)
	var best := ""
	var best_d := 1e9
	for c in region["cities"]:
		var rc := city_rect(c["id"]).grow(1.0)
		if rc.has_point(Vector2(float(cx) + 0.5, float(cy) + 0.5)):
			var d := (city_rect(c["id"]).get_center() - Vector2(float(cx) + 0.5, float(cy) + 0.5)).length()
			if d < best_d:
				best_d = d
				best = c["id"]
	if best != "":
		selected_city = best
		selected_site = ""
		queue_redraw()
		city_selected.emit(best)
		return
	if layers["resources"]:
		for r in region["resources"]:
			var cell: Dictionary = r["cell"]
			if int(cell["x"]) == cx and int(cell["y"]) == cy:
				selected_site = r["id"]
				selected_city = ""
				queue_redraw()
				site_selected.emit(r)
				return
	selected_city = ""
	selected_site = ""
	queue_redraw()
	city_selected.emit("")
