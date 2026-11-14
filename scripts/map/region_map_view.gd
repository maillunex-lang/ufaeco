class_name RegionMapView
extends PanZoomNode2D
## Схематичная карта Республики Башкортостан: контур, реки, автодороги и железные дороги, хабы, месторождения, города.
## Данные — команда region.get (контур и реки — Natural Earth, public domain). Тап по городу/месторождению — выбор.

signal city_selected(city_id: String)
signal site_selected(site: Dictionary)

const KM_PX := 2.0
const KM_PER_DEG := 111.0

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

var _lon0 := 0.0
var _lat1 := 0.0
var _cos := 0.588
var _city_pos := {}


func _init() -> void:
	min_zoom = 0.25
	max_zoom = 3.0
	tapped.connect(_on_tap)
	zoomed.connect(queue_redraw)


func project(lon: float, lat: float) -> Vector2:
	return Vector2((lon - _lon0) * _cos * KM_PER_DEG * KM_PX, (_lat1 - lat) * KM_PER_DEG * KM_PX)


func set_region(data: Dictionary) -> void:
	region = data
	var bbox: Array = region["bbox"]
	_lon0 = float(bbox[0])
	_lat1 = float(bbox[3])
	_cos = cos(deg_to_rad((float(bbox[1]) + float(bbox[3])) / 2.0))
	_city_pos.clear()
	for c in region["cities"]:
		_city_pos[c["id"]] = project(float(c["lon"]), float(c["lat"]))
	queue_redraw()


## Вписать регион в прямоугольник экрана (свободная область между панелями интерфейса).
func fit_to_view(size: Vector2, area := Rect2(Vector2(260, 175), Vector2(640, 525))) -> void:
	if region.is_empty():
		return
	var bbox: Array = region["bbox"]
	var br := project(float(bbox[2]), float(bbox[1]))
	var z := minf(area.size.x / br.x, area.size.y / br.y) * 0.97
	scale = Vector2(z, z)
	position = area.position + (area.size - br * z) / 2.0


func city(id: String) -> Dictionary:
	for c in region.get("cities", []):
		if c["id"] == id:
			return c
	return {}


func city_screen_pos(id: String) -> Vector2:
	return position + (_city_pos[id] as Vector2) * scale.x


func set_layer(name: String, on: bool) -> void:
	layers[name] = on
	queue_redraw()


func _draw() -> void:
	if region.is_empty():
		return
	var outline := PackedVector2Array()
	for p in region["outline"]:
		outline.append(project(float(p[0]), float(p[1])))
	draw_colored_polygon(outline, BashPalette.MINT.lerp(BashPalette.CREAM, 0.45))
	var closed := outline.duplicate()
	closed.append(outline[0])
	draw_polyline(closed, BashPalette.GREEN_DEEP, 4.0)
	for r in region["rivers"]:
		var pts := PackedVector2Array()
		for p in r["points"]:
			pts.append(project(float(p[0]), float(p[1])))
		draw_polyline(pts, BashPalette.TEAL, 5.0)
	if layers["roads"]:
		for e in region["roads"]:
			draw_line(_city_pos[e["a"]], _city_pos[e["b"]], Color(0.55, 0.6, 0.62, 0.9), 3.0)
	if layers["rails"]:
		for e in region["rails"]:
			draw_dashed_line(_city_pos[e["a"]], _city_pos[e["b"]], BashPalette.TEAL_DEEP, 3.0, 10.0)
	var inv := 1.0 / scale.x
	if layers["resources"]:
		for r in region["resources"]:
			var p := project(float(r["lon"]), float(r["lat"]))
			var col: Color = RESOURCE_COLORS.get(r["resource"], Color.GRAY)
			draw_circle(p, 8.0 * minf(inv, 2.0), col)
			draw_arc(p, 8.0 * minf(inv, 2.0), 0.0, TAU, 20, Color.WHITE, 2.0)
			if r["id"] == selected_site:
				draw_arc(p, 14.0 * minf(inv, 2.0), 0.0, TAU, 24, BashPalette.GOLD, 4.0)
	var font := ThemeDB.fallback_font
	var fs := clampi(int(17.0 * inv), 14, 44)
	for c in region["cities"]:
		var p: Vector2 = _city_pos[c["id"]]
		var rad := (7.0 + sqrt(float(c["population"]) / 1000.0) * 0.85) * minf(inv, 1.6)
		if layers["hubs"] and c.get("has_hub", false):
			var s := rad + 4.0 * minf(inv, 1.6)
			draw_rect(Rect2(p - Vector2(s, s), Vector2(s, s) * 2.0), BashPalette.GOLD_SOFT)
			draw_rect(Rect2(p - Vector2(s, s), Vector2(s, s) * 2.0), BashPalette.GOLD, false, 3.0)
		draw_circle(p, rad, BashPalette.CREAM)
		draw_arc(p, rad, 0.0, TAU, 28, BashPalette.TEAL_DEEP, 3.0)
		if c["id"] == selected_city:
			draw_arc(p, rad + 7.0 * minf(inv, 1.6), 0.0, TAU, 28, BashPalette.GOLD, 5.0)
		draw_string(font, p + Vector2(rad + 6.0, fs * 0.35), str(c["name"]), HORIZONTAL_ALIGNMENT_LEFT, -1, fs, BashPalette.TEAL_DEEP)


func _on_tap(screen_pos: Vector2) -> void:
	if region.is_empty():
		return
	var local := to_map(screen_pos)
	var tol := 26.0 / scale.x
	var best := ""
	var best_d := tol
	for id in _city_pos:
		var d := local.distance_to(_city_pos[id])
		if d < best_d:
			best_d = d
			best = id
	if best != "":
		selected_city = best
		selected_site = ""
		queue_redraw()
		city_selected.emit(best)
		return
	if layers["resources"]:
		var site := {}
		var sd := 18.0 / scale.x
		for r in region["resources"]:
			var d := local.distance_to(project(float(r["lon"]), float(r["lat"])))
			if d < sd:
				sd = d
				site = r
		if not site.is_empty():
			selected_site = site["id"]
			selected_city = ""
			queue_redraw()
			site_selected.emit(site)
			return
	selected_city = ""
	selected_site = ""
	queue_redraw()
	city_selected.emit("")
