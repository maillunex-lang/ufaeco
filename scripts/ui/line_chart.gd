class_name LineChart
extends Control
## Простой график по месяцам (экономические графики города). values — массив чисел; labels — подпись по оси X.

var values: Array = []
var title := ""
var line_color := BashPalette.TEAL


func set_data(new_title: String, new_values: Array, color: Color = BashPalette.TEAL) -> void:
	title = new_title
	values = new_values
	line_color = color
	queue_redraw()


func _draw() -> void:
	var r := Rect2(Vector2.ZERO, size)
	draw_rect(r, Color(1, 1, 1, 0.5))
	draw_rect(r, BashPalette.TEAL_DEEP, false, 1.0)
	var font := ThemeDB.fallback_font
	draw_string(font, Vector2(6, 15), title, HORIZONTAL_ALIGNMENT_LEFT, -1, 13, BashPalette.TEAL_DEEP)
	if values.size() < 2:
		draw_string(font, Vector2(6, size.y / 2 + 4), "история появится после закрытия месяца", HORIZONTAL_ALIGNMENT_LEFT, -1, 12, BashPalette.TEAL_DEEP)
		return
	var lo := float(values.min())
	var hi := float(values.max())
	if is_equal_approx(lo, hi):
		lo -= 1.0
		hi += 1.0
	var pts := PackedVector2Array()
	for i in range(values.size()):
		var x := 8.0 + (size.x - 16.0) * float(i) / float(values.size() - 1)
		var y := size.y - 8.0 - (size.y - 30.0) * (float(values[i]) - lo) / (hi - lo)
		pts.append(Vector2(x, y))
	draw_polyline(pts, line_color, 2.0)
	for p in pts:
		draw_circle(p, 2.5, line_color)
	draw_string(font, Vector2(size.x - 70, 15), "%s" % BashFormat.thousands(int(values[values.size() - 1])), HORIZONTAL_ALIGNMENT_RIGHT, 64, 13, BashPalette.TEAL_DEEP)
