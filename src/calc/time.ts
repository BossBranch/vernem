import { plural } from './format.ts';

// Время храним в UTC, а считаем и показываем в часовом поясе дома.
// В России нет перехода на летнее время, но код от этого не зависит:
// смещение вычисляется через Intl для каждого момента.

export const MS_HOUR = 3_600_000;
export const MS_MIN = 60_000;

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(date: Date, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Смещение часового пояса относительно UTC в минутах для данного момента. */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const truncated = Math.floor(date.getTime() / MS_MIN) * MS_MIN;
  return Math.round((asUtc - truncated) / MS_MIN);
}

/** Момент времени по локальным дате и времени в поясе tz. */
export function fromLocal(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let offset = tzOffsetMinutes(new Date(guess), tz);
  let ts = guess - offset * MS_MIN;
  const offset2 = tzOffsetMinutes(new Date(ts), tz);
  if (offset2 !== offset) {
    offset = offset2;
    ts = guess - offset * MS_MIN;
  }
  return new Date(ts);
}

export function monthKey(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export function startOfNextLocalMonth(date: Date, tz: string): Date {
  const p = localParts(date, tz);
  const y = p.month === 12 ? p.year + 1 : p.year;
  const m = p.month === 12 ? 1 : p.month + 1;
  return fromLocal(y, m, 1, 0, 0, tz);
}

export type MonthSlice = { month: string; start: Date; end: Date };

/** Делит интервал по расчётным периодам (календарным месяцам в поясе дома). */
export function splitByMonth(start: Date, end: Date, tz: string): MonthSlice[] {
  const out: MonthSlice[] = [];
  let cur = start;
  while (cur < end) {
    const next = startOfNextLocalMonth(cur, tz);
    const sliceEnd = next < end ? next : end;
    out.push({ month: monthKey(cur, tz), start: cur, end: sliceEnd });
    cur = sliceEnd;
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDateTime(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${pad(p.day)}.${pad(p.month)}.${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatShort(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${pad(p.day)}.${pad(p.month)} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatDate(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${pad(p.day)}.${pad(p.month)}.${p.year}`;
}

const MONTHS_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/** «2026-09» → «сентябрь 2026» */
export function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS_NOM[m - 1]} ${y}`;
}

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «2026-10» → «октября» */
export function monthGenitive(month: string): string {
  return MONTHS_GEN[Number(month.split('-')[1]) - 1];
}

/** «2026-09» → «в сентябре 2026» */
export function monthPrepositional(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `в ${MONTHS_PREP[m - 1]} ${y}`;
}

export type ParsedTime = { ok: true; date: Date } | { ok: false; error: string };

/**
 * Разбирает время, которое ввёл житель:
 * «8:10», «08.10», «сегодня 8:10», «вчера 23:00», «22.09 08:10», «22.09.2026 8:10».
 */
export function parseLocalInput(text: string, now: Date, tz: string): ParsedTime {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[,в]\s/g, ' ');
  const today = localParts(now, tz);

  let dayShift = 0;
  let rest = t;
  if (rest.startsWith('сегодня')) rest = rest.slice(7).trim();
  else if (rest.startsWith('вчера')) {
    dayShift = -1;
    rest = rest.slice(5).trim();
  } else if (rest.startsWith('позавчера')) {
    dayShift = -2;
    rest = rest.slice(9).trim();
  }

  let y = today.year;
  let mo = today.month;
  let d = today.day;
  let timePart = rest;

  const dateMatch = rest.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s+(.+)$/);
  if (dateMatch) {
    if (dayShift !== 0) return { ok: false, error: 'Укажите либо «вчера», либо дату, но не всё сразу.' };
    d = Number(dateMatch[1]);
    mo = Number(dateMatch[2]);
    if (dateMatch[3]) {
      y = Number(dateMatch[3]);
      if (y < 100) y += 2000;
    }
    timePart = dateMatch[4];
  }

  const timeMatch = timePart.match(/^(\d{1,2})(?:[:.\-](\d{2}))?$/);
  if (!timeMatch) {
    return { ok: false, error: 'Не понял время. Напишите, например: 08:10, «вчера 23:00» или «21.09 18:30».' };
  }
  const h = Number(timeMatch[1]);
  const mi = timeMatch[2] ? Number(timeMatch[2]) : 0;
  if (h > 23 || mi > 59 || mo < 1 || mo > 12 || d < 1 || d > 31) {
    return { ok: false, error: 'Такого времени не бывает. Проверьте часы, минуты и дату.' };
  }

  let date = fromLocal(y, mo, d, h, mi, tz);
  const check = localParts(date, tz);
  if (check.day !== d || check.month !== mo) {
    return { ok: false, error: 'Такой даты нет в календаре. Проверьте число и месяц.' };
  }
  if (dayShift !== 0) date = new Date(date.getTime() + dayShift * 24 * MS_HOUR);

  // Дата без года в будущем — значит, прошлый год (например, 30.12 в январе).
  if (dateMatch && !dateMatch[3] && date.getTime() - now.getTime() > 24 * MS_HOUR) {
    date = fromLocal(y - 1, mo, d, h, mi, tz);
  }
  if (date.getTime() - now.getTime() > 5 * MS_MIN) {
    return { ok: false, error: 'Это время ещё не наступило. Укажите время в прошлом.' };
  }
  if (now.getTime() - date.getTime() > 92 * 24 * MS_HOUR) {
    return { ok: false, error: 'Это было больше трёх месяцев назад. Бот работает со свежими случаями.' };
  }
  return { ok: true, date };
}

export function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / MS_HOUR;
}

/** «3 ч 20 мин» */
export function formatDuration(hours: number): string {
  // «3 суток», а не «3 сут»: сокращение жителю непонятно.
  const totalMin = Math.max(0, Math.round(hours * 60));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} ${plural(d, ['сутки', 'суток', 'суток'])}`);
  if (h) parts.push(`${h} ч`);
  if (m && !d) parts.push(`${m} мин`);
  return parts.length ? parts.join(' ') : '0 мин';
}
