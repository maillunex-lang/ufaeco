import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompanyService } from '../src/companies/index.js';
import { ensureNpcCompanies } from '../src/companies/npc.js';
import { createPool, type Db } from '../src/persistence/db.js';
import { runMigrations } from '../src/persistence/migrate.js';
import { loadRegionData, validateRegionData, type RegionData } from '../src/region/data.js';
import { haversineKm, RegionNetwork } from '../src/region/network.js';
import { generateInitialCity, zoneOfCell } from '../src/world_map/generator.js';
import { calibrateCapacity, initialPopulation } from '../src/world_map/growth.js';
import { buildRegionGrid, lineCells } from '../src/region/grid.js';
import { MapService } from '../src/world_map/service.js';
import { startServer, TEST_DB_URL, TestClient } from './helpers.js';

const region = loadRegionData();
const clone = (): RegionData => structuredClone(region);

function inPolygon(lon: number, lat: number, poly: [number, number][]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

describe('данные региона РБ', () => {
  it('файлы проходят валидацию; 21 город, ресурсы, хабы, сеть', () => {
    expect(validateRegionData(region)).toEqual([]);
    expect(region.cities).toHaveLength(21);
    expect(region.cities.map((c) => c.id)).toEqual(expect.arrayContaining(['ufa', 'sterlitamak', 'salavat', 'neftekamsk', 'oktyabrsky', 'sibay', 'beloretsk']));
    expect(region.resources.length).toBeGreaterThanOrEqual(20);
    expect(new Set(region.resources.map((r) => r.resource)).size).toBe(7);
    expect(region.transport.hubs.length).toBeGreaterThanOrEqual(5);
  });

  it('все города и месторождения лежат внутри контура РБ (Natural Earth)', () => {
    const poly = region.geo.outline;
    for (const c of region.cities) expect(inPolygon(c.lon, c.lat, poly), `город ${c.id} вне контура`).toBe(true);
    for (const r of region.resources) expect(inPolygon(r.lon, r.lat, poly), `ресурс ${r.id} вне контура`).toBe(true);
    expect(region.geo.rivers.some((r) => r.name === 'Belaya')).toBe(true);
  });

  it('население и показатели правдоподобны; Уфа — крупнейший город', () => {
    const ufa = region.cities.find((c) => c.id === 'ufa')!;
    expect(ufa.population).toBeGreaterThan(1_000_000);
    for (const c of region.cities) {
      expect(c.population).toBeLessThanOrEqual(ufa.population);
      expect(c.land_base_cents_per_tile).toBeLessThanOrEqual(ufa.land_base_cents_per_tile);
    }
    const sorted = [...region.cities].sort((a, b) => b.population - a.population).map((c) => c.id);
    expect(sorted.slice(0, 3)).toEqual(['ufa', 'sterlitamak', 'salavat']);
  });

  it('валидатор ловит ошибки: дубликаты, ссылки на несуществующее, разрыв сети, выход за рамку', () => {
    const dup = clone(); dup.cities.push({ ...dup.cities[0]! });
    expect(validateRegionData(dup).join(' ')).toMatch(/дубликат города/);
    const badLink = clone(); badLink.transport.roads.push(['ufa', 'atlantis']);
    expect(validateRegionData(badLink).join(' ')).toMatch(/неизвестный город/);
    const badHub = clone(); badHub.transport.hubs[0]!.city = 'atlantis';
    expect(validateRegionData(badHub).join(' ')).toMatch(/хаб/);
    const island = clone(); island.transport.roads = island.transport.roads.filter(([a, b]) => a !== 'yanaul' && b !== 'yanaul');
    expect(validateRegionData(island).join(' ')).toMatch(/yanaul не связан/);
    const far = clone(); far.cities[1]!.lat = 40;
    expect(validateRegionData(far).join(' ')).toMatch(/вне рамки/);
  });
});

describe('транспортная сеть и фрахт', () => {
  const net = new RegionNetwork(region);

  it('расстояния: формула, симметрия, дорога не короче прямой', () => {
    const straight = haversineKm(54.735, 55.958, 53.63, 55.95);
    expect(straight).toBeGreaterThan(120);
    expect(straight).toBeLessThan(126);
    expect(net.straightKm('ufa', 'sterlitamak')).toBeCloseTo(straight, 0);
    for (const a of region.cities.slice(0, 8)) {
      for (const b of region.cities.slice(8, 16)) {
        const r = net.roadKm(a.id, b.id)!;
        expect(r).not.toBeNull();
        expect(r).toBeGreaterThanOrEqual(net.straightKm(a.id, b.id) - 1e-6);
        expect(net.roadKm(b.id, a.id)).toBeCloseTo(r, 6);
      }
    }
    expect(net.roadKm('ufa', 'ufa')).toBe(0);
  });

  it('неравенство треугольника на кратчайших путях', () => {
    const ids = region.cities.map((c) => c.id);
    for (let i = 0; i < 30; i++) {
      const a = ids[(i * 3) % ids.length]!, b = ids[(i * 7 + 1) % ids.length]!, c = ids[(i * 5 + 2) % ids.length]!;
      expect(net.roadKm(a, c)!).toBeLessThanOrEqual(net.roadKm(a, b)! + net.roadKm(b, c)! + 1e-6);
    }
  });

  it('железная дорога есть не везде; недостижимые пары → null', () => {
    expect(net.railKm('ufa', 'sibay')).not.toBeNull();
    expect(net.railKm('ufa', 'agidel')).toBeNull();
    expect(net.railKm('ufa', 'ufa')).toBe(0);
  });

  it('фрахт: близко дешевле авто, далеко — железная дорога; итог = тонны × цена за тонну', () => {
    const near = net.quote('ufa', 'chishmy', 10);
    expect(near.best).toBe('road');
    const far = net.quote('ufa', 'sibay', 10);
    expect(far.best).toBe('rail');
    expect(far.rail!.cost_cents_per_tonne).toBeLessThan(far.road!.cost_cents_per_tonne);
    expect(far.total_cents).toBe(far.cents_per_tonne * 10);
    const f = region.transport.freight;
    expect(far.road!.cost_cents_per_tonne).toBe(f.road.fixed_cents_per_tonne + Math.round(net.roadKm('ufa', 'sibay')! * f.road.cents_per_tonne_km));
    const noRail = net.quote('ufa', 'agidel', 1);
    expect(noRail.rail).toBeNull();
    expect(noRail.best).toBe('road');
    expect(net.quote('ufa', 'ufa', 5)).toMatchObject({ cents_per_tonne: 0, total_cents: 0 });
    // стоимость растёт с расстоянием
    expect(net.quote('ufa', 'sibay').road!.cost_cents_per_tonne).toBeGreaterThan(net.quote('ufa', 'sterlitamak').road!.cost_cents_per_tonne);
    expect(() => net.quote('ufa', 'atlantis')).toThrow();
  });
});

describe('сетка региона', () => {
  const grid = buildRegionGrid(region);

  it('размеры, маска региона и река: ячейка ≈ 8 км, внутри контура РБ', () => {
    expect(grid.cell_km).toBe(8);
    expect(grid.mask).toHaveLength(grid.height);
    for (const r of grid.mask) expect(r).toHaveLength(grid.width);
    const all = grid.mask.join('');
    expect((all.match(/[.~]/g) ?? []).length).toBeGreaterThan(1500);
    expect(all.includes('~')).toBe(true);
    expect(grid.width).toBeGreaterThan(40);
    expect(grid.height).toBeGreaterThan(50);
  });

  it('города на сетке: целые ячейки, без пересечений, на земле, габариты по населению, рядом с настоящим положением', () => {
    const taken = new Set<string>();
    for (const c of region.cities) {
      const r = grid.cities[c.id]!;
      expect(r, c.id).toBeDefined();
      const expected = c.population >= 1_000_000 ? 3 : c.population >= 100_000 ? 2 : 1;
      expect([r.w, r.h]).toEqual([expected, expected]);
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
        expect('.~').toContain(grid.mask[y]![x]);
        expect(taken.has(`${x},${y}`), `пересечение городов в ${x},${y}`).toBe(false);
        taken.add(`${x},${y}`);
      }
      // смещение от настоящей точки не больше 3 ячеек (≈24 км)
      const [lon0, , , lat1] = region.geo.bbox;
      const cos = Math.cos((((region.geo.bbox[1] + lat1) / 2) * Math.PI) / 180);
      const tx = ((c.lon - lon0) * cos * 111) / grid.cell_km, ty = ((lat1 - c.lat) * 111) / grid.cell_km;
      expect(Math.hypot(r.x + r.w / 2 - tx, r.y + r.h / 2 - ty), c.id).toBeLessThan(3.5);
    }
    expect(grid.cities.ufa!.w).toBe(3);
  });

  it('месторождения: по одной ячейке земли, не под городом, уникальные', () => {
    const cityCells = new Set<string>();
    for (const r of Object.values(grid.cities)) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) cityCells.add(`${x},${y}`);
    const seen = new Set<string>();
    for (const r of region.resources) {
      const p = grid.resources[r.id]!;
      expect(grid.mask[p.y]![p.x], r.id).toBe('.');
      expect(cityCells.has(`${p.x},${p.y}`)).toBe(false);
      expect(seen.has(`${p.x},${p.y}`)).toBe(false);
      seen.add(`${p.x},${p.y}`);
    }
  });

  it('дороги и железные дороги идут по ячейкам: связная цепочка от города до города', () => {
    for (const link of [...grid.roads, ...grid.rails]) {
      const a = grid.cities[link.a]!, b = grid.cities[link.b]!;
      const first = link.cells[0]!, last = link.cells.at(-1)!;
      expect(first).toEqual([a.x + Math.floor(a.w / 2), a.y + Math.floor(a.h / 2)]);
      expect(last).toEqual([b.x + Math.floor(b.w / 2), b.y + Math.floor(b.h / 2)]);
      for (let i = 1; i < link.cells.length; i++) {
        expect(Math.max(Math.abs(link.cells[i]![0] - link.cells[i - 1]![0]), Math.abs(link.cells[i]![1] - link.cells[i - 1]![1]))).toBe(1);
      }
    }
    expect(lineCells(0, 0, 3, 1)).toEqual([[0, 0], [1, 0], [2, 1], [3, 1]]);
  });
});

