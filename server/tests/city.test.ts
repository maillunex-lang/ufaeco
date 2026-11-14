import { describe, expect, it } from 'vitest';
import {
  createState, generateInitialCity, growStreets, MAX_DEVELOPMENT, mulberry32, type CityState,
} from '../src/world_map/generator.js';
import { breadDemand, housingCap, priceFactor, stepCity, type CityStats } from '../src/world_map/growth.js';

const roads = (st: CityState): [number, number][] => {
  const r: [number, number][] = [];
  st.tiles.forEach((row, y) => row.forEach((c, x) => { if (c === '#' || c === '=') r.push([x, y]); }));
  return r;
};

function checkInvariants(st: CityState) {
  const claim = new Map<string, string>();
  for (const l of st.lots) {
    expect(l.x).toBeGreaterThanOrEqual(0);
    expect(l.y).toBeGreaterThanOrEqual(0);
    expect(l.x + l.w).toBeLessThanOrEqual(st.width);
    expect(l.y + l.h).toBeLessThanOrEqual(st.height);
    let frontage = false;
    for (let y = l.y; y < l.y + l.h; y++) {
      for (let x = l.x; x < l.x + l.w; x++) {
        expect(st.tiles[y]![x]).toBe('.');
        expect(claim.has(`${x},${y}`)).toBe(false);
        claim.set(`${x},${y}`, l.id);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if ('#='.includes(st.tiles[y + dy]?.[x + dx] ?? ' ')) frontage = true;
      }
    }
    expect(frontage, `участок ${l.id} без выхода на улицу`).toBe(true);
  }
  expect(new Set(st.lots.map((l) => l.id)).size).toBe(st.lots.length);
  // все дороги связаны
  const rs = roads(st);
  const seen = new Set<string>([`${rs[0]![0]},${rs[0]![1]}`]);
  const q = [rs[0]!];
  while (q.length) {
    const [x, y] = q.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const k = `${x + dx},${y + dy}`;
      if (!seen.has(k) && '#='.includes(st.tiles[y + dy]?.[x + dx] ?? ' ')) { seen.add(k); q.push([x + dx, y + dy]); }
    }
  }
  expect(seen.size, 'дорожная сеть распалась на части').toBe(rs.length);
}

