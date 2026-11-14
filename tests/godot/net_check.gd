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

	check(client.prices.has("bread") and int(client.prices["bread"]) > 0, "цены из snapshot: %s" % str(client.prices))
	check(client.economy_day >= 0, "экономический день в snapshot: %d" % client.economy_day)

	print("2. команды")
	var rid: String = client.send_command("company.create", {"name": "Тест-" + login})
	check(rid != "", "команда отправлена")
	check(await wait_until(func(): return results.has(rid), 3.0), "получен command_result")
	check(results.get(rid, {}).get("ok", false) == true, "компания создана")
	var bad: String = client.send_command("company.create", {"name": "Хакер", "balance_cents": 999999999})
	await wait_until(func(): return results.has(bad), 3.0)
	check(results.get(bad, {}).get("ok", true) == false, "клиентский баланс отклонён сервером")

	var cid: String = results[rid]["result"]["company"]["id"]
	var trade: String = client.send_command("economy.trade", {"company_id": cid, "product_id": "fuel", "side": "buy", "quantity": 5})
	await wait_until(func(): return results.has(trade), 3.0)
	check(results.get(trade, {}).get("ok", false) == true, "покупка у NPC-торгового дома")
	var forged: String = client.send_command("economy.trade", {"company_id": cid, "product_id": "fuel", "side": "buy", "quantity": 1, "price_cents": 1})
	await wait_until(func(): return results.has(forged), 3.0)
	check(results.get(forged, {}).get("ok", true) == false, "клиент не может задать цену")

	print("2b. карта")
	var mapq: String = client.send_command("map.get_city", {"city_id": "ufa"})
	await wait_until(func(): return results.has(mapq), 3.0)
	var city: Dictionary = results.get(mapq, {}).get("result", {}).get("city", {})
	check(not city.is_empty() and city["tiles"].size() == int(city["height"]), "карта города получена (%dx%d, участков: %d)" % [int(city.get("width", 0)), int(city.get("height", 0)), city.get("lots", []).size()])
	var free_lot := {}
	for l in city.get("lots", []):
		if l["zone"] == "residential" and l["for_sale"]:
			free_lot = l
			break
	var buy: String = client.send_command("map.buy_lot", {"company_id": cid, "lot_id": free_lot["id"]})
	await wait_until(func(): return results.has(buy), 3.0)
	check(results.get(buy, {}).get("ok", false) == true, "участок куплен")

	var ind := {}
	for l in city.get("lots", []):
		if l["zone"] == "industrial" and l["for_sale"]:
			ind = l
			break
	var buy2: String = client.send_command("map.buy_lot", {"company_id": cid, "lot_id": ind["id"]})
	await wait_until(func(): return results.has(buy2), 3.0)
	var early: String = client.send_command("enterprise.create", {"company_id": cid, "kind": "shop", "name": "Не там", "lot_id": ind["id"]})
	await wait_until(func(): return results.has(early), 3.0)
	check(results.get(early, {}).get("error", {}).get("code", "") == "zoning_violation", "зонирование: магазин в промзоне отклонён")
	var built: String = client.send_command("enterprise.create", {"company_id": cid, "kind": "farm", "name": "Ферма Godot", "lot_id": ind["id"]})
	await wait_until(func(): return results.has(built), 3.0)
	check(results.get(built, {}).get("ok", false) == true, "ферма построена на участке")
	var mapq2: String = client.send_command("map.get_city", {"city_id": "ufa"})
	await wait_until(func(): return results.has(mapq2), 3.0)
	var shown := false
	for l in results[mapq2]["result"]["city"]["lots"]:
		if l["id"] == ind["id"] and l["building"] != null and l["building"]["kind"] == "farm":
			shown = true
	check(shown, "здание видно в map.get_city")

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
