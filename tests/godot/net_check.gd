extends SceneTree
## Интеграционная проверка OnlineWorldClient против запущенного сервера.
## Запуск: godot --headless --path . --script res://tests/godot/net_check.gd
## Сервер должен слушать адрес из config/client_config.json (или BASHECO_WEBSOCKET_URL).

const OnlineWorldClientScript = preload("res://scripts/net/online_world_client.gd")

var client: Node
var failures: Array[String] = []
var errors: Array[String] = []
var states: Array[String] = []
var ticks: Array[int] = []
var results: Dictionary = {}
var snapshots := 0

func _initialize() -> void:
	client = OnlineWorldClientScript.new()
	root.add_child(client)
	client.connection_state_changed.connect(func(s): states.append(s))
	client.server_tick_changed.connect(func(t): ticks.append(t))
	client.network_error.connect(func(m): errors.append(m))
	client.world_snapshot_received.connect(func(_s): snapshots += 1)
	client.command_result_received.connect(func(rid, p): results[rid] = p)
	_run()

## Свободный прямоугольник w×h из продаваемых клеток нужных зон (буквы r/c/i); (-1,-1), если нет.
func _find_rect(city: Dictionary, w: int, h: int, zones: Array) -> Vector2i:
	var occupied := {}
	for bd in city["buildings"]:
		for dy in range(int(bd["h"])):
			for dx in range(int(bd["w"])):
				occupied["%d,%d" % [int(bd["x"]) + dx, int(bd["y"]) + dy]] = true
	for run in city["parcels"]["runs"]:
		for i in range(int(run[2])):
			occupied["%d,%d" % [int(run[1]) + i, int(run[0])]] = true
	for y in range(int(city["height"]) - h):
		for x in range(int(city["width"]) - w):
			var ok := true
			for yy in range(y, y + h):
				for xx in range(x, x + w):
					if String(city["cells"]["buyable"][yy])[xx] != "1" or occupied.has("%d,%d" % [xx, yy]) or not (String(city["cells"]["zones"][yy])[xx] in zones):
						ok = false
			if ok:
				return Vector2i(x, y)
	return Vector2i(-1, -1)


func check(cond: bool, msg: String) -> void:
	print(("  ok   " if cond else "  FAIL ") + msg)
	if not cond:
		failures.append(msg)

func wait_until(pred: Callable, seconds: float) -> bool:
	var t := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t < seconds * 1000.0:
		if pred.call():
			return true
		await process_frame
	return pred.call()

