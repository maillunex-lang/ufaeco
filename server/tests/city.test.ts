import { describe, expect, it } from 'vitest';
import {
  cellOverlays, cellPrice, centrality, generateInitialCity, growStreets, housingCapacity, mulberry32, NPC_KIND_BY_ID, NPC_KINDS,
  Occupancy, zoneOfCell, type CityState,
} from '../src/world_map/generator.js';
import { breadDemand, calibrateCapacity, priceFactor, stepCity, type CityStats } from '../src/world_map/growth.js';

const roads = (st: CityState): [number, number][] => {
  const r: [number, number][] = [];
  st.tiles.forEach((row, y) => row.forEach((c, x) => { if (c === '#' || c === '=') r.push([x, y]); }));
  return r;
};
const isRoad = (st: CityState, x: number, y: number) => '#='.includes(st.tiles[y]?.[x] ?? ' ');

/** Инварианты сетки: здания в границах, на земле, без пересечений, с габаритами из каталога; у городских — выход к улице; дороги связны. */
function checkGrid(st: CityState) {
  const cells = new Map<string, string>();
  for (const b of st.buildings) {
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(st.width);
    expect(b.y + b.h).toBeLessThanOrEqual(st.height);
    const k = NPC_KIND_BY_ID.get(b.kind)!;
    if (b.owner === null) {
      expect([`${k.w}x${k.h}`, `${k.h}x${k.w}`], `габариты ${b.kind}`).toContain(`${b.w}x${b.h}`);
      expect(b.floors).toBeGreaterThanOrEqual(1);
      expect(b.floors).toBeLessThanOrEqual(k.maxFloors);
    }
    let frontage = false;
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        expect(st.tiles[y]![x], 'здание не на земле').toBe('.');
        expect(cells.has(`${x},${y}`), `пересечение зданий в ${x},${y}`).toBe(false);
        cells.set(`${x},${y}`, b.id);
        expect(st.parcels.has(`${x},${y}`) && b.owner === null, 'городское здание на чужой клетке').toBe(false);
        if (([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => isRoad(st, x + dx, y + dy))) frontage = true;
      }
    }
    if (b.owner === null) expect(frontage, `здание ${b.id} без выхода на улицу`).toBe(true);
  }
  const rs = roads(st);
  const seen = new Set<string>([`${rs[0]![0]},${rs[0]![1]}`]);
  const q = [rs[0]!];
  while (q.length) {
    const [x, y] = q.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = `${x + dx},${y + dy}`;
      if (!seen.has(k) && isRoad(st, x + dx, y + dy)) { seen.add(k); q.push([x + dx, y + dy]); }
    }
  }
  expect(seen.size, 'дорожная сеть распалась на части').toBe(rs.length);
}

