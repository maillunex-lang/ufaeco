import type { EnterpriseKind, ProductId } from '../companies/catalog.js';

/**
 * Экономические параметры этапа 3. ВСЕ ЧИСЛА — ГИПОТЕЗЫ, подлежащие калибровке тестами/симуляцией.
 * Деньги — копейки, товары — целые «единицы» (зерно/мука — тонны, хлеб — штуки, топливо — условные единицы).
 */
export const BASE_PRICES_CENTS: Record<ProductId, number> = {
  grain: 1_200_000,
  flour: 2_000_000,
  bread: 9_500,
  fuel: 6_800,
};

export interface Recipe {
  inputs: Partial<Record<ProductId, number>>;
  outputs: Partial<Record<ProductId, number>>;
}

/** Производство за один экономический день. Элеватор и стройконтора на этом этапе только платят зарплаты. */
export const RECIPES: Partial<Record<EnterpriseKind, Recipe>> = {
  farm: { inputs: { fuel: 5 }, outputs: { grain: 3 } },
  mill: { inputs: { grain: 3 }, outputs: { flour: 3 } },
  bakery: { inputs: { flour: 1, fuel: 2 }, outputs: { bread: 1500 } },
};

/** Зарплатный фонд предприятия за экономический день, копейки. */
export const WAGES_CENTS: Record<EnterpriseKind, number> = {
  farm: 300_000,
  elevator: 150_000,
  mill: 250_000,
  bakery: 200_000,
  shop: 150_000,
  construction_office: 200_000,
};

export const SHOP_CAPACITY_UNITS = 300; // хлеба в день на магазин
export const RESIDENT_BREAD_DEMAND = 600; // спрос жителей региона в день (до появления зон, этап 6)
export const BASELINE_UNITS = 100; // фоновые предложение и спрос NPC, чтобы цены не вырождались

export const SALES_TAX_BPS = 1000; // 10% с розничной выручки
export const NPC_SPREAD_BPS = 500; // ±5% к цене при сделке с NPC-трейдером
export const MAX_TRADE_UNITS = 10_000;

export const LOAN_RATE_BPS_PER_DAY = 50; // 0,5% в день
export const MAX_LOAN_CENTS = 50_000_000; // 500 000 ₽ на компанию
export const INSOLVENCY_DAYS = 3; // подряд: долг > активов
export const MISSED_WAGE_DAYS_LIMIT = 7; // подряд: не платит зарплаты

// Динамика цен
export const PRICE_SENSITIVITY = 0.25;
export const PRICE_MAX_STEP = 0.1; // не более ±10% за день
export const PRICE_REVERSION = 0.05; // возврат к базовой цене 5% в день
export const PRICE_MIN_FACTOR = 0.4;
export const PRICE_MAX_FACTOR = 3;

/** Служебные NPC-компании (фиксированные id, создаются при старте). */
export const NPC = {
  treasury: { id: '00000000-0000-4000-8000-000000000001', name: 'Казна Республики Башкортостан' },
  bank: { id: '00000000-0000-4000-8000-000000000002', name: 'Банк «БашЭКО»' },
  trader: { id: '00000000-0000-4000-8000-000000000003', name: 'Региональный торговый дом (NPC)' },
} as const;
export const NPC_MIN_FUNDS_CENTS = 1_000_000_000_000; // 10 млрд ₽: «бесконечная» ликвидность NPC
