// Движок расчёта снижения платы за коммунальные услуги по Приложению № 1 к ПП РФ № 354.
// Чистые функции без ввода-вывода: вход — нормы и факты, выход — проценты и объяснение.
// Везде считаем оценку снизу: неполные часы и неполные шаги не засчитываются.

import { allowedMonthlyHours } from './norms.ts';
import type { HeatingTempNorm, HotWaterTempNorm, ServiceNorm } from './norms.ts';
import { fmtNum, fmtPercent, fmtRub } from './format.ts';
import { MS_HOUR, MS_MIN, hoursBetween, localParts, monthKey, splitByMonth, formatDuration } from './time.ts';

export type Interval = { start: Date; end: Date };
export type Reading = { at: Date; tempC: number };

export type CalcInput =
  | { kind: 'interruption'; intervals: Interval[]; variant?: string | null }
  | { kind: 'heating_temperature'; readings: Reading[]; end: Date; corner?: boolean; coldRegion?: boolean }
  | { kind: 'hot_water_temperature'; readings: Reading[]; end: Date };

export type MonthCalc = {
  month: string;
  /** Процент снижения платы за месяц, не больше 100. */
  percent: number;
  /** Строки объяснения: факт → формула → итог. */
  lines: string[];
  /** Часы, когда горячая вода была ниже +40 °C: оплата по тарифу холодной воды. */
  coldTariffHours?: number;
  totalHours?: number;
  excessHours?: number;
  singleLimitExceeded?: boolean;
};

export type CalcResult = {
  serviceKey: string;
  kind: CalcInput['kind'];
  basis: string;
  months: MonthCalc[];
  notes: string[];
};

const EPS = 1e-9;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Объединяет пересекающиеся интервалы, чтобы одно отключение не посчиталось дважды. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.end.getTime() > i.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start.getTime() <= last.end.getTime()) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}

export function calcInterruption(norm: ServiceNorm, intervals: Interval[], tz: string, variant?: string | null): CalcResult {
  const n = norm.interruption;
  if (!n) throw new Error(`${norm.key}: не норма перерыва`);
  const allowed = allowedMonthlyHours(n, variant);
  const merged = mergeIntervals(intervals);

  const byMonth = new Map<string, { total: number; maxSingle: number }>();
  for (const iv of merged) {
    const fullHours = hoursBetween(iv.start, iv.end);
    for (const slice of splitByMonth(iv.start, iv.end, tz)) {
      const cur = byMonth.get(slice.month) ?? { total: 0, maxSingle: 0 };
      cur.total += hoursBetween(slice.start, slice.end);
      cur.maxSingle = Math.max(cur.maxSingle, fullHours);
      byMonth.set(slice.month, cur);
    }
  }

  const months: MonthCalc[] = [];
  for (const [month, { total, maxSingle }] of [...byMonth.entries()].sort()) {
    const excess = Math.max(0, total - allowed);
    const units = Math.floor(excess / n.unit_hours + EPS);
    const percent = Math.min(100, round2(units * n.rate_percent));
    const singleLimitExceeded = n.single_hours !== undefined && maxSingle > n.single_hours + EPS;
    const lines: string[] = [];
    lines.push(`Перерыв за месяц: ${formatDuration(total)}. Допустимо: ${fmtNum(allowed)} ч в месяц.`);
    if (units === 0) {
      lines.push(
        excess > 0
          ? `Превышение ${formatDuration(excess)} — меньше полного ${n.unit_hours === 1 ? 'часа' : `периода ${n.unit_hours} ч`}, снижение не начисляется.`
          : 'Допустимый лимит не превышен, снижение платы не положено.',
      );
    } else if (n.unit_hours === 1) {
      lines.push(`Превышение: ${units} ч.`);
      lines.push(`${units} × ${fmtPercent(n.rate_percent)} = ${fmtPercent(percent)} от платы за месяц.`);
    } else {
      lines.push(`Превышение: ${formatDuration(excess)} → полных периодов по ${n.unit_hours} ч: ${units}.`);
      lines.push(`${units} × ${fmtPercent(n.rate_percent)} = ${fmtPercent(percent)} от платы за месяц.`);
    }
    if (singleLimitExceeded) {
      lines.push(
        `Кроме того, один перерыв длился ${formatDuration(maxSingle)} — дольше допустимых ${n.single_hours} ч подряд. На сумму это не влияет, но это ещё одно нарушение.`,
      );
    }
    months.push({ month, percent, lines, totalHours: round2(total), excessHours: round2(excess), singleLimitExceeded });
  }

  const notes: string[] = [];
  if (n.single_hours_note) notes.push(`Единовременный лимит: ${n.single_hours_note}.`);
  if (n.variants) {
    notes.push(
      variant === 'two_sources'
        ? 'Считаю по норме для дома с двумя независимыми источниками питания: 2 ч.'
        : 'Считаю по строгой норме для дома с одним источником питания: 24 ч. Если источников два, сумма будет больше.',
    );
  }
  return { serviceKey: norm.key, kind: 'interruption', basis: norm.item, months, notes };
}

