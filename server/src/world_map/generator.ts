/**
 * Органичный растущий город на сетке клеток. Чистый детерминированный код (seed + номер тика), без БД.
 *
 * Всё привязано к сетке: тайлы ('.' земля, '#' дорога, '~' вода, '=' мост) — целые клетки; здания занимают прямоугольник W×H клеток
 * (бывают больше 1×1); землю покупают клетками. Улицы растут от центра ветвями с изгибами и «лесенками», пересекают реку мостами;
 * районы (зоны) — пятна по шуму. Городская застройка (NPC) — здания с габаритами вдоль улиц; растёт числом зданий, этажностью и новыми улицами.
 */
export type Zone = 'residential' | 'commercial' | 'industrial' | 'park';

export interface Building {
  /** UUID из БД; у только что созданных в памяти зданий — временный id `new-N` */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: string;
  floors: number;
  /** компания-владелец; null — городская застройка */
  owner: string | null;
  name?: string;
}

export interface CityParams {
  /** базовая цена клетки, копейки */
  landBaseCents: number;
  /** сколько единиц вместимости/рабочих мест даёт клетка-этаж (калибруется под население города) */
  capacityScale: number;
  /** есть ли река (вертикальная, извилистая) */
  river: boolean;
}

export const DEFAULT_PARAMS: CityParams = { landBaseCents: 2_000_000, capacityScale: 1, river: true };

export interface CityState {
  params: CityParams;
  cityId: string;
  seed: number;
  width: number;
  height: number;
  center: { x: number; y: number };
  tiles: string[][];
  buildings: Building[];
  /** клетки в частной собственности компаний ("x,y") — город там не строит, улицы не прокладываются */
  parcels: Set<string>;
  nextTempId: number;
}

// ---------------------------------------------------------------- каталог городской застройки

export interface NpcKind {
  id: string;
  zone: Exclude<Zone, 'park'>;
  w: number;
  h: number;
  maxFloors: number;
  /** жителей (жильё) или рабочих мест на клетку-этаж при capacityScale = 1 */
  per: number;
  /** диапазон центральности (0 — окраина, 1 — центр), где тип встречается */
  minC: number;
  maxC: number;
}

export const NPC_KINDS: NpcKind[] = [
  { id: 'house', zone: 'residential', w: 1, h: 1, maxFloors: 2, per: 3, minC: 0, maxC: 0.55 },
  { id: 'cottage', zone: 'residential', w: 2, h: 1, maxFloors: 2, per: 3, minC: 0, maxC: 0.7 },
  { id: 'block', zone: 'residential', w: 2, h: 2, maxFloors: 5, per: 4, minC: 0.2, maxC: 1 },
  { id: 'tower', zone: 'residential', w: 3, h: 2, maxFloors: 9, per: 5, minC: 0.55, maxC: 1 },
  { id: 'kiosk', zone: 'commercial', w: 1, h: 1, maxFloors: 2, per: 2, minC: 0, maxC: 1 },
  { id: 'shop_row', zone: 'commercial', w: 2, h: 1, maxFloors: 3, per: 3, minC: 0, maxC: 1 },
  { id: 'mall', zone: 'commercial', w: 2, h: 2, maxFloors: 4, per: 4, minC: 0.3, maxC: 1 },
  { id: 'office', zone: 'commercial', w: 3, h: 2, maxFloors: 8, per: 5, minC: 0.5, maxC: 1 },
  { id: 'shed', zone: 'industrial', w: 1, h: 1, maxFloors: 1, per: 2, minC: 0, maxC: 0.5 },
  { id: 'depot', zone: 'industrial', w: 2, h: 1, maxFloors: 2, per: 2, minC: 0, maxC: 0.8 },
  { id: 'workshop', zone: 'industrial', w: 2, h: 2, maxFloors: 2, per: 3, minC: 0, maxC: 1 },
  { id: 'warehouse', zone: 'industrial', w: 3, h: 2, maxFloors: 2, per: 2, minC: 0, maxC: 1 },
  { id: 'plant', zone: 'industrial', w: 3, h: 3, maxFloors: 3, per: 4, minC: 0.1, maxC: 1 },
];
export const NPC_KIND_BY_ID = new Map(NPC_KINDS.map((k) => [k.id, k]));

