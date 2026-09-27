import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNorms } from '../src/calc/norms.ts';
import { calculate, mergeIntervals, refundAmount } from '../src/calc/engine.ts';
import { formatDuration, fromLocal } from '../src/calc/time.ts';

const norms = parseNorms(readFileSync(new URL('../norms/norms.yaml', import.meta.url), 'utf8'));
const TZ = 'Europe/Moscow';
const at = (d: number, m: number, h: number, min = 0, y = 2026) => fromLocal(y, m, d, h, min, TZ);

test('горячая вода: 72 ч без воды → 64 ч превышения → 9,6% → 115,20 ₽ от 1 200 ₽', () => {
  const r = calculate(
    norms.services.hot_water_off,
    { kind: 'interruption', intervals: [{ start: at(22, 9, 8, 10), end: at(25, 9, 8, 10) }] },
    TZ,
  );
  assert.equal(r.months.length, 1);
  assert.equal(r.months[0].month, '2026-09');
  assert.equal(r.months[0].percent, 9.6);
  assert.equal(r.months[0].excessHours, 64);
  assert.equal(r.months[0].singleLimitExceeded, true);
  assert.equal(refundAmount(1200, r.months[0].percent), 115.2);
});

test('перерыв в пределах лимита — снижения нет', () => {
  const r = calculate(
    norms.services.cold_water_off,
    { kind: 'interruption', intervals: [{ start: at(10, 9, 9), end: at(10, 9, 12) }] },
    TZ,
  );
  assert.equal(r.months[0].percent, 0);
  assert.equal(r.months[0].singleLimitExceeded, false);
});

test('неполный час превышения не засчитывается (оценка снизу)', () => {
  const r = calculate(
    norms.services.cold_water_off,
    { kind: 'interruption', intervals: [{ start: at(10, 9, 9), end: at(10, 9, 17, 50) }] },
    TZ,
  );
  assert.equal(r.months[0].percent, 0);
  const r2 = calculate(
    norms.services.cold_water_off,
    { kind: 'interruption', intervals: [{ start: at(10, 9, 9), end: at(10, 9, 18, 0) }] },
    TZ,
  );
  assert.equal(r2.months[0].percent, 0.15);
});

test('несколько перерывов за месяц суммируются, пересечения не удваиваются', () => {
  const r = calculate(
    norms.services.hot_water_off,
    {
      kind: 'interruption',
      intervals: [
        { start: at(1, 9, 8), end: at(1, 9, 14) }, // 6 ч
        { start: at(1, 9, 12), end: at(1, 9, 16) }, // пересекается: итого 8 ч
        { start: at(15, 9, 10), end: at(15, 9, 15) }, // 5 ч
      ],
    },
    TZ,
  );
  assert.equal(r.months[0].totalHours, 13);
  assert.equal(r.months[0].percent, 0.75); // 5 ч × 0,15%
  assert.equal(mergeIntervals([{ start: at(1, 9, 8), end: at(1, 9, 14) }, { start: at(1, 9, 12), end: at(1, 9, 16) }]).length, 1);
});

test('отключение через границу месяца делится по расчётным периодам', () => {
  const r = calculate(
    norms.services.hot_water_off,
    { kind: 'interruption', intervals: [{ start: at(30, 9, 0), end: at(2, 10, 0) }] },
    TZ,
  );
  assert.deepEqual(r.months.map((m) => m.month), ['2026-09', '2026-10']);
  assert.equal(r.months[0].totalHours, 24);
  assert.equal(r.months[0].percent, 2.4); // 16 ч × 0,15%
  assert.equal(r.months[1].totalHours, 24);
  assert.equal(r.months[1].percent, 2.4);
});

test('электричество: вариант с двумя источниками даёт больше, чем строгая норма', () => {
  const iv = [{ start: at(5, 9, 10), end: at(5, 9, 20) }]; // 10 ч
  const strict = calculate(norms.services.electricity_off, { kind: 'interruption', intervals: iv }, TZ);
  const two = calculate(norms.services.electricity_off, { kind: 'interruption', intervals: iv, variant: 'two_sources' }, TZ);
  assert.equal(strict.months[0].percent, 0);
  assert.equal(two.months[0].percent, 1.2); // 8 ч × 0,15%
});

