class_name MixedUseBuilding
extends RefCounted

enum UnitKind { RESIDENTIAL, RETAIL, OFFICE, SERVICE }

var building_id: String
var city_id: String
var floors: int
var retail_floor_enabled: bool
var units: Array[Dictionary] = []
var owner_company_id: String = ""
var monthly_maintenance: int = 0

func _init(id: String, city: String, floor_count: int, has_retail_floor: bool = true) -> void:
    building_id = id
    city_id = city
    floors = maxi(floor_count, 1)
    retail_floor_enabled = has_retail_floor
    _generate_units()

func _generate_units() -> void:
    units.clear()
    if retail_floor_enabled:
        for slot in range(4):
            units.append({
                "unit_id": "%s-retail-%d" % [building_id, slot + 1],
                "kind": UnitKind.RETAIL,
                "floor": 1,
                "area_m2": 35 + slot * 15,
                "rent_monthly": 45000 + slot * 12000,
                "tenant_company_id": "",
                "occupied": false,
                "foot_traffic": 1.0 + slot * 0.08
            })
    for floor in range(2, floors + 1):
        for apartment in range(4):
            units.append({
                "unit_id": "%s-flat-%d-%d" % [building_id, floor, apartment + 1],
                "kind": UnitKind.RESIDENTIAL,
                "floor": floor,
                "area_m2": 42 + apartment * 8,
                "rent_monthly": 28000 + floor * 900,
                "tenant_company_id": "",
                "occupied": false,
                "foot_traffic": 0.0
            })

func available_retail_units() -> Array[Dictionary]:
    return units.filter(func(unit: Dictionary) -> bool:
        return unit.kind == UnitKind.RETAIL and not unit.occupied
    )

func rent_unit(unit_id: String, company_id: String) -> bool:
    for unit in units:
        if unit.unit_id == unit_id and unit.kind == UnitKind.RETAIL and not unit.occupied:
            unit.tenant_company_id = company_id
            unit.occupied = true
            return true
    return false

func release_unit(unit_id: String, company_id: String) -> bool:
    for unit in units:
        if unit.unit_id == unit_id and unit.tenant_company_id == company_id:
            unit.tenant_company_id = ""
            unit.occupied = false
            return true
    return false

func monthly_rent(unit_id: String) -> int:
    for unit in units:
        if unit.unit_id == unit_id:
            return int(unit.rent_monthly)
    return 0