export const MAX_BUILDINGS = 6000;
const MARGIN = 2;
const URBAN_REACH = 4; // клетка «городская», если до дороги не дальше 4 клеток
const DIRS: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x * 374761393 + y * 668265263 + seed, 1274126177);
  h ^= h >>> 13;
  h = Math.imul(h, 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function distToCenter(st: Pick<CityState, 'center'>, x: number, y: number): number {
  return Math.hypot(x - st.center.x, (y - st.center.y) * 1.15);
}

/** Центральность 0..1: 1 — центр, 0 — далеко от центра. */
export function centrality(st: CityState, cx: number, cy: number): number {
  const reach = 0.36 * Math.hypot(st.width, st.height);
  return Math.max(0, Math.min(1, 1 - distToCenter(st, cx, cy) / reach));
}

function riverX(st: Pick<CityState, 'seed' | 'width' | 'params'>, y: number): number {
  if (!st.params.river) return -1000;
  const base = st.width * 0.68;
  return Math.round(base + Math.sin(y / 6 + (st.seed % 17)) * 3 + (vnoise(y / 5, 0.5, st.seed + 3) - 0.5) * 6);
}

/** Район клетки (x, y — целые координаты клетки): пятна шума, центр коммерческий, восточный берег и «грязные» пятна — промзона. */
export function zoneOfCell(st: CityState, x: number, y: number): Zone {
  const cx = x + 0.5, cy = y + 0.5;
  const d = distToCenter(st, cx, cy);
  const n = vnoise(cx / 9, cy / 9, st.seed + 11);
  const m = vnoise(cx / 6, cy / 6, st.seed + 23);
  const river = riverX(st, y);
  if (d < 6 + n * 6) return 'commercial';
  if (st.params.river ? cx > river + 3 && d > 11 : cx > st.center.x + st.width * 0.22 && d > 11) return 'industrial';
  if (m < 0.27 && d > 14) return 'industrial';
  if (st.params.river && Math.abs(cx - river) <= 4 && hash2(x >> 1, y >> 1, st.seed + 5) < 0.4) return 'park';
  if (m > 0.8 && d > 8) return 'park';
  return 'residential';
}

const ZONE_LAND: Record<Zone, number> = { commercial: 1.0, residential: 0.8, industrial: 0.5, park: 0.4 };
const ZONE_TRAFFIC: Record<Zone, number> = { commercial: 1.0, residential: 0.55, industrial: 0.3, park: 0.5 };

/** Оверлеи клетки (0..100): центральность × зона + детерминированный шум. */
export function cellOverlays(st: CityState, x: number, y: number, zone: Zone): { land_value: number; traffic: number } {
  const c = centrality(st, x + 0.5, y + 0.5);
  const n = (hash2(x, y, st.seed + 31) - 0.5) * 10;
  const clamp = (v: number) => Math.max(1, Math.min(100, Math.round(v)));
  return {
    land_value: clamp(100 * (0.15 + 0.85 * Math.pow(c, 1.3)) * ZONE_LAND[zone] + n),
    traffic: clamp(100 * (0.1 + 0.9 * Math.pow(c, 1.5)) * ZONE_TRAFFIC[zone] + n),
  };
}

/** Цена клетки, копейки; park — не продаётся (0). `factor` — рыночный множитель города (растёт с населением). */
export const cellPrice = (landBaseCents: number, landValue: number, zone: Zone, factor = 1): number =>
  zone === 'park' ? 0 : Math.max(1, Math.round(landBaseCents * (0.35 + 1.65 * (landValue / 100)) * factor));

export const key = (x: number, y: number): string => `${x},${y}`;

// ---------------------------------------------------------------- занятость клеток

/** Занятость: здания и частные клетки блокируют застройку и улицы; дороги/вода — из тайлов. */
export class Occupancy {
  /** индекс здания + 1; частная клетка без здания — -1 */
  claim: Int32Array;
  roads: [number, number][] = [];
  constructor(readonly st: CityState) {
    this.claim = new Int32Array(st.width * st.height);
    st.buildings.forEach((b, i) => this.mark(b, i + 1));
    for (const k of st.parcels) {
      const [x, y] = k.split(',').map(Number) as [number, number];
      if (this.claim[y * st.width + x] === 0) this.claim[y * st.width + x] = -1;
    }
    for (let y = 0; y < st.height; y++) for (let x = 0; x < st.width; x++) if ('#='.includes(st.tiles[y]![x]!)) this.roads.push([x, y]);
  }
  mark(b: { x: number; y: number; w: number; h: number }, v: number) {
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) this.claim[y * this.st.width + x] = v;
  }
  inb(x: number, y: number, m = MARGIN) {
    return x >= m && y >= m && x < this.st.width - m && y < this.st.height - m;
  }
  t(x: number, y: number): string {
    return this.st.tiles[y]?.[x] ?? ' ';
  }
  isRoad(x: number, y: number) {
    const c = this.t(x, y);
    return c === '#' || c === '=';
  }
  /** Пусто для застройки: земля, не занято. */
  empty(x: number, y: number): boolean {
    return this.t(x, y) === '.' && this.claim[y * this.st.width + x] === 0;
  }
  /** Свободно под город: пусто, не в коридоре будущей боковой улицы. */
  free(x: number, y: number): boolean {
    return this.empty(x, y) && !this.reserved(x, y);
  }
  /**
   * Коридоры боковых улиц: у ~20% дорожных тайлов 6 клеток наружу не отдаются под застройку города.
   * Определяется детерминированно по координатам — состояние хранить не нужно.
   */
  reserved(x: number, y: number): boolean {
    for (const [dx, dy] of DIRS) {
      for (let k = 1; k <= 6; k++) {
        const px = x - k * dx, py = y - k * dy;
        const c = this.t(px, py);
        if (c === '#') {
          if (hash2(px, py, this.st.seed + 77) < 0.2) return true;
          break;
        }
        if (c !== '.') break;
      }
    }
    return false;
  }
  hasOpenSide(x: number, y: number): boolean {
    return DIRS.some(([dx, dy]) => this.empty(x + dx, y + dy) && this.inb(x + dx, y + dy));
  }
}

