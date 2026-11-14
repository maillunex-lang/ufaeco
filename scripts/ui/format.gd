class_name BashFormat
extends RefCounted

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
