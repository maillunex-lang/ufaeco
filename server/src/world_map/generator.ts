/**
 * Органичный растущий город. Чистый детерминированный код (seed + день), без БД.
 *
 * Тайлы: '.' земля, '#' дорога, '~' вода, '=' мост.
 * Улицы растут от центра ветвями с изгибами и диагональными «лесенками», пересекают реку мостами.
 * Участки — прямоугольники разных размеров вдоль улиц; районы (зоны) — пятна по шуму, а не квадраты.
 * Один и тот же алгоритм строит стартовый город и дорастивает его по дням (growStreets).
 */
export type Zone = 'residential' | 'commercial' | 'industrial' | 'park';

export interface Lot {
  id: string; // "<city>-<n>"
  x: number;
  y: number;
  w: number;
  h: number;
  zone: Zone;
  base_price_cents: number; // цена «в нормальных условиях»
  price_cents: number; // текущая (меняется с ростом города)
  development: number; // 0 — пустырь, 1..3 — застроено городом (не продаётся)
  land_value: number; // 0..100 — оверлей «стоимость земли»
  traffic: number; // 0..100 — оверлей «трафик покупателей»
  /** Только при загрузке из БД: участок принадлежит компании (город на нём не строит). */
  owned?: boolean;
}

/** Параметры города, влияющие на цены и вместимость. */
export interface CityParams {
  /** базовая цена тайла, копейки */
  landBaseCents: number;
  /** жителей на тайл жилой застройки за уровень */
  capacityPerTile: number;
  /** есть ли река (вертикальная, извилистая) */
  river: boolean;
}

export const DEFAULT_PARAMS: CityParams = { landBaseCents: 2_000_000, capacityPerTile: 4, river: true };

export interface CityState {
  params: CityParams;
  cityId: string;
  seed: number;
  width: number;
  height: number;
  center: { x: number; y: number };
  tiles: string[][];
  lots: Lot[];
  nextLotSeq: number;
}

export const MAX_DEVELOPMENT = 3;
export const MAX_LOTS = 1400;
const MARGIN = 2;
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

/** Район по координатам: пятна шума, центр коммерческий, восточный берег и «грязные» пятна — промзона. */
export function zoneAt(st: CityState, cx: number, cy: number): Zone {
  const d = distToCenter(st, cx, cy);
  const n = vnoise(cx / 9, cy / 9, st.seed + 11);
  const m = vnoise(cx / 6, cy / 6, st.seed + 23);
  const river = riverX(st, cy);
  if (d < 6 + n * 6) return 'commercial';
  if (st.params.river ? cx > river + 3 && d > 11 : cx > st.center.x + st.width * 0.22 && d > 11) return 'industrial';
  if (m < 0.27 && d > 14) return 'industrial';
  if (st.params.river && Math.abs(cx - river) <= 4 && hash2(cx >> 1, cy >> 1, st.seed + 5) < 0.4) return 'park';
  if (m > 0.8 && d > 8) return 'park';
  return 'residential';
}

function riverX(st: Pick<CityState, 'seed' | 'width' | 'params'>, y: number): number {
  if (!st.params.river) return -1000;
  const base = st.width * 0.68;
  return Math.round(base + Math.sin(y / 6 + (st.seed % 17)) * 3 + (vnoise(y / 5, 0.5, st.seed + 3) - 0.5) * 6);
}