/** Расстояние (в клетках, по Чебышёву) до ближайшей дороги, не больше `limit`; 255 — дальше. */
export function roadDistance(st: CityState, limit = URBAN_REACH): Uint8Array {
  const { width: w, height: h } = st;
  const dist = new Uint8Array(w * h).fill(255);
  let frontier: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ('#='.includes(st.tiles[y]![x]!)) { dist[y * w + x] = 0; frontier.push(y * w + x); }
  for (let d = 1; d <= limit; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (dist[j] === 255) { dist[j] = d; next.push(j); }
      }
    }
    frontier = next;
  }
  return dist;
}

export function createState(cityId: string, seed: number, width = 84, height = 64, params: CityParams = DEFAULT_PARAMS): CityState {
  const st: CityState = {
    params, cityId, seed, width, height, center: { x: Math.round(width * 0.42), y: Math.round(height * 0.5) },
    tiles: [], buildings: [], parcels: new Set(), nextTempId: 1,
  };
  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    const rx = riverX(st, y);
    for (let x = 0; x < width; x++) row.push(Math.abs(x - rx) <= 1 ? '~' : '.');
    st.tiles.push(row);
  }
  return st;
}

// ---------------------------------------------------------------- улицы

/** Сколько клеток подряд можно идти улицей из (x,y) в направлении d (вода до 3 клеток допустима). */
function freeRun(g: Occupancy, x: number, y: number, dx: number, dy: number, max = 8): number {
  let n = 0, water = 0;
  for (let i = 1; i <= max; i++) {
    const px = x + dx * i, py = y + dy * i;
    if (!g.inb(px, py)) break;
    const c = g.t(px, py);
    if (c === '~') { if (++water > 3) break; n++; continue; }
    if (!g.empty(px, py)) break;
    water = 0;
    n++;
  }
  return n;
}

/** Расстояние от клетки до ближайшей клетки зоны вдоль четырёх направлений (шаг 3, до 30 клеток); Infinity — не найдено. */
function zonePull(st: CityState, x: number, y: number, zone: Zone): number {
  for (let d = 3; d <= 30; d += 3) {
    for (const [dx, dy] of DIRS) {
      const cx = x + dx * d, cy = y + dy * d;
      if (cx >= 0 && cy >= 0 && cx < st.width && cy < st.height && st.tiles[cy]![cx] !== '~' && zoneOfCell(st, cx, cy) === zone) return d;
    }
  }
  return Infinity;
}