test('мусор: 3,3% за каждые полные 24 ч сверх 72 ч в месяц', () => {
  const r = calculate(
    norms.services.waste_off,
    { kind: 'interruption', intervals: [{ start: at(1, 9, 0), end: at(6, 9, 12) }] }, // 132 ч
    TZ,
  );
  assert.equal(r.months[0].excessHours, 60);
  assert.equal(r.months[0].percent, 6.6); // 2 полных периода
});

test('отопление: +15 °C пять суток → 95 ч × 3 °C × 0,15% = 42,75% ≈ 1 282,50 ₽ от 3 000 ₽', () => {
  const r = calculate(
    norms.services.heating_temp,
    { kind: 'heating_temperature', readings: [{ at: at(1, 10, 0), tempC: 15 }], end: at(6, 10, 0) },
    TZ,
  );
  assert.equal(r.months[0].percent, 42.75);
  assert.equal(refundAmount(3000, r.months[0].percent), 1282.5);
});

test('отопление: угловая комната — норма +20 °C', () => {
  const r = calculate(
    norms.services.heating_temp,
    { kind: 'heating_temperature', readings: [{ at: at(1, 10, 6), tempC: 19 }], end: at(1, 10, 16) },
    TZ,
  );
  assert.equal(r.months[0].percent, 0);
  const corner = calculate(
    norms.services.heating_temp,
    { kind: 'heating_temperature', readings: [{ at: at(1, 10, 6), tempC: 19 }], end: at(1, 10, 16), corner: true },
    TZ,
  );
  assert.equal(corner.months[0].percent, 1.5); // 10 ч × 1 °C × 0,15%
});

test('отопление: смена показаний учитывается кусочно', () => {
  const r = calculate(
    norms.services.heating_temp,
    {
      kind: 'heating_temperature',
      readings: [
        { at: at(2, 10, 10), tempC: 16 }, // 2 ч × 2 °C
        { at: at(2, 10, 12), tempC: 17 }, // 3 ч × 1 °C
        { at: at(2, 10, 15), tempC: 18 },
      ],
      end: at(2, 10, 18),
    },
    TZ,
  );
  assert.equal(r.months[0].percent, 1.05); // 7 × 0,15%
});

test('горячая вода +48 °C днём: (57 − 48) / 3 = 3 шага × 0,1% за час', () => {
  const r = calculate(
    norms.services.hot_water_temp,
    { kind: 'hot_water_temperature', readings: [{ at: at(3, 9, 10), tempC: 48 }], end: at(3, 9, 20) },
    TZ,
  );
  assert.equal(r.months[0].percent, 3); // 10 ч × 3 × 0,1%
});

test('горячая вода ниже +40 °C — часы по тарифу холодной, без процента', () => {
  const r = calculate(
    norms.services.hot_water_temp,
    { kind: 'hot_water_temperature', readings: [{ at: at(3, 9, 10), tempC: 35 }], end: at(3, 9, 14) },
    TZ,
  );
  assert.equal(r.months[0].percent, 0);
  assert.equal(r.months[0].coldTariffHours, 4);
});

test('процент не превышает 100', () => {
  const r = calculate(
    norms.services.heating_temp,
    { kind: 'heating_temperature', readings: [{ at: at(1, 10, 0), tempC: 5 }], end: at(31, 10, 23) },
    TZ,
  );
  assert.equal(r.months[0].percent, 100);
  assert.equal(refundAmount(2500, 100), 2500);
});

test('часовой пояс дома влияет на ночные часы', () => {
  // 00:00–05:00 по Новосибирску (UTC+7) — ночь, при +15 °C снижения нет.
  const nsk = 'Asia/Novosibirsk';
  const r = calculate(
    norms.services.heating_temp,
    { kind: 'heating_temperature', readings: [{ at: fromLocal(2026, 10, 1, 0, 0, nsk), tempC: 15 }], end: fromLocal(2026, 10, 1, 5, 0, nsk) },
    nsk,
  );
  assert.equal(r.months[0].percent, 0);
});

test('длительность словами: «сутки», а не «сут»', () => {
  assert.equal(formatDuration(24), '1 сутки');
  assert.equal(formatDuration(52), '2 суток 4 ч');
  assert.equal(formatDuration(5 * 24), '5 суток');
  assert.equal(formatDuration(21 * 24), '21 сутки');
  assert.equal(formatDuration(3.5), '3 ч 30 мин');
});
