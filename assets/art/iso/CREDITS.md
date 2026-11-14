# Источники графики (assets/art/iso)

Все спрайты — **Kenney (Kenney Vleugels, www.kenney.nl)**, лицензия **CC0 / Public Domain**
(коммерческое использование разрешено, указание авторства не обязательно, но желательно).
Текст лицензии: [LICENSE-Kenney-CC0.txt](LICENSE-Kenney-CC0.txt). Файлы не изменялись, только переименованы/отобраны.

| Набор | Страница | Использованные файлы |
|---|---|---|
| Isometric Landscape | https://opengameart.org/content/isometric-landscape | `landscapeTiles_067` → `ground_grass`, `_066` → `water`, `_081` → `road` и `bridge` (плоский асфальт) |
| Isometric City | https://opengameart.org/content/isometric-city | `cityTiles_067` → `park_tree` |

Размер клетки: 132×99 px (ромб 132×66 + толщина 33). Здания рисуются кодом по габаритам W×H клеток (`scripts/map/city_map_view.gd`), спрайты зданий Kenney больше не используются.
