/**
 * Детерминированный генератор городской карты (по seed). Чистый код: без БД и случайности вне seed.
 * Сетка: дороги каждые 5 тайлов, между ними кварталы 4×4, каждый квартал — 4 участка 2×2.
 * Река извилисто пересекает город по вертикали; дороги через реку — мосты.
 */
export type Zone = 'residential' | 'commercial' | 'industrial' | 'park';

export interface Lot {
  id: string; // "<city>-<index>"
  x: number;
  y: number;
  w: number;
  h: number;
  zone: Zone;
  price_cents: number; // 0 — не продаётся (парк)
}

export interface CityMap {
  width: number;
  height: number;
  /** height строк по width символов: '.' земля, '#' дорога, '~' вода, '=' мост */
  tiles: string[];
  lots: Lot[];
}

export const BLOCK = 4;
export const PERIOD = 5;

// Базовые цены участков, копейки (гипотезы; калибровка — вместе с недвижимостью).
const BASE_PRICE: Record<Exclude<Zone, 'park'>, number> = {
  residential: 8_000_000,
  commercial: 20_000_000,
  industrial: 6_000_000,
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateCity(cityId: string, seed: number, blocksX = 9, blocksY = 6): CityMap {
  const rnd = mulberry32(seed);
  const width = blocksX * PERIOD;
  const height = blocksY * PERIOD;
  const riverBase = Math.floor(blocksX * PERIOD * 0.62);
  const phase = rnd() * Math.PI * 2;
  const riverCenter = (y: number) => riverBase + Math.round(Math.sin(y / 4 + phase) * 2);

  const grid: string[][] = [];
  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      const road = x % PERIOD === 0 || y % PERIOD === 0;
      const water = Math.abs(x - riverCenter(y)) <= 1;
      row.push(water ? (road ? '=' : '~') : road ? '#' : '.');
    }
    grid.push(row);
  }

  const cx = Math.floor(blocksX / 2) - 1;
  const cy = Math.floor(blocksY / 2);
  const lots: Lot[] = [];
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const dist = Math.max(Math.abs(bx - cx), Math.abs(by - cy));
      const parkRoll = rnd(); // всегда расходуем ГСЧ — раскладка зон не зависит от рельефа
      let zone: Zone = 'residential';
      if (dist <= 1) zone = 'commercial';
      else if (bx >= blocksX - 2) zone = 'industrial';
      else if (parkRoll < 0.12) zone = 'park';
      for (let ly = 0; ly < 2; ly++) {
        for (let lx = 0; lx < 2; lx++) {
          const x = bx * PERIOD + 1 + lx * 2;
          const y = by * PERIOD + 1 + ly * 2;
          let wet = false;
          for (let yy = y; yy < y + 2; yy++) for (let xx = x; xx < x + 2; xx++) if (grid[yy]![xx] === '~') wet = true;
          if (wet) continue; // участки на воде не создаются
          const central = Math.max(0, 3 - dist) / 10; // до +20% к цене в центре
          const price = zone === 'park' ? 0 : Math.round(BASE_PRICE[zone] * (1 + central));
          lots.push({ id: `${cityId}-${lots.length + 1}`, x, y, w: 2, h: 2, zone, price_cents: price });
        }
      }
    }
  }
  return { width, height, tiles: grid.map((r) => r.join('')), lots };
}