function frontierStart(g: Occupancy, rng: () => number, prefer?: Zone): { start: [number, number]; dirs: [number, number][] } | null {
  if (g.roads.length === 0) return null;
  let best: { start: [number, number]; dirs: [number, number][] } | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < 160; i++) {
    const r = g.roads[Math.floor(rng() * g.roads.length)]!;
    if (g.t(r[0], r[1]) === '=') continue;
    const dirs = DIRS.filter(([dx, dy]) => freeRun(g, r[0], r[1], dx, dy) >= 5);
    if (dirs.length === 0) continue;
    let score = distToCenter(g.st, r[0], r[1]) + rng() * 14;
    if (prefer) {
      const pull = zonePull(g.st, r[0], r[1], prefer);
      score = Number.isFinite(pull) ? pull * 1.5 + rng() * 6 : score + 40; // тянемся к нужному району
    }
    if (score < bestScore) { bestScore = score; best = { start: r, dirs: dirs.sort(() => rng() - 0.5) }; }
  }
  return best;
}

function tryStreet(g: Occupancy, rng: () => number, start: [number, number], dirs?: [number, number][], minLen = 5): [number, number][] {
  const order = dirs ?? [...DIRS].sort(() => rng() - 0.5);
  for (const d0 of order) {
    let [dx, dy] = d0;
    const path: [number, number][] = [];
    let [x, y] = start;
    const len = minLen + Math.floor(rng() * 10);
    const diagonal = rng() < 0.25;
    let bends = 0;
    let toggle = false;
    let water = 0;
    for (let i = 0; i < len; i++) {
      if (!diagonal && i >= 3 && bends < 2 && rng() < 0.12) {
        const left = rng() < 0.5;
        [dx, dy] = left ? [dy, -dx] : [-dy, dx];
        bends++;
      }
      let sx = dx, sy = dy;
      if (diagonal) {
        toggle = !toggle;
        if (toggle) { sx = -dy; sy = dx; }
      }
      const nx = x + sx, ny = y + sy;
      if (!g.inb(nx, ny)) break;
      const c = g.t(nx, ny);
      if (c === '~') {
        water++;
        if (water > 3) break;
      } else if (c === '.') {
        if (!g.empty(nx, ny)) break;
        water = 0;
      } else {
        break;
      }
      let touching = false;
      for (let ax = -1; ax <= 1 && !touching; ax++)
        for (let ay = -1; ay <= 1; ay++) {
          const px = nx + ax, py = ny + ay;
          if (g.isRoad(px, py) && !path.some((p) => p[0] === px && p[1] === py) && !(Math.abs(px - start[0]) <= 1 && Math.abs(py - start[1]) <= 1)) { touching = true; break; }
        }
      if (touching && c !== '~') break;
      path.push([nx, ny]);
      x = nx; y = ny;
    }
    while (path.length && g.t(...(path[path.length - 1] as [number, number])) === '~') path.pop();
    if (path.length >= minLen - 1) return path;
  }
  return [];
}

function commitStreet(g: Occupancy, path: [number, number][]) {
  for (const [x, y] of path) {
    const wasWater = g.t(x, y) === '~';
    g.st.tiles[y]![x] = wasWater ? '=' : '#';
    g.roads.push([x, y]);
  }
}

/** Дорастить сеть улиц: до `streets` новых улиц. Возвращает число новых дорожных клеток. */
export function growStreets(st: CityState, rng: () => number, streets: number, occ?: Occupancy, prefer?: Zone): number {
  const g = occ ?? new Occupancy(st);
  let added = 0;
  for (let s = 0; s < streets; s++) {
    for (let attempt = 0; attempt < 25; attempt++) {
      const fr = frontierStart(g, rng, prefer);
      if (!fr) break;
      const path = tryStreet(g, rng, fr.start, fr.dirs);
      if (path.length === 0) continue;
      commitStreet(g, path);
      added += path.length;
      break;
    }
  }
  return added;
}

// ---------------------------------------------------------------- городская застройка (NPC)

/** Подходящие типы для зоны и центральности; крупные типы чаще ближе к центру. */
function kindsFor(zone: Exclude<Zone, 'park'>, c: number): { k: NpcKind; weight: number }[] {
  return NPC_KINDS.filter((k) => k.zone === zone && c >= k.minC && c <= k.maxC).map((k) => ({ k, weight: 1 + (k.w * k.h - 1) * c * 1.5 }));
}