describe('стартовый город на сетке', () => {
  const city = generateInitialCity('ufa', 20241114, 600);

  it('детерминирован по seed', () => {
    const again = generateInitialCity('ufa', 20241114, 600);
    expect(again.tiles).toEqual(city.tiles);
    expect(again.buildings).toEqual(city.buildings);
    expect(generateInitialCity('ufa', 99, 300).tiles).not.toEqual(city.tiles);
  });

  it('инварианты сетки на нескольких seed и размерах', () => {
    checkGrid(city);
    for (const [seed, w, h, n] of [[1, 56, 44, 150], [7, 44, 34, 80], [42, 36, 28, 40], [1234, 64, 48, 200]] as const)
      checkGrid(generateInitialCity('t', seed, n, { width: w, height: h }));
  });

  it('здания разных габаритов: есть крупнее 1×1, несколько видов и размеров', () => {
    const sizes = new Set(city.buildings.map((b) => `${b.w}x${b.h}`));
    expect(sizes.size).toBeGreaterThanOrEqual(5);
    expect(city.buildings.filter((b) => b.w * b.h > 1).length).toBeGreaterThan(city.buildings.length * 0.3);
    expect(new Set(city.buildings.map((b) => b.kind)).size).toBeGreaterThanOrEqual(7);
    expect(city.buildings.some((b) => b.w * b.h >= 9)).toBe(true); // заводы 3×3
    for (const k of NPC_KINDS) expect(k.w * k.h).toBeGreaterThanOrEqual(1);
  });

  it('не решётка: нет улиц через всю карту, есть изгибы', () => {
    const maxRun = (rows: string[][]) => Math.max(...rows.map((r) => r.join('').split(/[^#=]+/).reduce((m, s) => Math.max(m, s.length), 0)));
    const cols = city.tiles[0]!.map((_, x) => city.tiles.map((r) => r[x]!));
    expect(maxRun(city.tiles)).toBeLessThan(city.width * 0.75);
    expect(maxRun(cols)).toBeLessThan(city.height * 0.75);
    let corners = 0;
    for (const [x, y] of roads(city)) {
      const h = isRoad(city, x - 1, y) || isRoad(city, x + 1, y), v = isRoad(city, x, y - 1) || isRoad(city, x, y + 1);
      if (h && v) corners++;
    }
    expect(corners).toBeGreaterThan(8);
  });

  it('районы-пятна: все зоны есть; городские здания стоят в своей зоне; центр коммерческий', () => {
    const zones = new Set<string>();
    for (let y = 0; y < city.height; y++) for (let x = 0; x < city.width; x++) if (city.tiles[y]![x] === '.') zones.add(zoneOfCell(city, x, y));
    expect([...zones].sort()).toEqual(['commercial', 'industrial', 'park', 'residential']);
    for (const b of city.buildings) {
      const kz = NPC_KIND_BY_ID.get(b.kind)!.zone;
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) expect(zoneOfCell(city, x, y)).toBe(kz);
    }
    expect(zoneOfCell(city, city.center.x + 1, city.center.y + 1)).toBe('commercial');
    const mean = (zone: string) => {
      const l = city.buildings.filter((b) => NPC_KIND_BY_ID.get(b.kind)!.zone === zone);
      return l.reduce((s, b) => s + Math.hypot(b.x - city.center.x, b.y - city.center.y), 0) / l.length;
    };
    expect(mean('commercial')).toBeLessThan(mean('industrial'));
  });

  it('этажность выше в центре; крупные здания ближе к центру', () => {
    const d = (b: { x: number; y: number }) => Math.hypot(b.x - city.center.x, b.y - city.center.y);
    const mean = (a: typeof city.buildings, f: (b: (typeof a)[number]) => number) => a.reduce((s, b) => s + f(b), 0) / Math.max(1, a.length);
    const near = city.buildings.filter((b) => d(b) < 10), far = city.buildings.filter((b) => d(b) > 22);
    expect(mean(near, (b) => b.floors)).toBeGreaterThan(mean(far, (b) => b.floors));
    expect(mean(near, (b) => b.w * b.h)).toBeGreaterThan(mean(far, (b) => b.w * b.h));
  });

  it('цены и оверлеи клеток: центр дороже, парк не продаётся, цена растёт со стоимостью земли', () => {
    expect(centrality(city, city.center.x + 0.5, city.center.y + 0.5)).toBeGreaterThan(0.9);
    const c = cellOverlays(city, city.center.x + 1, city.center.y + 1, 'commercial');
    const edge = cellOverlays(city, 2, 2, 'commercial');
    expect(c.land_value).toBeGreaterThan(edge.land_value);
    expect(c.traffic).toBeGreaterThan(edge.traffic);
    expect(cellPrice(1_000_000, 90, 'residential')).toBeGreaterThan(cellPrice(1_000_000, 20, 'residential'));
    expect(cellPrice(1_000_000, 90, 'park')).toBe(0);
    expect(cellPrice(1_000_000, 50, 'residential', 2)).toBe(cellPrice(1_000_000, 50, 'residential') * 2);
  });
});

describe('рост города', () => {
  const stats0 = (st: CityState): CityStats => ({ population: Math.round(housingCapacity(st) * 0.85), housing_cap: Math.round(housingCapacity(st)), jobs: 0 });

  it('growStreets добавляет улицы, сохраняя инварианты; детерминирован; не строит поверх частных клеток', () => {
    const a = generateInitialCity('ufa', 5, 300), b = generateInitialCity('ufa', 5, 300);
    // частные клетки рядом с дорогой
    const mine: string[] = [];
    for (const [rx, ry] of roads(a).slice(0, 60)) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x = rx + dx, y = ry + dy;
        if (a.tiles[y]?.[x] === '.' && !a.buildings.some((bb) => x >= bb.x && x < bb.x + bb.w && y >= bb.y && y < bb.y + bb.h)) { a.parcels.add(`${x},${y}`); b.parcels.add(`${x},${y}`); mine.push(`${x},${y}`); }
      }
    }
    const r0 = roads(a).length;
    for (let i = 0; i < 12; i++) { growStreets(a, mulberry32(100 + i), 1); growStreets(b, mulberry32(100 + i), 1); }
    expect(a.tiles).toEqual(b.tiles);
    expect(roads(a).length).toBeGreaterThan(r0);
    checkGrid(a);
    for (const k of mine) { const [x, y] = k.split(',').map(Number) as [number, number]; expect(a.tiles[y]![x]).toBe('.'); }
  });

  it('новые улицы пересекают реку мостами', () => {
    const st = generateInitialCity('ufa', 20241114, 300);
    for (let i = 0; i < 150; i++) growStreets(st, mulberry32(i + 1), 2);
    checkGrid(st);
    expect(st.tiles.some((r) => r.includes('='))).toBe(true);
  });

  it('тик города: новые здания на свободных клетках, детерминизм, инварианты; идентификаторы временные', () => {
    const a = generateInitialCity('ufa', 11, 200), b = generateInitialCity('ufa', 11, 200);
    const sig = { operatingEnterprises: 30, industrialEnterprises: 10, retailUnitsSold: 600 };
    const s1 = stepCity(a, stats0(a), sig, 5), s2 = stepCity(b, stats0(b), sig, 5);
    expect(s1.added).toEqual(s2.added);
    expect(s1.added.length + s1.floors.length).toBeGreaterThan(0);
    for (const nb of s1.added) { expect(nb.owner).toBeNull(); expect(nb.id).toMatch(/^new-/); }
    checkGrid(a);
  });

  it('активная экономика ускоряет застройку; без экономики город почти стоит', () => {
    const run = (sig: { operatingEnterprises: number; industrialEnterprises: number; retailUnitsSold: number }) => {
      const st = generateInitialCity('ufa', 11, 200);
      let stats = stats0(st);
      let built = 0;
      for (let t = 1; t <= 30; t++) {
        const step = stepCity(st, stats, sig, t);
        stats = step.stats;
        built += step.added.length + step.floors.length;
      }
      return { built, buildings: st.buildings.length, stats };
    };
    const idle = run({ operatingEnterprises: 0, industrialEnterprises: 0, retailUnitsSold: 0 });
    const busy = run({ operatingEnterprises: 40, industrialEnterprises: 25, retailUnitsSold: 1500 });
    expect(busy.built).toBeGreaterThan(idle.built * 2);
    expect(busy.stats.housing_cap).toBeGreaterThan(idle.stats.housing_cap);
  });

  it('промышленная активность смещает застройку в промзоны', () => {
    const run = (industrial: number) => {
      const st = generateInitialCity('ufa', 21, 120);
      const before = new Set(st.buildings.map((b) => b.id));
      let stats = stats0(st);
      for (let t = 1; t <= 25; t++) stats = stepCity(st, stats, { operatingEnterprises: 30, industrialEnterprises: industrial, retailUnitsSold: 300 }, t).stats;
      const added = st.buildings.filter((b) => !before.has(b.id));
      return added.filter((b) => NPC_KIND_BY_ID.get(b.kind)!.zone === 'industrial').length / Math.max(1, added.length);
    };
    expect(run(30)).toBeGreaterThan(run(0));
  });

  it('когда места нет, город растёт вверх и вширь: этажи и новые улицы', () => {
    const st = generateInitialCity('ufa', 3, 150, { width: 44, height: 34 });
    const r0 = roads(st).length, f0 = st.buildings.reduce((s, b) => s + b.floors, 0);
    let stats = stats0(st);
    for (let t = 1; t <= 120; t++) stats = stepCity(st, stats, { operatingEnterprises: 50, industrialEnterprises: 10, retailUnitsSold: 2000 }, t).stats;
    expect(st.buildings.reduce((s, b) => s + b.floors, 0)).toBeGreaterThan(f0);
    expect(roads(st).length).toBeGreaterThan(r0);
    checkGrid(st);
  });

  it('частные клетки город не застраивает', () => {
    const st = generateInitialCity('ufa', 3, 150);
    const occ = new Occupancy(st);
    const mine: string[] = [];
    for (const [rx, ry] of roads(st)) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x = rx + dx, y = ry + dy;
        if (occ.empty(x, y) && mine.length < 30) { st.parcels.add(`${x},${y}`); mine.push(`${x},${y}`); }
      }
    }
    let stats = stats0(st);
    for (let t = 1; t <= 60; t++) stats = stepCity(st, stats, { operatingEnterprises: 50, industrialEnterprises: 10, retailUnitsSold: 2000 }, t).stats;
    for (const k of mine) {
      const [x, y] = k.split(',').map(Number) as [number, number];
      expect(st.buildings.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h), `город занял частную клетку ${k}`).toBe(false);
      expect(st.tiles[y]![x]).toBe('.');
    }
  });

  it('население сходится к цели, не превышает жильё; калибровка вместимости под данные', () => {
    const st = generateInitialCity('ufa', 8, 200);
    st.params.capacityScale = calibrateCapacity(st, 280_000);
    expect(Math.abs(Math.round(housingCapacity(st) * 0.85) - 280_000) / 280_000).toBeLessThan(0.01);
    let stats = stats0(st);
    for (let t = 1; t <= 60; t++) {
      stats = stepCity(st, stats, { operatingEnterprises: 60, industrialEnterprises: 20, retailUnitsSold: 800 }, t, 280_000).stats;
      expect(stats.population).toBeLessThanOrEqual(stats.housing_cap + 1);
      expect(stats.population).toBeGreaterThanOrEqual(0);
    }
    expect(priceFactor(4000)).toBeGreaterThan(priceFactor(1000));
    expect(priceFactor(1e9)).toBeLessThanOrEqual(3);
    expect(priceFactor(0)).toBeGreaterThanOrEqual(0.7);
    expect(breadDemand(4000)).toBeGreaterThan(breadDemand(1000));
  });
});
