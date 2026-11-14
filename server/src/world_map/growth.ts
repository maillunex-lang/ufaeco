import { growStreets, MAX_DEVELOPMENT, mulberry32, distToCenter, type CityState, type Lot, type Zone } from './generator.js';

/** Параметры роста города. ВСЕ ЧИСЛА — ГИПОТЕЗЫ. */
export const CAPACITY_PER_TILE_LEVEL = 4; // жителей на тайл жилой застройки за уровень
export const JOBS_PER_ENTERPRISE = 20;
export const JOBS_PER_COMMERCIAL_TILE_LEVEL = 3;
export const POPULATION_REFERENCE = 2000;
export const BREAD_PER_CITIZEN = 0.3;

export interface CityStats {
  population: number;
  housing_cap: number;
  jobs: number;
}

/** Сигналы экономики за день: от них зависит скорость и направление роста. */
export interface GrowthSignals {
  operatingEnterprises: number;
  industrialEnterprises: number;
  retailUnitsSold: number;
}

export interface CityStep {
  day: number;
  construction_points: number;
  developed: { lot_id: string; development: number }[];
  new_lots: Lot[];
  new_road_tiles: number;
  stats: CityStats;
  price_factor: number;
}

const area = (l: Lot) => l.w * l.h;

export function housingCap(lots: Lot[]): number {
  return lots.reduce((s, l) => (l.zone === 'residential' ? s + l.development * area(l) * CAPACITY_PER_TILE_LEVEL : s), 0);
}

export function commercialJobs(lots: Lot[]): number {
  return lots.reduce((s, l) => (l.zone === 'commercial' ? s + l.development * area(l) * JOBS_PER_COMMERCIAL_TILE_LEVEL : s), 0);
}

export const initialPopulation = (lots: Lot[]): number => Math.round(housingCap(lots) * 0.85);

export const priceFactor = (population: number): number => Math.max(0.7, Math.min(3, 0.7 + 0.8 * (population / POPULATION_REFERENCE)));

export const breadDemand = (population: number): number => Math.max(100, Math.floor(population * BREAD_PER_CITIZEN));

function pickZone(rng: () => number, w: Record<Zone, number>): Zone {
  const total = w.residential + w.commercial + w.industrial;
  let r = rng() * total;
  for (const z of ['residential', 'commercial', 'industrial'] as const) {
    if ((r -= w[z]) < 0) return z;
  }
  return 'residential';
}

/**
 * Один день жизни города: население тянется к цели (жильё + рабочие места), город строит новые здания
 * на свободных участках (не принадлежащих компаниям) и при нехватке земли прокладывает новые улицы.
 * Мутирует st (тайлы, участки). Детерминирован по (seed, day).
 */
export function stepCity(st: CityState, prev: CityStats, sig: GrowthSignals, day: number): CityStep {
  const rng = mulberry32((st.seed ^ Math.imul(day + 1, 0x9e3779b1)) >>> 0);
  const cap = housingCap(st.lots);
  const jobs = sig.operatingEnterprises * JOBS_PER_ENTERPRISE + commercialJobs(st.lots);
  const target = Math.min(cap, 0.7 * cap + jobs * 1.5);
  const delta = target - prev.population;
  const population = Math.max(0, prev.population + (Math.abs(delta) < 1 ? 0 : Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) * 0.08))));

  // Очки строительства: фон + рабочие места + торговля.
  const enterpriseJobs = sig.operatingEnterprises * JOBS_PER_ENTERPRISE;
  const points = Math.min(10, 1 + Math.floor(enterpriseJobs / 80) + Math.floor(sig.retailUnitsSold / 150) + (population > cap * 0.9 ? 1 : 0));
  const weights: Record<Zone, number> = {
    residential: 1 + Math.max(0, (population * 1.1 - cap) / 150),
    commercial: 0.4 + population / 2500,
    industrial: 0.2 + sig.industrialEnterprises * 0.4,
    park: 0,
  };
  const developed: CityStep['developed'] = [];
  for (let i = 0; i < points; i++) {
    const zone = pickZone(rng, weights);
    const cand = st.lots.filter((l) => l.zone === zone && !l.owned && l.development < MAX_DEVELOPMENT);
    if (cand.length === 0) continue;
    let best: Lot | null = null;
    let bestScore = Infinity;
    for (let k = 0; k < 14; k++) {
      const l = cand[Math.floor(rng() * cand.length)]!;
      const score = distToCenter(st, l.x + l.w / 2, l.y + l.h / 2) + l.development * 3 + rng() * 8;
      if (score < bestScore) { bestScore = score; best = l; }
    }
    if (!best) continue;
    best.development += 1;
    developed.push({ lot_id: best.id, development: best.development });
  }

  // Новые улицы, когда свободной земли мало или жильё на пределе.
  const vacant = st.lots.filter((l) => l.zone !== 'park' && !l.owned && l.development === 0).length;
  const before = st.lots.length;
  let newRoad = 0;
  if (vacant < Math.max(12, st.lots.length * 0.12) || population > cap * 0.95) {
    newRoad = growStreets(st, rng, vacant < 6 ? 2 : 1).newRoadTiles;
  }
  const new_lots = st.lots.slice(before);
  const cap2 = housingCap(st.lots);
  return {
    day, construction_points: points, developed, new_lots, new_road_tiles: newRoad,
    stats: { population, housing_cap: cap2, jobs: sig.operatingEnterprises * JOBS_PER_ENTERPRISE + commercialJobs(st.lots) },
    price_factor: priceFactor(population),
  };
}
