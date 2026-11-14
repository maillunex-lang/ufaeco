/**
 * Календарь игры (спецификация — docs/TIME_MODEL.md). Чистые функции без обращения к системному времени и часовому поясу.
 *
 * 1 игровая неделя = 6 ч, 1 игровой месяц = 4 недели = 24 ч, год = 12 месяцев.
 * Месяц начинается в 09:00 по Уфе (UTC+5, без летнего времени) = 04:00 UTC.
 * Тик n выполняется в момент начала недели n и рассчитывает завершившуюся неделю n−1.
 */
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 6 * HOUR_MS;
export const UFA_UTC_OFFSET_MS = 5 * HOUR_MS;
export const MONTH_START_LOCAL_HOUR = 9;
export const WEEKS_PER_MONTH = 4;
export const MONTHS_PER_YEAR = 12;
export const TICKS_PER_YEAR = WEEKS_PER_MONTH * MONTHS_PER_YEAR;

export const MONTH_NAMES_RU = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
] as const;

export interface ClockParams {
  /** начало месяца №0 (09:00 по Уфе), мс Unix */
  epochMs: number;
  /** ускорение игрового времени относительно реального (1 — боевое значение) */
  speed: number;
  startYear: number;
  /** календарный месяц старта, 1..12 */
  startMonth: number;
}

/** Ближайшее 09:00 по Уфе не позже заданного момента. */
export function alignToMonthStart(ms: number): number {
  const local = ms + UFA_UTC_OFFSET_MS;
  let boundary = Math.floor(local / DAY_MS) * DAY_MS + MONTH_START_LOCAL_HOUR * HOUR_MS;
  if (boundary > local) boundary -= DAY_MS;
  return boundary - UFA_UTC_OFFSET_MS;
}

/** Время по Уфе (как UTC-поля Date) — для отображения и тестов. */
export function ufaLocal(ms: number): Date {
  return new Date(ms + UFA_UTC_OFFSET_MS);
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Индекс недели (номер тика), в которой находится момент `nowMs`. До epoch — отрицательный. */
export function tickIndexAt(p: ClockParams, nowMs: number): number {
  return Math.floor(((nowMs - p.epochMs) * p.speed) / WEEK_MS);
}

/** Реальный момент начала недели `tick`. */
export function tickStartMs(p: ClockParams, tick: number): number {
  return p.epochMs + (tick * WEEK_MS) / p.speed;
}

export interface GameDate {
  tick: number;
  month_index: number; // сквозной номер месяца от старта мира
  week: number; // 1..4
  year: number;
  month: number; // календарный 1..12
  month_name: string;
  is_month_start: boolean; // начало первой недели месяца
  is_month_end: boolean; // последняя неделя месяца
}

export function describeTick(p: ClockParams, tick: number): GameDate {
  const monthIndex = Math.floor(tick / WEEKS_PER_MONTH);
  const absMonth = p.startMonth - 1 + monthIndex;
  const week = mod(tick, WEEKS_PER_MONTH) + 1;
  const month = mod(absMonth, MONTHS_PER_YEAR);
  return {
    tick,
    month_index: monthIndex,
    week,
    year: p.startYear + Math.floor(absMonth / MONTHS_PER_YEAR),
    month: month + 1,
    month_name: MONTH_NAMES_RU[month]!,
    is_month_start: week === 1,
    is_month_end: week === WEEKS_PER_MONTH,
  };
}

/** Снимок часов для клиента: все моменты — реальные мс Unix сервера. */
export interface GameClockInfo extends GameDate {
  week_started_at: number;
  next_week_at: number;
  next_month_at: number;
  server_time: number;
  speed: number;
}

export function clockInfo(p: ClockParams, nowMs: number): GameClockInfo {
  const tick = tickIndexAt(p, nowMs);
  const nextMonthTick = (Math.floor(tick / WEEKS_PER_MONTH) + 1) * WEEKS_PER_MONTH;
  return {
    ...describeTick(p, tick),
    week_started_at: tickStartMs(p, tick),
    next_week_at: tickStartMs(p, tick + 1),
    next_month_at: tickStartMs(p, nextMonthTick),
    server_time: nowMs,
    speed: p.speed,
  };
}