class Grid {
  claim: Int32Array; // индекс участка + 1
  roads: [number, number][] = [];
  constructor(readonly st: CityState) {
    this.claim = new Int32Array(st.width * st.height);
    st.lots.forEach((l, i) => this.mark(l, i + 1));
    for (let y = 0; y < st.height; y++) for (let x = 0; x < st.width; x++) if ('#='.includes(st.tiles[y]![x]!)) this.roads.push([x, y]);
  }
  mark(l: Lot, v: number) {
    for (let y = l.y; y < l.y + l.h; y++) for (let x = l.x; x < l.x + l.w; x++) this.claim[y * this.st.width + x] = v;
  }
  inb(x: number, y: number, m = MARGIN) {
    return x >= m && y >= m && x < this.st.width - m && y < this.st.height - m;
  }
  t(x: number, y: number): string {
    return this.st.tiles[y]?.[x] ?? ' ';
  }
  /** Свободно под участок: земля, не занято и не лежит в зарезервированном коридоре будущей боковой улицы. */
  free(x: number, y: number): boolean {
    return this.t(x, y) === '.' && this.claim[y * this.st.width + x] === 0 && !this.reserved(x, y);
  }
  /** Свободно под улицу (коридоры разрешены). */
  streetFree(x: number, y: number): boolean {
    return this.t(x, y) === '.' && this.claim[y * this.st.width + x] === 0;
  }
  /**
   * Коридоры боковых улиц: у ~20% дорожных тайлов 6 клеток наружу не отдаются под участки.
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
    return DIRS.some(([dx, dy]) => this.streetFree(x + dx, y + dy) && this.inb(x + dx, y + dy));
  }
  isRoad(x: number, y: number) {
    const c = this.t(x, y);
    return c === '#' || c === '=';
  }
}

export function createState(cityId: string, seed: number, width = 84, height = 64, params: CityParams = DEFAULT_PARAMS): CityState {
  const st: CityState = {
    params, cityId, seed, width, height, center: { x: Math.round(width * 0.42), y: Math.round(height * 0.5) },
    tiles: [], lots: [], nextLotSeq: 1,
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
function freeRun(g: Grid, x: number, y: number, dx: number, dy: number, max = 8): number {
  let n = 0, water = 0;
  for (let i = 1; i <= max; i++) {
    const px = x + dx * i, py = y + dy * i;
    if (!g.inb(px, py)) break;
    const c = g.t(px, py);
    if (c === '~') { if (++water > 3) break; n++; continue; }
    if (c !== '.' || !g.streetFree(px, py)) break;
    water = 0;
    n++;
  }
  return n;
}

/** Выбор места роста: дорожный тайл, от которого есть куда расти; предпочтительно ближе к центру. */
function frontierStart(g: Grid, rng: () => number): { start: [number, number]; dirs: [number, number][] } | null {
  if (g.roads.length === 0) return null;
  let best: { start: [number, number]; dirs: [number, number][] } | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < 160; i++) {
    const r = g.roads[Math.floor(rng() * g.roads.length)]!;
    if (g.t(r[0], r[1]) === '=') continue;
    const dirs = DIRS.filter(([dx, dy]) => freeRun(g, r[0], r[1], dx, dy) >= 5);
    if (dirs.length === 0) continue;
    const score = distToCenter(g.st, r[0], r[1]) + rng() * 14;
    if (score < bestScore) { bestScore = score; best = { start: r, dirs: dirs.sort(() => rng() - 0.5) }; }
  }
  return best;
}

/** Попытка проложить одну улицу. Возвращает построенные тайлы (пусто, если не вышло). */
function tryStreet(g: Grid, rng: () => number, start: [number, number], dirs?: [number, number][], minLen = 5): [number, number][] {
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
        // «лесенка»: шаги попеременно вдоль направления и перпендикулярно ему (4-связная диагональ)
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
        if (!g.streetFree(nx, ny)) break;
        water = 0;
      } else {
        // уткнулись в существующую дорогу: добавляем тайл-стык и заканчиваем (Т-образный перекрёсток)
        break;
      }
      // не идти вплотную параллельно существующим дорогам (кроме стартового пятачка)
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
    while (path.length && g.t(...(path[path.length - 1] as [number, number])) === '~') path.pop(); // улица не заканчивается в воде
    if (path.length >= minLen - 1) return path;
  }
  return [];
}

function commitStreet(g: Grid, path: [number, number][]) {
  for (const [x, y] of path) {
    const wasWater = g.t(x, y) === '~';
    g.st.tiles[y]![x] = wasWater ? '=' : '#';
    g.roads.push([x, y]);
  }
}

// ---------------------------------------------------------------- участки

const SIZES: [number, number][] = [[2, 2], [2, 2], [3, 2], [2, 3], [3, 3], [1, 2], [2, 1], [3, 1], [1, 3], [1, 1]];

const ZONE_LAND: Record<Zone, number> = { commercial: 1.0, residential: 0.8, industrial: 0.5, park: 0.4 };
const ZONE_TRAFFIC: Record<Zone, number> = { commercial: 1.0, residential: 0.55, industrial: 0.3, park: 0.5 };

/** Оверлеи участка (0..100): центральность города × зона + детерминированный шум. */
export function lotOverlays(st: CityState, x: number, y: number, w: number, h: number, zone: Zone): { land_value: number; traffic: number } {
  const cx = x + w / 2, cy = y + h / 2;
  const reach = 0.36 * Math.hypot(st.width, st.height);
  const c = Math.max(0, Math.min(1, 1 - distToCenter(st, cx, cy) / reach));
  const n = (hash2(x, y, st.seed + 31) - 0.5) * 10;
  const clamp = (v: number) => Math.max(1, Math.min(100, Math.round(v)));
  return {
    land_value: clamp(100 * (0.15 + 0.85 * Math.pow(c, 1.3)) * ZONE_LAND[zone] + n),
    traffic: clamp(100 * (0.1 + 0.9 * Math.pow(c, 1.5)) * ZONE_TRAFFIC[zone] + n),
  };
}

export const lotPrice = (landBaseCents: number, area: number, landValue: number, zone: Zone): number =>
  zone === 'park' ? 0 : Math.round(landBaseCents * area * (0.35 + 1.65 * (landValue / 100)));

function addLot(g: Grid, x: number, y: number, w: number, h: number): Lot {
  const st = g.st;
  const zone = zoneAt(st, x + w / 2, y + h / 2);
  const ov = lotOverlays(st, x, y, w, h, zone);
  const price = lotPrice(st.params.landBaseCents, w * h, ov.land_value, zone);
  const lot: Lot = { id: `${st.cityId}-${st.nextLotSeq++}`, x, y, w, h, zone, base_price_cents: price, price_cents: price, development: 0, ...ov };
  st.lots.push(lot);
  g.mark(lot, st.lots.length);
  return lot;
}