/** Идёт по отрезкам, которые не пересекают границу локального часа, и вызывает cb для каждого. */
function walkLocalHours(start: Date, end: Date, tz: string, cb: (from: Date, hours: number, localHour: number, month: string) => void) {
  let cur = start.getTime();
  const stop = end.getTime();
  while (cur < stop) {
    const d = new Date(cur);
    const p = localParts(d, tz);
    const msIntoMinute = cur % MS_MIN;
    const toNextHour = (60 - p.minute) * MS_MIN - msIntoMinute;
    const next = Math.min(stop, cur + toNextHour);
    cb(d, (next - cur) / MS_HOUR, p.hour, monthKey(d, tz));
    cur = next;
  }
}

function isNight(hour: number, from: number, to: number): boolean {
  return hour >= from && hour < to;
}

function segments(readings: Reading[], end: Date): { start: Date; end: Date; tempC: number }[] {
  const sorted = [...readings].sort((a, b) => a.at.getTime() - b.at.getTime());
  const out: { start: Date; end: Date; tempC: number }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const segEnd = i + 1 < sorted.length ? sorted[i + 1].at : end;
    if (segEnd.getTime() > sorted[i].at.getTime()) out.push({ start: sorted[i].at, end: segEnd, tempC: sorted[i].tempC });
  }
  return out;
}

export function calcHeatingTemperature(
  norm: ServiceNorm,
  readings: Reading[],
  end: Date,
  tz: string,
  opts: { corner?: boolean; coldRegion?: boolean } = {},
): CalcResult {
  const t = norm.temperature as HeatingTempNorm;
  const normC = opts.coldRegion
    ? opts.corner
      ? t.cold_region_corner_norm_c
      : t.cold_region_norm_c
    : opts.corner
      ? t.corner_norm_c
      : t.norm_c;

  const byMonth = new Map<string, { degreeHours: number; hoursBelow: number; minTemp: number }>();
  for (const seg of segments(readings, end)) {
    walkLocalHours(seg.start, seg.end, tz, (_from, hours, hour, month) => {
      const required = isNight(hour, t.night_from_hour, t.night_to_hour) ? normC - t.night_drop_c : normC;
      const deviation = Math.max(0, required - seg.tempC);
      const cur = byMonth.get(month) ?? { degreeHours: 0, hoursBelow: 0, minTemp: Infinity };
      cur.degreeHours += deviation * hours;
      if (deviation > 0) cur.hoursBelow += hours;
      cur.minTemp = Math.min(cur.minTemp, seg.tempC);
      byMonth.set(month, cur);
    });
  }

  const months: MonthCalc[] = [];
  for (const [month, m] of [...byMonth.entries()].sort()) {
    const degreeHours = Math.floor(m.degreeHours * 100 + EPS) / 100;
    const percent = Math.min(100, round2(degreeHours * t.rate_percent_per_degree_hour));
    const lines: string[] = [];
    lines.push(
      `Норма в комнате: не ниже +${normC} °C днём, ночью (с ${t.night_from_hour} до ${t.night_to_hour} ч) допустимо на ${t.night_drop_c} °C ниже.`,
    );
    if (degreeHours <= 0) {
      lines.push('Температура не опускалась ниже нормы — снижение платы не положено.');
    } else {
      lines.push(`Часов ниже нормы: ${fmtNum(m.hoursBelow, 1)}. Недобор тепла: ${fmtNum(degreeHours)} (градусы ниже нормы × часы).`);
      lines.push(`${fmtNum(degreeHours)} × ${fmtPercent(t.rate_percent_per_degree_hour)} = ${fmtPercent(percent)} от платы за отопление.`);
    }
    months.push({ month, percent, lines, totalHours: round2(m.hoursBelow) });
  }
  const notes = [
    'Снижение считается за каждый час и за каждый градус отклонения (п. 15 Приложения № 1).',
    'Для районов с температурой холодной пятидневки −31 °C и ниже норма выше; бот пока считает по общей норме.',
  ];
  return { serviceKey: norm.key, kind: 'heating_temperature', basis: norm.item, months, notes };
}