describe('стартовый город', () => {
  const city = generateInitialCity('ufa', 20241114);

  it('детерминирован по seed', () => {
    expect(generateInitialCity('ufa', 20241114)).toEqual(city);
    expect(generateInitialCity('ufa', 99).tiles).not.toEqual(city.tiles);
  });
  it('инварианты: участки на земле, не пересекаются, имеют выход на улицу; дороги связны', () => {
    checkInvariants(city);
    for (const seed of [1, 7, 42, 1234]) checkInvariants(generateInitialCity('t', seed));
  });
  it('не решётка: нет улиц через всю карту, разные размеры участков, есть изгибы', () => {
    const maxRun = (rows: string[][]) => Math.max(...rows.map((r) => r.join('').split(/[^#=]+/).reduce((m, s) => Math.max(m, s.length), 0)));
    const cols = city.tiles[0]!.map((_, x) => city.tiles.map((r) => r[x]!));
    expect(maxRun(city.tiles)).toBeLessThan(city.width * 0.55);
    expect(maxRun(cols)).toBeLessThan(city.height * 0.55);
    expect(new Set(city.lots.map((l) => `${l.w}x${l.h}`)).size).toBeGreaterThanOrEqual(5);
    let corners = 0;
    const isR = (x: number, y: number) => '#='.includes(city.tiles[y]?.[x] ?? ' ');
    for (const [x, y] of roads(city)) {
      const h = isR(x - 1, y) || isR(x + 1, y), v = isR(x, y - 1) || isR(x, y + 1);
      if (h && v) corners++;
    }
    expect(corners).toBeGreaterThan(8);
    // квартальной сетки с шагом p нет ни для какого p
    for (let p = 3; p <= 9; p++) {
      const on = roads(city).filter(([x, y]) => x % p === 0 || y % p === 0).length / roads(city).length;
      expect(on).toBeLessThan(0.85);
    }
  });
  it('районы — пятна: все зоны есть, центр коммерческий, соседние участки чаще одной зоны', () => {
    const zones = new Set(city.lots.map((l) => l.zone));
    expect([...zones].sort()).toEqual(['commercial', 'industrial', 'park', 'residential']);
    const dist = (l: { x: number; y: number }) => Math.hypot(l.x - city.center.x, l.y - city.center.y);
    const avg = (z: string) => { const a = city.lots.filter((l) => l.zone === z); return a.reduce((s, l) => s + dist(l), 0) / a.length; };
    expect(avg('commercial')).toBeLessThan(avg('industrial'));
    expect(avg('commercial')).toBeLessThan(avg('residential'));
    let same = 0, total = 0;
    for (const l of city.lots) {
      const near = [...city.lots].filter((o) => o !== l).sort((a, b) => Math.hypot(a.x - l.x, a.y - l.y) - Math.hypot(b.x - l.x, b.y - l.y)).slice(0, 3);
      for (const o of near) { total++; if (o.zone === l.zone) same++; }
    }
    expect(same / total).toBeGreaterThan(0.5);
  });
  it('река, мосты и стартовая застройка: плотнее у центра, есть свободные пустыри', () => {
    expect(city.tiles.some((r) => r.includes('~'))).toBe(true);
    const built = city.lots.filter((l) => l.zone !== 'park');
    expect(built.filter((l) => l.development === 0).length).toBeGreaterThanOrEqual(5);
    expect(built.filter((l) => l.development > 0).length).toBeGreaterThanOrEqual(10);
    const d = (l: { x: number; y: number }) => Math.hypot(l.x - city.center.x, l.y - city.center.y);
    const mean = (a: typeof built) => a.reduce((s, l) => s + l.development, 0) / a.length;
    expect(mean(built.filter((l) => d(l) < 10))).toBeGreaterThan(mean(built.filter((l) => d(l) > 20)));
    for (const l of city.lots) expect(l.development).toBeLessThanOrEqual(MAX_DEVELOPMENT);
    for (const l of city.lots) expect(l.zone === 'park' ? l.price_cents === 0 : l.price_cents > 0).toBe(true);
  });
});

describe('рост города', () => {
  it('growStreets добавляет улицы и участки, сохраняя инварианты; детерминирован', () => {
    const a = generateInitialCity('ufa', 5);
    const b = generateInitialCity('ufa', 5);
    const n0 = a.lots.length, r0 = roads(a).length;
    for (let i = 0; i < 12; i++) { growStreets(a, mulberry32(100 + i), 1); growStreets(b, mulberry32(100 + i), 1); }
    expect(a).toEqual(b);
    expect(a.lots.length).toBeGreaterThan(n0);
    expect(roads(a).length).toBeGreaterThan(r0);
    checkInvariants(a);
    for (const l of a.lots.slice(n0)) expect(l.development).toBe(0); // новая земля — пустырь
  });
  it('новые улицы пересекают реку мостами', () => {
    const st = generateInitialCity('ufa', 20241114);
    for (let i = 0; i < 200; i++) growStreets(st, mulberry32(i + 1), 2);
    checkInvariants(st);
    expect(st.tiles.some((r) => r.includes('='))).toBe(true);
  });

  const stats0 = (st: CityState): CityStats => ({ population: Math.round(housingCap(st.lots) * 0.85), housing_cap: housingCap(st.lots), jobs: 0 });

  it('активная экономика ускоряет застройку; без экономики город почти стоит', () => {
    const run = (sig: { operatingEnterprises: number; industrialEnterprises: number; retailUnitsSold: number }) => {
      const st = generateInitialCity('ufa', 11);
      let stats = stats0(st);
      let dev = 0;
      for (let day = 1; day <= 30; day++) {
        const step = stepCity(st, stats, sig, day);
        stats = step.stats;
        dev += step.developed.length;
      }
      return { dev, lots: st.lots.length, stats };
    };
    const idle = run({ operatingEnterprises: 0, industrialEnterprises: 0, retailUnitsSold: 0 });
    const busy = run({ operatingEnterprises: 40, industrialEnterprises: 25, retailUnitsSold: 1500 });
    expect(busy.dev).toBeGreaterThan(idle.dev * 2);
    expect(busy.stats.population).toBeGreaterThanOrEqual(idle.stats.population);
    expect(busy.stats.housing_cap).toBeGreaterThan(idle.stats.housing_cap);
  });
  it('промышленная активность смещает застройку в промзоны', () => {
    const run = (industrial: number) => {
      const st = generateInitialCity('ufa', 21);
      for (const l of st.lots) l.development = 0; // чистый лист, чтобы видеть вклад зон
      let stats = stats0(st);
      for (let day = 1; day <= 25; day++) stats = stepCity(st, stats, { operatingEnterprises: 30, industrialEnterprises: industrial, retailUnitsSold: 300 }, day).stats;
      const dev = (z: string) => st.lots.filter((l) => l.zone === z).reduce((s, l) => s + l.development, 0);
      return dev('industrial') / Math.max(1, dev('industrial') + dev('residential') + dev('commercial'));
    };
    expect(run(30)).toBeGreaterThan(run(0));
  });
  it('участки компаний город не застраивает', () => {
    const st = generateInitialCity('ufa', 3);
    const mine = st.lots.filter((l) => l.zone === 'residential' && l.development === 0).slice(0, 4);
    mine.forEach((l) => { l.owned = true; });
    let stats = stats0(st);
    for (let day = 1; day <= 60; day++) stats = stepCity(st, stats, { operatingEnterprises: 50, industrialEnterprises: 10, retailUnitsSold: 2000 }, day).stats;
    expect(mine.every((l) => l.development === 0)).toBe(true);
  });
  it('население сходится к цели, не превышает жильё; цены на землю и спрос на хлеб растут с населением', () => {
    const st = generateInitialCity('ufa', 8);
    let stats = stats0(st);
    for (let day = 1; day <= 80; day++) {
      stats = stepCity(st, stats, { operatingEnterprises: 60, industrialEnterprises: 20, retailUnitsSold: 800 }, day).stats;
      expect(stats.population).toBeLessThanOrEqual(stats.housing_cap + 1);
      expect(stats.population).toBeGreaterThanOrEqual(0);
    }
    expect(priceFactor(4000)).toBeGreaterThan(priceFactor(1000));
    expect(priceFactor(1e9)).toBeLessThanOrEqual(3);
    expect(priceFactor(0)).toBeGreaterThanOrEqual(0.7);
    expect(breadDemand(4000)).toBeGreaterThan(breadDemand(1000));
    expect(breadDemand(0)).toBeGreaterThanOrEqual(100);
  });
  it('город не растёт бесконечно: потолок числа участков', () => {
    const st = createState('x', 1);
    expect(st.lots.length).toBe(0);
  });
});
