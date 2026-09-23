/** 9.6 → «9,6»; 1280.5 → «1 280,5». Незначащие нули убираются. */
export function fmtNum(n: number, maxDigits = 2): string {
  const s = n.toLocaleString('ru-RU', { maximumFractionDigits: maxDigits, minimumFractionDigits: 0 });
  return s.replace(/\u00a0/g, ' ').replace(/\u202f/g, ' ');
}

/** Рубли с копейками: 115.2 → «115,20 ₽», 1280 → «1 280 ₽». */
export function fmtRub(n: number): string {
  const whole = Number.isInteger(n);
  const s = n.toLocaleString('ru-RU', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${s.replace(/\u00a0/g, ' ').replace(/\u202f/g, ' ')} ₽`;
}

export function fmtPercent(p: number): string {
  return `${fmtNum(p, 2)}%`;
}

/** Разбирает сумму, которую ввёл житель: «1 200», «1200,50», «1200.5 руб». */
export function parseRubles(text: string): number | null {
  const cleaned = text
    .toLowerCase()
    .replace(/руб\.?|р\.?|₽/g, '')
    .replace(/[\s\u00a0]/g, '')
    .replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return null;
  return n;
}

/** Разбирает температуру: «15», «+15,5», «15°». */
export function parseTemperature(text: string): number | null {
  const cleaned = text.replace(/[°сc\s+]/gi, '').replace(',', '.');
  if (!/^-?\d{1,2}(\.\d)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (n < -30 || n > 99) return null;
  return n;
}

/** Склонение: plural(5, ['сосед', 'соседа', 'соседей']) → «соседей» */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
