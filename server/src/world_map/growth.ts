import {
  addFloor, cityJobs, frontageCells, growStreets, housingCapacity, mulberry32, Occupancy, placeNpcBuilding,
  type Building, type CityState, type Zone,
} from './generator.js';

/** Параметры роста города. ВСЕ ЧИСЛА — ГИПОТЕЗЫ. */
export const JOBS_PER_ENTERPRISE = 20;
export const POPULATION_REFERENCE = 2000;
export const BREAD_PER_CITIZEN = 0.3;

export interface CityStats {
  population: number;
  housing_cap: number;
  jobs: number;
}

/** Сигналы экономики за тик: от них зависит скорость и направление роста. */
export interface GrowthSignals {
  operatingEnterprises: number;
  industrialEnterprises: number;
  retailUnitsSold: number;
}

export interface CityStep {
  tick: number;
  construction_points: number;
  /** новые городские здания */
  added: Building[];
  /** здания, у которых выросла этажность */
  floors: { id: string; floors: number }[];
  new_road_tiles: number;
  stats: CityStats;
  price_factor: number;
}

export const initialPopulation = (st: CityState): number => Math.round(housingCapacity(st) * 0.85);

/** Масштаб вместимости, при котором стартовое население города равно заданному. */
export function calibrateCapacity(st: CityState, population: number): number {
  const base = housingCapacity({ ...st, params: { ...st.params, capacityScale: 1 } });
  return base > 0 ? Math.max(0.05, population / (0.85 * base)) : 1;
}

export const priceFactor = (population: number, reference = POPULATION_REFERENCE): number =>
  Math.max(0.7, Math.min(3, 0.7 + 0.8 * (population / Math.max(1, reference))));

export const breadDemand = (population: number): number => Math.max(100, Math.floor(population * BREAD_PER_CITIZEN));

function pickZone(rng: () => number, w: Record<Exclude<Zone, 'park'>, number>): Exclude<Zone, 'park'> {
  const total = w.residential + w.commercial + w.industrial;
  let r = rng() * total;
  for (const z of ['residential', 'commercial', 'industrial'] as const) if ((r -= w[z]) < 0) return z;
  return 'residential';
}

/**
 * Один тик жизни города: население тянется к цели (жильё + рабочие места); город строит новые здания на свободных клетках
 * (не принадлежащих компаниям), а если места нет — достраивает этажи; при нехватке свободной земли прокладывает новые улицы.
 * Мутирует st. Детерминирован по (seed, tick).
 */
export function stepCity(st: CityState, prev: CityStats, sig: GrowthSignals, tick: number, populationReference = POPULATION_REFERENCE): CityStep {
  const rng = mulberry32((st.seed ^ Math.imul(tick + 1, 0x9e3779b1)) >>> 0);
  const cap = housingCapacity(st);
  const scale = st.params.capacityScale;
  const jobs = sig.operatingEnterprises * JOBS_PER_ENTERPRISE + cityJobs(st);
  const target = Math.min(cap, 0.85 * cap + jobs * 1.5 * scale);
  const delta = target - prev.population;
  const population = Math.max(0, prev.population + (Math.abs(delta) < 1 ? 0 : Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) * 0.08))));

  const enterpriseJobs = sig.operatingEnterprises * JOBS_PER_ENTERPRISE;
  const points = Math.min(10, 1 + Math.floor(enterpriseJobs / 80) + Math.floor(sig.retailUnitsSold / 150) + (population > cap * 0.9 ? 1 : 0));
  const weights = {
    residential: 1 + Math.max(0, (population * 1.1 - cap) / (150 * Math.max(scale, 0.05) * 4)),
    commercial: 0.4 + population / (2500 * Math.max(scale, 0.05) * 4),
    industrial: 0.2 + sig.industrialEnterprises * 0.4,
  };
  const occ = new Occupancy(st);
  const added: Building[] = [];
  const floorChanges = new Map<string, number>();
  let failed = 0;
  const starved: Record<string, number> = {};
  for (let i = 0; i < points; i++) {
    const first = pickZone(rng, weights);
    // сначала нужная зона, затем остальные: очко строительства не должно пропадать зря
    const order = [first, ...(['residential', 'commercial', 'industrial'] as const).filter((z) => z !== first)];
    let done = false;
    for (const zone of order) {
      const b = placeNpcBuilding(st, rng, zone, occ);
      if (b) { added.push(b); done = true; if (zone !== first) starved[first] = (starved[first] ?? 0) + 1; break; }
    }
    if (!done) {
      for (const zone of order) {
        const f = addFloor(st, rng, zone);
        if (f) { floorChanges.set(f.id, f.floors); done = true; break; }
      }
    }
    if (!done) failed++;
  }

  // Новые улицы, когда свободной земли мало или жильё на пределе.
  let newRoad = 0;
  const frontage = frontageCells(st, occ);
  const need = Math.max(40, occ.roads.length * 0.12);
  const hungry = Object.entries(starved).sort((a, b) => b[1] - a[1])[0];
  if (frontage < need || failed >= 3 || hungry || population > cap * 0.95) {
    newRoad = growStreets(st, rng, frontage < need / 3 ? 3 : 1, occ, hungry ? (hungry[0] as Zone) : undefined);
  }
  // Здания, добавленные в этом тике, учитывать как «новые», а не как изменение этажей.
  const newIds = new Set(added.map((b) => b.id));
  return {
    tick, construction_points: points, added,
    floors: [...floorChanges].filter(([id]) => !newIds.has(id)).map(([id, floors]) => ({ id, floors })),
    new_road_tiles: newRoad,
    stats: { population, housing_cap: Math.round(housingCapacity(st)), jobs: Math.round(sig.operatingEnterprises * JOBS_PER_ENTERPRISE + cityJobs(st)) },
    price_factor: priceFactor(population, populationReference),
  };
}
