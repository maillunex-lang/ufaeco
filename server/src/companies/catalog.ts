/**
 * Каталоги этапа 2. ВСЕ ЧИСЛА — ГИПОТЕЗЫ (ROADMAP: «коэффициенты калибруются тестами»).
 * Деньги хранятся в копейках (целые).
 */
export const STARTING_CAPITAL_CENTS = 100_000_000; // 1 000 000 ₽
export const MAX_COMPANIES_PER_PLAYER = 3;

export const PRODUCTS = ['grain', 'flour', 'bread', 'fuel'] as const;
export type ProductId = (typeof PRODUCTS)[number];

/** Стоимость создания предприятия, копейки. */
export const ENTERPRISE_KINDS = {
  farm: 30_000_000,
  elevator: 25_000_000,
  mill: 20_000_000,
  bakery: 15_000_000,
  shop: 10_000_000,
  construction_office: 18_000_000,
} as const;
export type EnterpriseKind = keyof typeof ENTERPRISE_KINDS;
export const ENTERPRISE_KIND_IDS = Object.keys(ENTERPRISE_KINDS) as [EnterpriseKind, ...EnterpriseKind[]];

/** Зонирование: в каких зонах города можно строить предприятие (только при постройке на участке карты). */
export const ENTERPRISE_ZONES: Record<EnterpriseKind, readonly string[]> = {
  farm: ['industrial'],
  elevator: ['industrial'],
  mill: ['industrial'],
  bakery: ['industrial', 'commercial'],
  shop: ['commercial', 'residential'],
  construction_office: ['commercial'],
};

/** Габариты здания в клетках (до поворота). Размеры — гипотезы, точные размеры из оригинала [K] сверить. */
export const ENTERPRISE_FOOTPRINT: Record<EnterpriseKind, { w: number; h: number }> = {
  farm: { w: 4, h: 3 },
  elevator: { w: 3, h: 3 },
  mill: { w: 3, h: 2 },
  bakery: { w: 2, h: 2 },
  shop: { w: 2, h: 1 },
  construction_office: { w: 2, h: 2 },
};

/** Каталог для клиента: что можно строить, сколько стоит и где. Параметры производства появятся с этапами 5–7. */
export const catalogView = () => ({
  enterprise_kinds: (Object.keys(ENTERPRISE_KINDS) as EnterpriseKind[]).map((k) => ({
    kind: k,
    cost_cents: ENTERPRISE_KINDS[k],
    zones: ENTERPRISE_ZONES[k],
    footprint: ENTERPRISE_FOOTPRINT[k],
  })),
});
