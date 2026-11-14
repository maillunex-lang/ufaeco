class_name BashFormat
extends RefCounted

static func thousands(n: int) -> String:
	var s := str(absi(n))
	var out := ""
	for i in range(s.length()):
		out += s[i]
		var left := s.length() - i - 1
		if left > 0 and left % 3 == 0:
			out += " "
	return out


## 12345600 копеек → "123 456 ₽"
static func money(cents: int) -> String:
	var rub := absi(cents) / 100
	var s := str(rub)
	var out := ""
	var n := 0
	for i in range(s.length() - 1, -1, -1):
		out = s[i] + out
		n += 1
		if n % 3 == 0 and i > 0:
			out = " " + out
	return ("-" if cents < 0 else "") + out + " ₽"

const ZONE_RU := {
	"residential": "Жилая зона",
	"commercial": "Коммерческая зона",
	"industrial": "Промзона",
	"park": "Парк",
}

static func zone(z: String) -> String:
	return ZONE_RU.get(z, z)

const KIND_RU := {
	"farm": "Ферма",
	"elevator": "Элеватор",
	"mill": "Мельница",
	"bakery": "Пекарня",
	"shop": "Магазин",
	"construction_office": "Строительная контора",
}

const PRODUCT_RU := {"grain": "зерно", "flour": "мука", "bread": "хлеб", "fuel": "топливо"}

static func kind(k: String) -> String:
	return KIND_RU.get(k, k)

static func goods(d: Dictionary) -> String:
	var parts: Array[String] = []
	for p in d:
		parts.append("%s ×%d" % [PRODUCT_RU.get(p, p), int(d[p])])
	return ", ".join(parts)

## Рецепт предприятия одной строкой; null-рецепт → пустая строка.
static func recipe(r) -> String:
	if r == null:
		return ""
	return "%s → %s в день" % [goods(r["inputs"]), goods(r["outputs"])]
