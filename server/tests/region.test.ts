import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompanyService } from '../src/companies/index.js';
import { ensureNpcCompanies } from '../src/companies/npc.js';
import { createPool, type Db } from '../src/persistence/db.js';
import { runMigrations } from '../src/persistence/migrate.js';
import { loadRegionData, validateRegionData, type RegionData } from '../src/region/data.js';
import { haversineKm, RegionNetwork } from '../src/region/network.js';
import { generateInitialCity, lotPrice } from '../src/world_map/generator.js';
import { calibrateCapacity, initialPopulation } from '../src/world_map/growth.js';
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

describe('города и участки в БД', () => {
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
    const before = Number((await db.query('SELECT count(*) n FROM map_lots')).rows[0].n);
    await map.bootstrap(db, region);
    expect(Number((await db.query('SELECT count(*) n FROM map_lots')).rows[0].n)).toBe(before);
    const rows = (await db.query('SELECT id, name, lat, lon, wage_rub, base_population FROM cities ORDER BY id')).rows;
    expect(rows.map((r) => r.id).sort()).toEqual(region.cities.map((c) => c.id).sort());
    for (const c of region.cities) {
      const r = rows.find((x) => x.id === c.id)!;
      expect(r).toMatchObject({ name: c.name, lat: c.lat, lon: c.lon, wage_rub: c.wage_rub, base_population: c.population });
    }
  });

  it('у каждого города есть план нужного размера, участки в границах, без пересечений и на земле', async () => {
    for (const c of region.cities) {
      const loaded = await map.loadState(db, c.id);
      expect(loaded, c.id).not.toBeNull();
      const { st } = loaded!;
      expect(st.width).toBe(c.plan.width);
      expect(st.height).toBe(c.plan.height);
      expect(st.lots.length).toBeGreaterThanOrEqual(Math.min(c.plan.target_lots, 12));
      const seen = new Set<string>();
      for (const l of st.lots) {
        expect(l.x + l.w).toBeLessThanOrEqual(st.width);
        expect(l.y + l.h).toBeLessThanOrEqual(st.height);
        for (let y = l.y; y < l.y + l.h; y++) for (let x = l.x; x < l.x + l.w; x++) {
          expect(st.tiles[y]![x], `${c.id}: участок ${l.id} не на земле`).toBe('.');
          expect(seen.has(`${x},${y}`)).toBe(false);
          seen.add(`${x},${y}`);
        }
      }
    }
  });

  it('города без реки не имеют воды; города с рекой — имеют', async () => {
    for (const c of region.cities) {
      const { st } = (await map.loadState(db, c.id))!;
      const water = st.tiles.some((r) => r.includes('~'));
      expect(water, c.id).toBe(c.plan.river);
    }
  });

  it('стартовое население города согласовано с данными (калибровка вместимости жилья)', () => {
    for (const c of region.cities) {
      const st = generateInitialCity(c.id, c.plan.seed, c.plan.target_lots, { width: c.plan.width, height: c.plan.height, params: { landBaseCents: c.land_base_cents_per_tile, river: c.plan.river } });
      const cpt = calibrateCapacity(st.lots, c.population);
      const pop = initialPopulation(st.lots, cpt);
      expect(Math.abs(pop - c.population) / c.population, c.id).toBeLessThan(0.01);
    }
  });

  it('оверлеи: центр дороже и оживлённее окраин, коммерция дороже промзоны; цена растёт со стоимостью земли', async () => {
    const { st } = (await map.loadState(db, 'sterlitamak'))!;
    const dist = (l: { x: number; y: number; w: number; h: number }) => Math.hypot(l.x + l.w / 2 - st.center.x, l.y + l.h / 2 - st.center.y);
    const lots = st.lots.filter((l) => l.zone !== 'park');
    const sorted = [...lots].sort((a, b) => dist(a) - dist(b));
    const mean = (a: typeof lots, f: (l: (typeof lots)[number]) => number) => a.reduce((s, l) => s + f(l), 0) / a.length;
    const k = Math.max(3, Math.floor(sorted.length / 4));
    expect(mean(sorted.slice(0, k), (l) => l.land_value)).toBeGreaterThan(mean(sorted.slice(-k), (l) => l.land_value));
    expect(mean(sorted.slice(0, k), (l) => l.traffic)).toBeGreaterThan(mean(sorted.slice(-k), (l) => l.traffic));
    for (const l of st.lots) { expect(l.land_value).toBeGreaterThanOrEqual(1); expect(l.land_value).toBeLessThanOrEqual(100); }
    expect(lotPrice(1_000_000, 4, 90, 'residential')).toBeGreaterThan(lotPrice(1_000_000, 4, 20, 'residential'));
    expect(lotPrice(1_000_000, 4, 90, 'park')).toBe(0);
    // дороже город — дороже земля
    const ufa = (await map.loadState(db, 'ufa'))!.st.lots.filter((l) => l.zone === 'commercial');
    const yan = (await map.loadState(db, 'yanaul'))!.st.lots.filter((l) => l.zone === 'commercial');
    if (ufa.length && yan.length) expect(mean(ufa, (l) => l.base_price_cents / (l.w * l.h))).toBeGreaterThan(mean(yan, (l) => l.base_price_cents / (l.w * l.h)));
  });

  it('хабы и месторождения загружены, у месторождений есть ближайший город', async () => {
    expect(Number((await db.query('SELECT count(*) n FROM hubs')).rows[0].n)).toBe(region.transport.hubs.length);
    const res = (await db.query('SELECT id, resource, city_id, reserve_units, remaining_units FROM resource_sites')).rows;
    expect(res).toHaveLength(region.resources.length);
    for (const r of res) {
      expect(region.cities.some((c) => c.id === r.city_id)).toBe(true);
      expect(Number(r.remaining_units)).toBeLessThanOrEqual(Number(r.reserve_units));
    }
    const sibay = res.find((r) => r.id === 'copper_zinc-1')!;
    expect(sibay.city_id).toBe('sibay');
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
      expect(reg.outline.length).toBeGreaterThan(100);
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
      expect(st.lots[0]).toHaveProperty('land_value');
      expect(st.lots[0]).toHaveProperty('traffic');
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
