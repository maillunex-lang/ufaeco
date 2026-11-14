import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Данные региона (data/rb/*.json): загрузка и строгая проверка. Значения помечены как приближённые в самих файлах. */
const dir = fileURLToPath(new URL('../../../data/rb/', import.meta.url));
const read = (name: string): unknown => JSON.parse(readFileSync(dir + name, 'utf8'));

const id = z.string().regex(/^[a-z0-9_-]{1,32}$/);
const lat = z.number().min(51).max(57);
const lon = z.number().min(52).max(61);

export const RESOURCES = ['oil', 'copper_zinc', 'gold', 'iron_ore', 'limestone', 'timber', 'clay_sand'] as const;
export type ResourceKind = (typeof RESOURCES)[number];

const citySchema = z.strictObject({
  id,
  name: z.string().min(2),
  lat,
  lon,
  population: z.number().int().min(1000),
  wage_rub: z.number().int().min(10_000).max(300_000),
  land_base_cents_per_tile: z.number().int().min(100_000),
  farmland_index: z.number().min(0).max(1),
  specialization: z.array(z.string()).min(1),
  plan: z.strictObject({
    width: z.number().int().min(24).max(160),
    height: z.number().int().min(24).max(160),
    target_lots: z.number().int().min(4).max(600),
    river: z.boolean(),
    seed: z.number().int().min(0),
  }),
});

const resourceSchema = z.strictObject({
  id,
  resource: z.enum(RESOURCES),
  name: z.string().min(3),
  lat,
  lon,
  reserve: z.number().int().min(1),
  quality: z.number().int().min(1).max(100),
});

const hubSchema = z.strictObject({
  id,
  city: id,
  kind: z.enum(['industrial', 'commercial', 'mixed']),
  gateway: z.enum(['west', 'east', 'north', 'south']),
  gateway_km: z.number().min(1).max(5000),
  name: z.string(),
});

const freightMode = z.strictObject({ fixed_cents_per_tonne: z.number().int().min(0), cents_per_tonne_km: z.number().int().min(1) });

const transportSchema = z.strictObject({
  schematic: z.literal(true),
  note: z.string(),
  road_winding_factor: z.number().min(1).max(2),
  rail_winding_factor: z.number().min(1).max(2),
  freight: z.strictObject({ road: freightMode, rail: freightMode }),
  roads: z.array(z.tuple([id, id])),
  rails: z.array(z.tuple([id, id])),
  hubs: z.array(hubSchema),
});

const geoSchema = z.strictObject({
  source: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  outline: z.array(z.tuple([z.number(), z.number()])).min(20),
  rivers: z.array(z.strictObject({ name: z.string(), points: z.array(z.tuple([z.number(), z.number()])).min(2) })),
});

export type CityData = z.infer<typeof citySchema>;
export type ResourceData = z.infer<typeof resourceSchema>;
export type HubData = z.infer<typeof hubSchema>;
export type TransportData = z.infer<typeof transportSchema>;
export type GeoData = z.infer<typeof geoSchema>;

export interface RegionData {
  id: 'rb';
  name: string;
  cities: CityData[];
  resources: ResourceData[];
  transport: TransportData;
  geo: GeoData;
}

/** Межфайловые проверки: ссылки, уникальность, связность. Возвращает список проблем (пустой — данные корректны). */
export function validateRegionData(d: RegionData): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const c of d.cities) {
    if (ids.has(c.id)) issues.push(`дубликат города ${c.id}`);
    ids.add(c.id);
  }
  const resIds = new Set<string>();
  for (const r of d.resources) {
    if (resIds.has(r.id)) issues.push(`дубликат ресурса ${r.id}`);
    resIds.add(r.id);
  }
  const hubIds = new Set<string>();
  for (const h of d.transport.hubs) {
    if (hubIds.has(h.id)) issues.push(`дубликат хаба ${h.id}`);
    hubIds.add(h.id);
    if (!ids.has(h.city)) issues.push(`хаб ${h.id}: неизвестный город ${h.city}`);
  }
  for (const [kind, list] of [['road', d.transport.roads], ['rail', d.transport.rails]] as const) {
    for (const [a, b] of list) {
      if (!ids.has(a) || !ids.has(b)) issues.push(`связь ${kind} ${a}–${b}: неизвестный город`);
      if (a === b) issues.push(`связь ${kind} ${a}–${b}: петля`);
    }
  }
  const [minLon, minLat, maxLon, maxLat] = d.geo.bbox;
  for (const c of d.cities) if (c.lon < minLon || c.lon > maxLon || c.lat < minLat || c.lat > maxLat) issues.push(`город ${c.id} вне рамки региона`);
  for (const r of d.resources) if (r.lon < minLon || r.lon > maxLon || r.lat < minLat || r.lat > maxLat) issues.push(`ресурс ${r.id} вне рамки региона`);
  // автодорожная сеть должна быть связной
  const adj = new Map<string, string[]>();
  for (const [a, b] of d.transport.roads) {
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  }
  const first = d.cities[0]?.id;
  if (first) {
    const seen = new Set([first]);
    const q = [first];
    while (q.length) for (const n of adj.get(q.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    for (const c of d.cities) if (!seen.has(c.id)) issues.push(`город ${c.id} не связан автодорогами`);
  }
  return issues;
}

let cached: RegionData | null = null;

export function loadRegionData(): RegionData {
  if (cached) return cached;
  const cities = z.strictObject({ approximate: z.literal(true), note: z.string(), cities: z.array(citySchema).min(1) }).parse(read('cities.json'));
  const resources = z.strictObject({ approximate: z.literal(true), note: z.string(), resources: z.array(resourceSchema) }).parse(read('resources.json'));
  const data: RegionData = {
    id: 'rb',
    name: 'Республика Башкортостан',
    cities: cities.cities,
    resources: resources.resources,
    transport: transportSchema.parse(read('transport.json')),
    geo: geoSchema.parse(read('geo.json')),
  };
  const issues = validateRegionData(data);
  if (issues.length) throw new Error('Данные региона некорректны:\n' + issues.join('\n'));
  cached = data;
  return data;
}