/** Участки вдоль дороги: прямоугольники разных размеров, упирающиеся в улицу. */
function carveLots(g: Grid, rng: () => number, road: [number, number][], maxNew = 999): Lot[] {
  const made: Lot[] = [];
  for (const [rx, ry] of road) {
    for (const [dx, dy] of DIRS) {
      if (made.length >= maxNew || g.st.lots.length >= MAX_LOTS) return made;
      const nx = rx + dx, ny = ry + dy;
      if (!g.free(nx, ny) || !g.inb(nx, ny, 1)) continue;
      const sizes = [...SIZES].sort(() => rng() - 0.5).sort((a, b) => b[0] * b[1] - a[0] * a[1] + (rng() - 0.5) * 3);
      for (const [sw, sh] of sizes) {
        // глубина — вдоль направления от дороги, ширина — вдоль дороги
        const depth = dx !== 0 ? sw : sh;
        const width = dx !== 0 ? sh : sw;
        const off = Math.floor(rng() * width);
        let x0: number, y0: number, w: number, h: number;
        if (dx !== 0) {
          x0 = dx > 0 ? nx : nx - depth + 1; y0 = ny - off; w = depth; h = width;
        } else {
          y0 = dy > 0 ? ny : ny - depth + 1; x0 = nx - off; h = depth; w = width;
        }
        let ok = g.inb(x0, y0, 1) && g.inb(x0 + w - 1, y0 + h - 1, 1);
        for (let yy = y0; ok && yy < y0 + h; yy++) for (let xx = x0; xx < x0 + w; xx++) if (!g.free(xx, yy)) { ok = false; break; }
        if (!ok) continue;
        made.push(addLot(g, x0, y0, w, h));
        break;
      }
    }
  }
  return made;
}

// ---------------------------------------------------------------- рост и генерация

export interface GrowthResult {
  newRoadTiles: number;
  newLots: Lot[];
}

/** Дорастить город: проложить до `streets` новых улиц и нарезать вдоль них участки. */
export function growStreets(st: CityState, rng: () => number, streets: number): GrowthResult {
  const g = new Grid(st);
  const res: GrowthResult = { newRoadTiles: 0, newLots: [] };
  for (let s = 0; s < streets && st.lots.length < MAX_LOTS; s++) {
    for (let attempt = 0; attempt < 25; attempt++) {
      const fr = frontierStart(g, rng);
      if (!fr) break;
      const path = tryStreet(g, rng, fr.start, fr.dirs);
      if (path.length === 0) continue;
      commitStreet(g, path);
      res.newRoadTiles += path.length;
      res.newLots.push(...carveLots(g, rng, path));
      break;
    }
  }
  // добор: заполнить пропуски вдоль уже существующих дорог
  const sample: [number, number][] = [];
  for (let i = 0; i < 40 && g.roads.length; i++) sample.push(g.roads[Math.floor(rng() * g.roads.length)]!);
  res.newLots.push(...carveLots(g, rng, sample, 12));
  return res;
}

/** Стартовый город: центр с радиальными магистралями, затем рост до нужного числа участков. */
export interface CityPlanOptions {
  width?: number;
  height?: number;
  params?: Partial<CityParams>;
}

export function generateInitialCity(cityId: string, seed: number, targetLots = 140, opts: CityPlanOptions = {}): CityState {
  const st = createState(cityId, seed, opts.width ?? 84, opts.height ?? 64, { ...DEFAULT_PARAMS, ...opts.params });
  const rng = mulberry32(seed);
  const g = new Grid(st);
  const c: [number, number] = [st.center.x, st.center.y];
  st.tiles[c[1]]![c[0]] = '#';
  g.roads.push(c);
  // магистрали из центра (на запад/восток/север/юг), длинные
  for (const d of DIRS) {
    const path = tryStreet(g, rng, c, [d], 12);
    if (path.length) { commitStreet(g, path); carveLots(g, rng, path); }
  }
  let guard = 0;
  while (st.lots.length < targetLots && guard++ < 1500) growStreets(st, rng, 1);
  // стартовая застройка: плотнее у центра, часть участков остаётся пустырями для игроков
  const dev = mulberry32(seed ^ 0x5bd1e995);
  for (const lot of st.lots) {
    if (lot.zone === 'park') continue;
    const d = distToCenter(st, lot.x + lot.w / 2, lot.y + lot.h / 2);
    const base = d < 9 ? 3 : d < 15 ? 2 : d < 21 ? 1 : 0;
    const vacant = dev() < 0.38;
    lot.development = vacant ? 0 : Math.max(0, Math.min(MAX_DEVELOPMENT, base - (dev() < 0.3 ? 1 : 0)));
  }
  return st;
}

export const stateTiles = (st: CityState): string[] => st.tiles.map((r) => r.join(''));

export function tilesToGrid(rows: string[]): string[][] {
  return rows.map((r) => r.split(''));
}