describe('города и сетка в БД', () => {
  let db: Db;
  const map = new MapService(new CompanyService());
  beforeAll(async () => {
    db = createPool(TEST_DB_URL);
    await runMigrations(db);
    await ensureNpcCompanies(db);
    await map.bootstrap(db, region);
  });
  afterAll(async () => { await db.end(); });

  it('bootstrap создаёт все города по данным и идемпотентен', async () => {
    const before = Number((await db.query('SELECT count(*) n FROM buildings')).rows[0].n);
    await map.bootstrap(db, region);
    expect(Number((await db.query('SELECT count(*) n FROM buildings')).rows[0].n)).toBe(before);
    const rows = (await db.query('SELECT id, name, lat, lon, wage_rub, base_population FROM cities ORDER BY id')).rows;
    expect(rows.map((r) => r.id).sort()).toEqual(region.cities.map((c) => c.id).sort());
    for (const c of region.cities) {
      const r = rows.find((x) => x.id === c.id)!;
      expect(r).toMatchObject({ name: c.name, lat: c.lat, lon: c.lon, wage_rub: c.wage_rub, base_population: c.population });
    }
  });

  it('у каждого города план нужного размера, городская застройка в границах, на земле, без пересечений, в своей зоне', async () => {
    for (const c of region.cities) {
      const loaded = await map.loadState(db, c.id);
      expect(loaded, c.id).not.toBeNull();
      const { st } = loaded!;
      expect(st.width).toBe(c.plan.width);
      expect(st.height).toBe(c.plan.height);
      expect(st.buildings.length).toBeGreaterThanOrEqual(Math.min(c.plan.target_buildings, 20));
      const seen = new Set<string>();
      for (const b of st.buildings) {
        expect(b.x + b.w).toBeLessThanOrEqual(st.width);
        expect(b.y + b.h).toBeLessThanOrEqual(st.height);
        for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
          expect(st.tiles[y]![x], `${c.id}: здание не на земле`).toBe('.');
          expect(seen.has(`${x},${y}`)).toBe(false);
          seen.add(`${x},${y}`);
        }
      }
    }
  });

  it('города без реки не имеют воды; города с рекой — имеют', async () => {
    for (const c of region.cities) {
      const { st } = (await map.loadState(db, c.id))!;
      expect(st.tiles.some((r) => r.includes('~')), c.id).toBe(c.plan.river);
    }
  });

  it('стартовое население города согласовано с данными (калибровка вместимости жилья)', () => {
    for (const c of region.cities) {
      const st = generateInitialCity(c.id, c.plan.seed, c.plan.target_buildings, { width: c.plan.width, height: c.plan.height, params: { landBaseCents: c.land_base_cents_per_tile, river: c.plan.river } });
      st.params.capacityScale = calibrateCapacity(st, c.population);
      expect(Math.abs(initialPopulation(st) - c.population) / c.population, c.id).toBeLessThan(0.01);
    }
  });

  it('оверлеи: центр дороже и оживлённее окраин; дороже город — дороже земля', async () => {
    const city = await db.query("SELECT 1");
    void city;
    const got = await map.getCity(db, 'sterlitamak');
    const hex = (row: string, x: number) => parseInt(row.slice(x * 2, x * 2 + 2), 16);
    const near: number[] = [], far: number[] = [], nearT: number[] = [], farT: number[] = [];
    for (let y = 0; y < got.height; y++) for (let x = 0; x < got.width; x++) {
      if (got.cells.zones[y]![x] === '-') continue;
      const d = Math.hypot(x - got.center.x, y - got.center.y);
      if (d < 8) { near.push(hex(got.cells.land_value[y]!, x)); nearT.push(hex(got.cells.traffic[y]!, x)); }
      if (d > 18) { far.push(hex(got.cells.land_value[y]!, x)); farT.push(hex(got.cells.traffic[y]!, x)); }
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(near)).toBeGreaterThan(mean(far));
    expect(mean(nearT)).toBeGreaterThan(mean(farT));
    const base = (id: string) => region.cities.find((c) => c.id === id)!.land_base_cents_per_tile;
    expect(base('ufa')).toBeGreaterThan(base('yanaul'));
    void zoneOfCell;
  });

  it('хабы и месторождения загружены, у месторождений есть ближайший город', async () => {
    expect(Number((await db.query('SELECT count(*) n FROM hubs')).rows[0].n)).toBe(region.transport.hubs.length);
    const res = (await db.query('SELECT id, resource, city_id, reserve_units, remaining_units FROM resource_sites')).rows;
    expect(res).toHaveLength(region.resources.length);
    for (const r of res) {
      expect(region.cities.some((c) => c.id === r.city_id)).toBe(true);
      expect(Number(r.remaining_units)).toBeLessThanOrEqual(Number(r.reserve_units));
    }
    expect(res.find((r) => r.id === 'copper_zinc-1')!.city_id).toBe('sibay');
  });
});