func _run() -> void:
	var login := "g" + str(randi() % 1000000000)
	print("1. регистрация и вход")
	client.register_account(login, "godot-pass-123", "Godot-игрок")
	check(await wait_until(func(): return client.state == "online", 5.0), "состояние online после register")
	check(client.player_id != "" and client.session_id != "", "получены player_id и session_id")
	check(await wait_until(func(): return snapshots >= 2, 3.0), "получены world_snapshot")
	check(await wait_until(func(): return ticks.size() >= 2 and client.last_server_tick > 0, 3.0), "server_tick растёт (%d)" % client.last_server_tick)
	check(client.status_text_ru() == "в сети", "статус по-русски: " + client.status_text_ru())

	check(not client.clock.is_empty(), "игровые часы в snapshot")
	check(int(client.clock.get("day", 0)) >= 1 and int(client.clock.get("day", 0)) <= 24, "день месяца 1..24: %s" % str(client.clock.get("day")))
	check(int(client.clock.get("week", 0)) >= 1 and int(client.clock.get("week", 0)) <= 4, "неделя игры 1..4: %s" % str(client.clock.get("week")))
	check(float(client.clock.get("next_day_at", 0)) > float(client.clock.get("server_time", 1)), "следующий день в будущем")
	check(client.clock_text_ru().find("день") != -1, "текст часов по-русски: " + client.clock_text_ru())

	print("2. команды")
	var rid: String = client.send_command("company.create", {"name": "Тест-" + login})
	check(rid != "", "команда отправлена")
	check(await wait_until(func(): return results.has(rid), 3.0), "получен command_result")
	check(results.get(rid, {}).get("ok", false) == true, "компания создана")
	var bad: String = client.send_command("company.create", {"name": "Хакер", "balance_cents": 999999999})
	await wait_until(func(): return results.has(bad), 3.0)
	check(results.get(bad, {}).get("ok", true) == false, "клиентский баланс отклонён сервером")

	var cid: String = results[rid]["result"]["company"]["id"]
	var cat: String = client.send_command("catalog.get", {})
	await wait_until(func(): return results.has(cat), 3.0)
	check(results.get(cat, {}).get("ok", false) == true, "каталог зданий получен")
	var removed: String = client.send_command("economy.trade", {"company_id": cid, "product_id": "fuel", "side": "buy", "quantity": 1})
	await wait_until(func(): return results.has(removed), 3.0)
	check(results.get(removed, {}).get("error", {}).get("code", "") == "unknown_command", "старая торговля с NPC удалена")

	print("2a. регион")
	var reg: String = client.send_command("region.get", {})
	await wait_until(func(): return results.has(reg), 3.0)
	var rr: Dictionary = results.get(reg, {}).get("result", {}).get("region", {})
	check(rr.get("cities", []).size() == 21, "region.get: 21 город")
	check(rr.get("grid", {}).get("mask", []).size() > 50, "region.get: сетка региона")
	var fq: String = client.send_command("region.freight_quote", {"from_city": "ufa", "to_city": "sibay", "tonnes": 10})
	await wait_until(func(): return results.has(fq), 3.0)
	check(str(results.get(fq, {}).get("result", {}).get("quote", {}).get("best", "")) == "rail", "фрахт Уфа → Сибай выгоднее по железной дороге")

	print("2b. карта: сетка, земля клетками, здание с габаритами")
	var mapq: String = client.send_command("map.get_city", {"city_id": "ufa"})
	await wait_until(func(): return results.has(mapq), 3.0)
	var city: Dictionary = results.get(mapq, {}).get("result", {}).get("city", {})
	check(not city.is_empty() and city["tiles"].size() == int(city["height"]), "карта города получена (%dx%d, зданий: %d)" % [int(city.get("width", 0)), int(city.get("height", 0)), city.get("buildings", []).size()])
	var big := 0
	for bd in city.get("buildings", []):
		if int(bd["w"]) * int(bd["h"]) > 1:
			big += 1
	check(big > 10, "в городе есть здания крупнее 1×1: %d" % big)
	var spot := _find_rect(city, 2, 1, ["r", "c"])
	check(spot.x >= 0, "найдено место 2×1 под магазин")
	var buy: String = client.send_command("map.buy_cells", {"company_id": cid, "city_id": "ufa", "x": spot.x, "y": spot.y, "w": 2, "h": 1})
	await wait_until(func(): return results.has(buy), 3.0)
	check(results.get(buy, {}).get("ok", false) == true, "клетки куплены")
	var early: String = client.send_command("building.place", {"company_id": cid, "city_id": "ufa", "x": spot.x, "y": spot.y, "kind": "farm", "name": "Не там"})
	await wait_until(func(): return results.has(early), 3.0)
	check(results.get(early, {}).get("error", {}).get("code", "") == "cells_not_owned" or results.get(early, {}).get("error", {}).get("code", "") == "zoning_violation", "ферма на чужих/неподходящих клетках отклонена")
	var built: String = client.send_command("building.place", {"company_id": cid, "city_id": "ufa", "x": spot.x, "y": spot.y, "kind": "shop", "name": "Магазин Godot"})
	await wait_until(func(): return results.has(built), 3.0)
	check(results.get(built, {}).get("ok", false) == true, "магазин 2×1 построен")
	var mapq2: String = client.send_command("map.get_city", {"city_id": "ufa"})
	await wait_until(func(): return results.has(mapq2), 3.0)
	var shown := false
	for bd in results[mapq2]["result"]["city"]["buildings"]:
		if int(bd["x"]) == spot.x and int(bd["y"]) == spot.y and bd["kind"] == "shop" and int(bd["w"]) == 2 and int(bd["h"]) == 1:
			shown = true
	check(shown, "здание 2×1 видно в map.get_city")

	print("3. reconnect")
	var old_session: String = client.session_id
	var old_player: String = client.player_id
	var states_before := states.size()
	client._peer.close(1006) # имитация обрыва без disconnect
	check(await wait_until(func(): return "reconnecting" in states.slice(states_before), 5.0), "состояние reconnecting")
	check(await wait_until(func(): return client.state == "online", 10.0), "снова online")
	check(client.session_id == old_session and client.player_id == old_player, "сессия восстановлена")

	print("4. вход с неверным паролем (новый клиент)")
	client.disconnect_from_world()
	check(client.state == "disconnected", "состояние disconnected после disconnect_from_world")
	errors.clear()
	client.login_with_password(login, "wrong-password-1")
	check(await wait_until(func(): return errors.size() > 0, 5.0), "ошибка получена")
	check(errors.size() > 0 and errors[0] == "Неверный логин или пароль.", "ошибка по-русски: " + (errors[0] if errors.size() > 0 else "—"))
	check(client.state != "online", "не в сети")

	print("5. верный пароль")
	client.login_with_password(login, "godot-pass-123")
	check(await wait_until(func(): return client.state == "online", 5.0), "вход по паролю")
	check(client.player_id == old_player, "тот же игрок")
	client.disconnect_from_world()

	print("")
	print("ИТОГО: %s (ошибок: %d)" % ["УСПЕХ" if failures.is_empty() else "ПРОВАЛ", failures.size()])
	quit(0 if failures.is_empty() else 1)
