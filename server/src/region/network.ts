import type { RegionData } from './data.js';

const R_EARTH_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** Расстояние по большому кругу, км. */
export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface Leg {
  mode: 'road' | 'rail';
  km: number;
  cost_cents_per_tonne: number;
  path: string[];
}

export interface FreightQuote {
  from: string;
  to: string;
  tonnes: number;
  road: Leg | null;
  rail: Leg | null;
  best: 'road' | 'rail' | 'none';
  /** стоимость перевозки одной тонны лучшим способом, копейки */
  cents_per_tonne: number;
  total_cents: number;
}

/** Схематичная транспортная сеть РБ: расстояния, пути и стоимость фрахта. */
export class RegionNetwork {
  private readonly pos = new Map<string, { lat: number; lon: number }>();
  private readonly road = new Map<string, Map<string, number>>();
  private readonly rail = new Map<string, Map<string, number>>();

  constructor(private readonly d: RegionData) {
    for (const c of d.cities) this.pos.set(c.id, { lat: c.lat, lon: c.lon });
    this.build(d.transport.roads, d.transport.road_winding_factor, this.road);
    this.build(d.transport.rails, d.transport.rail_winding_factor, this.rail);
  }

  private build(pairs: [string, string][], factor: number, into: Map<string, Map<string, number>>) {
    for (const [a, b] of pairs) {
      const pa = this.pos.get(a)!, pb = this.pos.get(b)!;
      const km = haversineKm(pa.lat, pa.lon, pb.lat, pb.lon) * factor;
      if (!into.has(a)) into.set(a, new Map());
      if (!into.has(b)) into.set(b, new Map());
      into.get(a)!.set(b, km);
      into.get(b)!.set(a, km);
    }
  }

  /** Прямая (по большому кругу) дистанция между городами. */
  straightKm(a: string, b: string): number {
    const pa = this.pos.get(a), pb = this.pos.get(b);
    if (!pa || !pb) throw new Error('Неизвестный город');
    return haversineKm(pa.lat, pa.lon, pb.lat, pb.lon);
  }

  private dijkstra(graph: Map<string, Map<string, number>>, from: string, to: string): { km: number; path: string[] } | null {
    if (!graph.has(from) || !graph.has(to)) return null;
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, string>();
    const done = new Set<string>();
    while (true) {
      let u: string | null = null;
      let best = Infinity;
      for (const [k, v] of dist) if (!done.has(k) && v < best) { best = v; u = k; }
      if (u === null) return null;
      if (u === to) break;
      done.add(u);
      for (const [n, w] of graph.get(u) ?? []) {
        const nd = best + w;
        if (nd < (dist.get(n) ?? Infinity)) { dist.set(n, nd); prev.set(n, u); }
      }
    }
    const path = [to];
    while (path[0] !== from) path.unshift(prev.get(path[0]!)!);
    return { km: dist.get(to)!, path };
  }

  roadKm(a: string, b: string): number | null {
    return a === b ? 0 : (this.dijkstra(this.road, a, b)?.km ?? null);
  }

  railKm(a: string, b: string): number | null {
    return a === b ? 0 : (this.dijkstra(this.rail, a, b)?.km ?? null);
  }

  /** Стоимость фрахта: фиксированная часть + км × ставка (для железной дороги ставка ниже, но есть погрузка). */
  quote(from: string, to: string, tonnes = 1): FreightQuote {
    if (!this.pos.has(from) || !this.pos.has(to)) throw new Error('Неизвестный город');
    const f = this.d.transport.freight;
    const mk = (mode: 'road' | 'rail', r: { km: number; path: string[] } | null): Leg | null =>
      r ? { mode, km: Math.round(r.km * 10) / 10, path: r.path, cost_cents_per_tonne: from === to ? 0 : f[mode].fixed_cents_per_tonne + Math.round(r.km * f[mode].cents_per_tonne_km) } : null;
    const same = from === to ? { km: 0, path: [from] } : null;
    const road = mk('road', same ?? this.dijkstra(this.road, from, to));
    const rail = mk('rail', same ?? this.dijkstra(this.rail, from, to));
    let best: FreightQuote['best'] = 'none';
    if (road && (!rail || road.cost_cents_per_tonne <= rail.cost_cents_per_tonne)) best = 'road';
    else if (rail) best = 'rail';
    const per = best === 'none' ? 0 : (best === 'road' ? road! : rail!).cost_cents_per_tonne;
    return { from, to, tonnes, road, rail, best, cents_per_tonne: per, total_cents: per * tonnes };
  }
}