describe('команды региона по WebSocket и графики городов', () => {
  it('region.get, freight_quote, get_city для другого города, права и ошибки', async () => {
    const ctx = await startServer();
    try {
      const c = await TestClient.connect(ctx.url);
      expect((await c.register('r' + randomUUID().replace(/-/g, '').slice(0, 12))).type).toBe('auth_ok');
      const reg = (await c.command('region.get', {})).payload.result.region;
      expect(reg.cities).toHaveLength(21);
      expect(reg.grid.mask.length).toBe(reg.grid.height);
      expect(reg.grid.cities.ufa).toMatchObject({ w: 3, h: 3 });
      expect(reg.resources.length).toBe(region.resources.length);
      expect(reg.cities.find((x: { id: string }) => x.id === 'ufa')).toMatchObject({ has_hub: true });
      expect(reg.roads.every((r: { km: number }) => r.km > 0)).toBe(true);
      const q = (await c.command('region.freight_quote', { from_city: 'ufa', to_city: 'sibay', tonnes: 20 })).payload.result.quote;
      expect(q.best).toBe('rail');
      expect(q.total_cents).toBe(q.cents_per_tonne * 20);
      expect((await c.command('region.freight_quote', { from_city: 'ufa', to_city: 'atlantis' })).payload.error.code).toBe('not_found');
      expect((await c.command('region.freight_quote', { from_city: 'ufa', to_city: 'sibay', tonnes: -1 })).payload.error.code).toBe('invalid_payload');
      const st = (await c.command('map.get_city', { city_id: 'sterlitamak' })).payload.result.city;
      expect(st).toMatchObject({ id: 'sterlitamak', wage_rub: 58000 });
      expect(st.cells.land_value).toHaveLength(st.height);
      expect(st.buildings.length).toBeGreaterThan(20);
      expect((await c.command('city.get_stats', { city_id: 'nowhere' })).payload.error.code).toBe('not_found');
      await c.closeGracefully();
    } finally {
      await ctx.server.stop();
    }
  });

  it('месячный хук пишет показатели всех городов; графики доступны командой', async () => {
    const wid = 'rg' + randomUUID().replace(/-/g, '').slice(0, 8);
    const ctx = await startServer({ WORLD_ID: wid, TICKS_ENABLED: 'true', TIME_SPEED: '21600' }); // неделя = 1 с, месяц = 4 с
    try {
      await new Promise((r) => setTimeout(r, 9000)); // минимум одно закрытие месяца
      const rows = (await ctx.server.db.query(
        'SELECT month_index, count(*) n FROM city_stats_history GROUP BY month_index ORDER BY month_index DESC LIMIT 1')).rows;
      expect(rows.length).toBe(1);
      expect(Number(rows[0].n)).toBe(21);
      const c = await TestClient.connect(ctx.url);
      await c.register('g' + randomUUID().replace(/-/g, '').slice(0, 12));
      const stats = (await c.command('city.get_stats', { city_id: 'ufa', months: 12 })).payload.result.stats;
      expect(stats.history.length).toBeGreaterThanOrEqual(1);
      expect(stats.history[0]).toHaveProperty('population');
      expect(stats.history.map((h: { month_index: number }) => h.month_index)).toEqual([...stats.history.map((h: { month_index: number }) => h.month_index)].sort((a: number, b: number) => a - b));
      await c.closeGracefully();
    } finally {
      await ctx.server.stop();
    }
  }, 30000);
});