const weighted = <T>(items: { k: T; weight: number }[], rng: () => number): T | null => {
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const i of items) if ((r -= i.weight) < 0) return i.k;
  return items.at(-1)!.k;
};

/** Можно ли поставить прямоугольник под городскую застройку: все клетки свободны, одной «не парковой» зоны. */
function fitsCity(g: Occupancy, st: CityState, x: number, y: number, w: number, h: number, zone: Zone): boolean {
  if (!g.inb(x, y, 1) || !g.inb(x + w - 1, y + h - 1, 1)) return false;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    if (!g.free(xx, yy)) return false;
    if (zoneOfCell(st, xx, yy) !== zone) return false;
  }
  return true;
}

/** Добавить городское здание с выходом к улице. Возвращает его или null, если подходящего места не нашлось. */
export function placeNpcBuilding(st: CityState, rng: () => number, zone: Exclude<Zone, 'park'>, occ: Occupancy, attempts = 60): Building | null {
  if (st.buildings.length >= MAX_BUILDINGS || occ.roads.length === 0) return null;
  // Кандидаты: пустые клетки нужной зоны, прилегающие к дороге
  const cand: [number, number, number, number][] = [];
  for (const [rx, ry] of occ.roads) {
    for (const [dx, dy] of DIRS) {
      const nx = rx + dx, ny = ry + dy;
      if (occ.free(nx, ny) && zoneOfCell(st, nx, ny) === zone) cand.push([nx, ny, dx, dy]);
    }
  }
  if (cand.length === 0) return null;
  let best: Building | null = null;
  let bestScore = Infinity;
  for (let a = 0; a < attempts; a++) {
    const [nx, ny, dx, dy] = cand[Math.floor(rng() * cand.length)]!;
    const c = centrality(st, nx + 0.5, ny + 0.5);
    const kind = weighted(kindsFor(zone, c), rng);
    if (!kind) continue;
    const rot = rng() < 0.5 && kind.w !== kind.h;
    const w = rot ? kind.h : kind.w, h = rot ? kind.w : kind.h;
    // прямоугольник упирается одной клеткой (nx, ny) в дорогу; сдвиг вдоль дороги — случайный
    const offW = Math.floor(rng() * (dx !== 0 ? h : w));
    let x0: number, y0: number;
    if (dx !== 0) { x0 = dx > 0 ? nx : nx - w + 1; y0 = ny - offW; } else { y0 = dy > 0 ? ny : ny - h + 1; x0 = nx - offW; }
    if (!fitsCity(occ, st, x0, y0, w, h, zone)) continue;
    const score = distToCenter(st, x0 + w / 2, y0 + h / 2) + rng() * 8;
    if (score < bestScore) {
      bestScore = score;
      best = { id: `new-${st.nextTempId}`, x: x0, y: y0, w, h, kind: kind.id, floors: 1, owner: null };
    }
  }
  if (!best) return null;
  st.nextTempId++;
  st.buildings.push(best);
  occ.mark(best, st.buildings.length);
  return best;
}

/** Нарастить этажность одного городского здания зоны (ближе к центру — чаще). Возвращает здание или null. */
export function addFloor(st: CityState, rng: () => number, zone: Exclude<Zone, 'park'>): Building | null {
  const cand = st.buildings.filter((b) => b.owner === null && NPC_KIND_BY_ID.get(b.kind)!.zone === zone && b.floors < NPC_KIND_BY_ID.get(b.kind)!.maxFloors);
  if (cand.length === 0) return null;
  let best: Building | null = null;
  let bestScore = Infinity;
  for (let k = 0; k < 14; k++) {
    const b = cand[Math.floor(rng() * cand.length)]!;
    const score = distToCenter(st, b.x + b.w / 2, b.y + b.h / 2) + b.floors * 3 + rng() * 8;
    if (score < bestScore) { bestScore = score; best = b; }
  }
  if (best) best.floors += 1;
  return best;
}

