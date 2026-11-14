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
