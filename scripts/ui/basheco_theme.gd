class_name BashTheme
extends RefCounted
## Тема интерфейса: светлые стеклянные панели, золотые акценты, крупные цели для пальцев.

const MIN_TOUCH := 48 # px, минимум для интерактивных элементов на Android

static func panel_style(fill: Color = BashPalette.GLASS, border: Color = Color(1, 1, 1, 0.8)) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = fill
	s.set_corner_radius_all(18)
	s.set_border_width_all(2)
	s.border_color = border
	s.shadow_color = Color(0.05, 0.35, 0.42, 0.25)
	s.shadow_size = 8
	s.content_margin_left = 16
	s.content_margin_right = 16
	s.content_margin_top = 10
	s.content_margin_bottom = 10
	return s

static func button_style(fill: Color, border: Color) -> StyleBoxFlat:
	var s := panel_style(fill, border)
	s.shadow_size = 4
	return s

static func build() -> Theme:
	var t := Theme.new()
	t.set_default_font_size(18)
	t.set_stylebox("panel", "PanelContainer", panel_style())
	t.set_stylebox("panel", "Panel", panel_style())
	t.set_color("font_color", "Label", BashPalette.TEAL_DEEP)
	t.set_color("font_color", "Button", BashPalette.TEAL_DEEP)
	t.set_color("font_hover_color", "Button", BashPalette.TEAL_DEEP)
	t.set_color("font_pressed_color", "Button", BashPalette.TEAL_DEEP)
	t.set_stylebox("normal", "Button", button_style(BashPalette.GOLD, BashPalette.GOLD_SOFT))
	t.set_stylebox("hover", "Button", button_style(BashPalette.GOLD_SOFT, BashPalette.WHITE))
	t.set_stylebox("pressed", "Button", button_style(Color("#c89a2a"), BashPalette.GOLD_SOFT))
	t.set_stylebox("disabled", "Button", button_style(Color(0.96, 0.94, 0.88, 0.88), Color(1, 1, 1, 0.8)))
	t.set_color("font_disabled_color", "Button", Color(BashPalette.TEAL_DEEP, 0.7))
	t.set_constant("h_separation", "Button", 10)
	return t
