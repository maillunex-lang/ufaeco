/**
 * Календарь игры (спецификация — docs/TIME_MODEL.md). Чистые функции без обращения к системному времени и часовому поясу.
 *
 * 1 игровой день = 1 реальный час; неделя = 6 дней = 6 ч; месяц = 4 недели = 24 дня = 24 ч; год = 12 месяцев = 288 дней = 12 суток.
 * Месяц начинается в 09:00 по Уфе (UTC+5, без летнего времени) = 04:00 UTC.
 * Тик n выполняется в момент начала игрового дня n и рассчитывает завершившийся день n−1;
 * недельные операции — при n кратном 6, месячные — кратном 24, годовые — кратном 288.
 */
export const HOUR_MS = 3_600_000;
export const REAL_DAY_MS = 24 * HOUR_MS;
/** длительность игрового дня при скорости 1 */
export const GAME_DAY_MS = HOUR_MS;
export const UFA_UTC_OFFSET_MS = 5 * HOUR_MS;
export const MONTH_START_LOCAL_HOUR = 9;
export const DAYS_PER_WEEK = 6;
export const WEEKS_PER_MONTH = 4;
export const DAYS_PER_MONTH = DAYS_PER_WEEK * WEEKS_PER_MONTH;
export const MONTHS_PER_YEAR = 12;
export const DAYS_PER_YEAR = DAYS_PER_MONTH * MONTHS_PER_YEAR;

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
  let boundary = Math.floor(local / REAL_DAY_MS) * REAL_DAY_MS + MONTH_START_LOCAL_HOUR * HOUR_MS;
  if (boundary > local) boundary -= REAL_DAY_MS;
  return boundary - UFA_UTC_OFFSET_MS;
}

/** Время по Уфе (как UTC-поля Date) — для отображения и тестов. */
export function ufaLocal(ms: number): Date {
  return new Date(ms + UFA_UTC_OFFSET_MS);
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Номер игрового дня (тика), в котором находится момент `nowMs`. До epoch — отрицательный. */
export function tickIndexAt(p: ClockParams, nowMs: number): number {
  return Math.floor(((nowMs - p.epochMs) * p.speed) / GAME_DAY_MS);
}

/** Реальный момент начала игрового дня `tick`. */
export function tickStartMs(p: ClockParams, tick: number): number {
  return p.epochMs + (tick * GAME_DAY_MS) / p.speed;
}

export interface GameDate {
  tick: number; // сквозной номер игрового дня
  month_index: number; // сквозной номер месяца от старта мира
  day: number; // день месяца 1..24
  day_of_week: number; // день недели 1..6
  week: number; // неделя месяца 1..4
  year: number;
  month: number; // календарный 1..12
  month_name: string;
  is_week_start: boolean;
  is_week_end: boolean;
  is_month_start: boolean;
  is_month_end: boolean;
}

export function describeTick(p: ClockParams, tick: number): GameDate {
  const monthIndex = Math.floor(tick / DAYS_PER_MONTH);
  const absMonth = p.startMonth - 1 + monthIndex;
  const dayInMonth = mod(tick, DAYS_PER_MONTH);
  const month = mod(absMonth, MONTHS_PER_YEAR);
  const dow = mod(tick, DAYS_PER_WEEK) + 1;
  return {
    tick,
    month_index: monthIndex,
    day: dayInMonth + 1,
    day_of_week: dow,
    week: Math.floor(dayInMonth / DAYS_PER_WEEK) + 1,
    year: p.startYear + Math.floor(absMonth / MONTHS_PER_YEAR),
    month: month + 1,
    month_name: MONTH_NAMES_RU[month]!,
    is_week_start: dow === 1,
    is_week_end: dow === DAYS_PER_WEEK,
    is_month_start: dayInMonth === 0,
    is_month_end: dayInMonth === DAYS_PER_MONTH - 1,
  };
}

/** Снимок часов для клиента: все моменты — реальные мс Unix сервера. */
export interface GameClockInfo extends GameDate {
  day_started_at: number;
  next_day_at: number;
  next_week_at: number;
  next_month_at: number;
  server_time: number;
  speed: number;
}

const nextMultiple = (tick: number, n: number) => (Math.floor(tick / n) + 1) * n;

export function clockInfo(p: ClockParams, nowMs: number): GameClockInfo {
  const tick = tickIndexAt(p, nowMs);
  return {
    ...describeTick(p, tick),
    day_started_at: tickStartMs(p, tick),
    next_day_at: tickStartMs(p, tick + 1),
    next_week_at: tickStartMs(p, nextMultiple(tick, DAYS_PER_WEEK)),
    next_month_at: tickStartMs(p, nextMultiple(tick, DAYS_PER_MONTH)),
    server_time: nowMs,
    speed: p.speed,
  };
}