/** Сколько клеток вдоль улиц свободно под городскую застройку (фронт застройки); мало — городу нужны новые улицы. */
export function frontageCells(st: CityState, occ: Occupancy): number {
  let n = 0;
  const seen = new Set<number>();
  for (const [rx, ry] of occ.roads) {
    for (const [dx, dy] of DIRS) {
      const nx = rx + dx, ny = ry + dy, i = ny * st.width + nx;
      if (!seen.has(i) && occ.free(nx, ny) && zoneOfCell(st, nx, ny) !== 'park') { seen.add(i); n++; }
    }
  }
  return n;
}

/** Сколько клеток всё ещё свободно под городскую застройку (в городской зоне, не парк). */
export function freeBuildableCells(st: CityState, occ: Occupancy): number {
  const dist = roadDistance(st);
  let n = 0;
  for (let y = 0; y < st.height; y++) for (let x = 0; x < st.width; x++) {
    if (dist[y * st.width + x]! <= URBAN_REACH && occ.free(x, y) && zoneOfCell(st, x, y) !== 'park') n++;
  }
  return n;
}

// ---------------------------------------------------------------- вместимость города

export const buildingCapacity = (st: CityState, b: Building): number => {
  const k = NPC_KIND_BY_ID.get(b.kind);
  return k ? b.w * b.h * b.floors * k.per * st.params.capacityScale : 0;
};

export const housingCapacity = (st: CityState): number =>
  st.buildings.reduce((s, b) => (b.owner === null && NPC_KIND_BY_ID.get(b.kind)?.zone === 'residential' ? s + buildingCapacity(st, b) : s), 0);

export const cityJobs = (st: CityState): number =>
  st.buildings.reduce((s, b) => (b.owner === null && NPC_KIND_BY_ID.get(b.kind)?.zone !== 'residential' ? s + buildingCapacity(st, b) : s), 0);

// ---------------------------------------------------------------- стартовый город

export interface CityPlanOptions {
  width?: number;
  height?: number;
  params?: Partial<CityParams>;
}

/** Стартовый город: магистрали из центра, ветвление улиц, городская застройка до `targetBuildings`. */
export function generateInitialCity(cityId: string, seed: number, targetBuildings = 300, opts: CityPlanOptions = {}): CityState {
  const st = createState(cityId, seed, opts.width ?? 84, opts.height ?? 64, { ...DEFAULT_PARAMS, ...opts.params });
  const rng = mulberry32(seed);
  const g = new Occupancy(st);
  const c: [number, number] = [st.center.x, st.center.y];
  st.tiles[c[1]]![c[0]] = '#';
  g.roads.push(c);
  for (const d of DIRS) {
    const path = tryStreet(g, rng, c, [d], 12);
    if (path.length) commitStreet(g, path);
  }
  populateCity(st, rng, g, targetBuildings);
  assignInitialFloors(st, seed);
  return st;
}

/** Заселить город: улицы и застройка растут вместе, застройка занимает клетки у дорог, оставляя коридоры для новых улиц. */
export function populateCity(st: CityState, rng: () => number, g: Occupancy, targetBuildings: number): void {
  let guard = 0;
  while (st.buildings.length < targetBuildings && guard++ < 2500) {
    growStreets(st, rng, 1, g);
    for (let i = 0; i < 12 && st.buildings.length < targetBuildings; i++) placeNpcBuilding(st, rng, pickInitialZone(st, rng), g);
  }
}

/** Стартовая этажность: выше у центра, часть зданий остаётся низкими. */
export function assignInitialFloors(st: CityState, seed: number): void {
  const dev = mulberry32(seed ^ 0x5bd1e995);
  for (const b of st.buildings) {
    if (b.owner !== null) continue;
    const k = NPC_KIND_BY_ID.get(b.kind)!;
    const cn = centrality(st, b.x + b.w / 2, b.y + b.h / 2);
    b.floors = Math.max(1, Math.min(k.maxFloors, Math.round(1 + cn * (k.maxFloors - 1) * (0.5 + dev() * 0.6))));
  }
}

function pickInitialZone(st: CityState, rng: () => number): Exclude<Zone, 'park'> {
  const r = rng();
  return r < 0.62 ? 'residential' : r < 0.82 ? 'commercial' : 'industrial';
}

export const stateTiles = (st: CityState): string[] => st.tiles.map((r) => r.join(''));
export const tilesToGrid = (rows: string[]): string[][] => rows.map((r) => r.split(''));
