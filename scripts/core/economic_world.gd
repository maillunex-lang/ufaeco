class_name EconomicWorld
extends RefCounted

const MixedUseBuilding = preload("res://scripts/core/mixed_use_building.gd")

var world_id: String = "bashkortostan-main"
var server_tick: int = 0
var market_prices: Dictionary = {
    "grain": 12000,
    "flour": 28000,
    "bread": 95,
    "fuel": 68
}
var companies: Dictionary = {}
var buildings: Dictionary = {}
var contracts: Dictionary = {}

func register_company(company_id: String, title: String, starting_balance: int = 1000000) -> void:
    if companies.has(company_id):
        return
    companies[company_id] = {
        "title": title,
        "balance": starting_balance,
        "inventory": {},
        "active_contracts": []
    }

func add_mixed_use_building(building_id: String, city_id: String, floors: int) -> bool:
    if buildings.has(building_id):
        return false
    buildings[building_id] = MixedUseBuilding.new(building_id, city_id, floors, true)
    return true

func rent_retail_unit(company_id: String, building_id: String, unit_id: String) -> bool:
    if not companies.has(company_id) or not buildings.has(building_id):
        return false
    var building: MixedUseBuilding = buildings[building_id]
    var rent := building.monthly_rent(unit_id)
    if rent <= 0 or int(companies[company_id].balance) < rent:
        return false
    if not building.rent_unit(unit_id, company_id):
        return false
    companies[company_id].balance -= rent
    companies[company_id].active_contracts.append({
        "type": "retail_lease",
        "building_id": building_id,
        "unit_id": unit_id,
        "monthly_rent": rent
    })
    return true

func create_supply_contract(contract_id: String, seller_id: String, buyer_id: String, product_id: String, quantity: int, unit_price: int) -> bool:
    if contracts.has(contract_id):
        return false
    if not companies.has(seller_id) or not companies.has(buyer_id) or quantity <= 0 or unit_price <= 0:
        return false
    contracts[contract_id] = {
        "seller_id": seller_id,
        "buyer_id": buyer_id,
        "product_id": product_id,
        "quantity": quantity,
        "unit_price": unit_price,
        "status": "active",
        "created_tick": server_tick
    }
    return true

func advance_server_tick() -> void:
    server_tick += 1
