import { PRICE_MAX_FACTOR, PRICE_MAX_STEP, PRICE_MIN_FACTOR, PRICE_REVERSION, PRICE_SENSITIVITY } from './catalog.js';

/**
 * Цена на следующий день. Дефицит (спрос > предложения) повышает цену, избыток понижает;
 * шаг ограничен, есть возврат к базовой цене и жёсткие границы. Чистая функция.
 */
export function nextPrice(price: number, base: number, supply: number, demand: number): number {
  const top = Math.max(supply, demand, 1);
  const pressure = (demand - supply) / top; // −1..+1
  const step = Math.max(-PRICE_MAX_STEP, Math.min(PRICE_MAX_STEP, PRICE_SENSITIVITY * pressure));
  let p = price * (1 + step);
  p += (base - p) * PRICE_REVERSION;
  p = Math.max(base * PRICE_MIN_FACTOR, Math.min(base * PRICE_MAX_FACTOR, p));
  return Math.max(1, Math.round(p));
}