export function calcHotWaterTemperature(norm: ServiceNorm, readings: Reading[], end: Date, tz: string): CalcResult {
  const t = norm.temperature as HotWaterTempNorm;
  const byMonth = new Map<string, { stepHours: number; coldHours: number; hoursBelow: number }>();
  for (const seg of segments(readings, end)) {
    walkLocalHours(seg.start, seg.end, tz, (_from, hours, hour, month) => {
      const tol = isNight(hour, t.night_from_hour, t.night_to_hour) ? t.night_tolerance_c : t.day_tolerance_c;
      const required = t.norm_c - tol;
      const cur = byMonth.get(month) ?? { stepHours: 0, coldHours: 0, hoursBelow: 0 };
      if (seg.tempC < t.cold_tariff_below_c) {
        cur.coldHours += hours;
        cur.hoursBelow += hours;
      } else if (seg.tempC < required) {
        const steps = Math.floor((required - seg.tempC) / t.step_c + EPS);
        cur.stepHours += steps * hours;
        cur.hoursBelow += hours;
      }
      byMonth.set(month, cur);
    });
  }

  const months: MonthCalc[] = [];
  for (const [month, m] of [...byMonth.entries()].sort()) {
    const stepHours = Math.floor(m.stepHours * 100 + EPS) / 100;
    const percent = Math.min(100, round2(stepHours * t.rate_percent_per_step_hour));
    const lines: string[] = [];
    lines.push(
      `Норма: не ниже +${t.norm_c} °C, допустимо отклонение днём до ${t.day_tolerance_c} °C, ночью до ${t.night_tolerance_c} °C.`,
    );
    if (stepHours > 0) {
      lines.push(`За каждые ${t.step_c} °C сверх допуска — ${fmtPercent(t.rate_percent_per_step_hour)} за каждый час.`);
      lines.push(`${fmtNum(stepHours)} × ${fmtPercent(t.rate_percent_per_step_hour)} = ${fmtPercent(percent)} от платы за горячую воду.`);
    }
    if (m.coldHours > 0) {
      lines.push(
        `${formatDuration(m.coldHours)} вода была ниже +${t.cold_tariff_below_c} °C: за это время горячая вода оплачивается по тарифу холодной. Эту разницу считает исполнитель по своим тарифам.`,
      );
    }
    if (stepHours <= 0 && m.coldHours <= 0) lines.push('Отклонение в пределах допуска — снижение платы не положено.');
    months.push({ month, percent, lines, coldTariffHours: round2(m.coldHours), totalHours: round2(m.hoursBelow) });
  }
  return {
    serviceKey: norm.key,
    kind: 'hot_water_temperature',
    basis: norm.item,
    months,
    notes: ['Неполные шаги в 3 °C не засчитываются — это оценка снизу.'],
  };
}

export function calculate(norm: ServiceNorm, input: CalcInput, tz: string): CalcResult {
  switch (input.kind) {
    case 'interruption':
      return calcInterruption(norm, input.intervals, tz, input.variant);
    case 'heating_temperature':
      return calcHeatingTemperature(norm, input.readings, input.end, tz, { corner: input.corner, coldRegion: input.coldRegion });
    case 'hot_water_temperature':
      return calcHotWaterTemperature(norm, input.readings, input.end, tz);
  }
}

/** Сумма к снижению: плата × процент, с округлением вниз до копейки. */
export function refundAmount(bill: number, percent: number): number {
  const p = Math.min(100, Math.max(0, percent));
  return Math.floor(Math.round(bill * 100) * p / 100 + EPS) / 100;
}

export function amountLine(bill: number, percent: number): string {
  return `${fmtPercent(percent)} от ${fmtRub(bill)} ≈ ${fmtRub(refundAmount(bill, percent))}`;
}
