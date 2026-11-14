import type { RegionData } from './data.js';

/** Сетка региона: ячейка ≈ 8 км. Города, месторождения и хабы стоят в ячейках; дороги и железные дороги идут по ячейкам. */
export const REGION_CELL_KM = 8;
const KM_PER_DEG = 111;

export interface CellRect { x: number; y: number; w: number; h: number }
export interface RegionLink { a: string; b: string; cells: [number, number][] }

export interface RegionGrid {
  cell_km: number;
  width: number;
  height: number;
  /** строки: '.' земля РБ, '~' река, ' ' вне региона */
  mask: string[];
  cities: Record<string, CellRect>;
  resources: Record<string, { x: number; y: number }>;
  roads: RegionLink[];
  rails: RegionLink[];
}

function inPolygon(lon: number, lat: number, poly: [number, number][]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Ячейки линии между двумя ячейками (Брезенхем), включая концы. */
export function lineCells(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (;;) {
    out.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return out;
}

export function buildRegionGrid(d: RegionData, cellKm = REGION_CELL_KM): RegionGrid {
  const [lon0, lat0, lon1, lat1] = d.geo.bbox;
  const cos = Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
  const kmX = (lon: number) => (lon - lon0) * cos * KM_PER_DEG;
  const kmY = (lat: number) => (lat1 - lat) * KM_PER_DEG;
  const cell = (lon: number, lat: number): [number, number] => [Math.floor(kmX(lon) / cellKm), Math.floor(kmY(lat) / cellKm)];
  const width = Math.ceil(kmX(lon1) / cellKm), height = Math.ceil(kmY(lat0) / cellKm);
  const poly = d.geo.outline;
  const mask: string[][] = [];
  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      const lon = lon0 + (((x + 0.5) * cellKm) / KM_PER_DEG) / cos;
      const lat = lat1 - ((y + 0.5) * cellKm) / KM_PER_DEG;
      row.push(inPolygon(lon, lat, poly) ? '.' : ' ');
    }
    mask.push(row);
  }
  for (const r of d.geo.rivers) {
    for (let i = 1; i < r.points.length; i++) {
      const [ax, ay] = cell(r.points[i - 1]![0], r.points[i - 1]![1]);
      const [bx, by] = cell(r.points[i]![0], r.points[i]![1]);
      for (const [x, y] of lineCells(ax, ay, bx, by)) if (mask[y]?.[x] === '.') mask[y]![x] = '~';
    }
  }
  const taken = new Set<string>();
  const key = (x: number, y: number) => `${x},${y}`;
  const land = (x: number, y: number) => mask[y]?.[x] === '.' || mask[y]?.[x] === '~';

  // Города — по убыванию населения; крупные занимают больше ячеек (3×3, 2×2, 1×1)
  const cities: Record<string, CellRect> = {};
  for (const c of [...d.cities].sort((a, b) => b.population - a.population)) {
    const size = c.population >= 1_000_000 ? 3 : c.population >= 100_000 ? 2 : 1;
    const [cx, cy] = cell(c.lon, c.lat);
    let placed: CellRect | null = null;
    for (let r = 0; r < 12 && !placed; r++) {
      for (let dy = -r; dy <= r && !placed; dy++) for (let dx = -r; dx <= r && !placed; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx - Math.floor(size / 2) + dx, y = cy - Math.floor(size / 2) + dy;
        let ok = true;
        for (let yy = y; yy < y + size && ok; yy++) for (let xx = x; xx < x + size; xx++) if (!land(xx, yy) || taken.has(key(xx, yy))) { ok = false; break; }
        if (ok) placed = { x, y, w: size, h: size };
      }
    }
    if (!placed) throw new Error(`Не удалось разместить город ${c.id} на сетке региона`);
    for (let yy = placed.y; yy < placed.y + placed.h; yy++) for (let xx = placed.x; xx < placed.x + placed.w; xx++) taken.add(key(xx, yy));
    cities[c.id] = placed;
  }

  // Месторождения — в ближайшую свободную ячейку земли
  const resources: Record<string, { x: number; y: number }> = {};
  for (const r of d.resources) {
    const [cx, cy] = cell(r.lon, r.lat);
    let placed: { x: number; y: number } | null = null;
    for (let rad = 0; rad < 12 && !placed; rad++) {
      for (let dy = -rad; dy <= rad && !placed; dy++) for (let dx = -rad; dx <= rad && !placed; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
        const x = cx + dx, y = cy + dy;
        if (mask[y]?.[x] === '.' && !taken.has(key(x, y))) placed = { x, y };
      }
    }
    if (!placed) throw new Error(`Не удалось разместить месторождение ${r.id} на сетке региона`);
    taken.add(key(placed.x, placed.y));
    resources[r.id] = placed;
  }

  const centerOf = (id: string): [number, number] => {
    const c = cities[id]!;
    return [c.x + Math.floor(c.w / 2), c.y + Math.floor(c.h / 2)];
  };
  const links = (pairs: [string, string][]): RegionLink[] =>
    pairs.map(([a, b]) => ({ a, b, cells: lineCells(...centerOf(a), ...centerOf(b)) }));

  return {
    cell_km: cellKm, width, height, mask: mask.map((r) => r.join('')), cities, resources,
    roads: links(d.transport.roads), rails: links(d.transport.rails),
  };
}
