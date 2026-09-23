// Платёжный QR-код по ГОСТ Р 56042-2014: «ST00012|Name=…|PayeeINN=…|PersAcc=…|Sum=…».
// Из него берём получателя платежа (это исполнитель), ИНН, лицевой счёт и сумму.
// Сумма по отдельной услуге в QR обычно не передаётся — её житель вводит сам.

export type ReceiptInfo = {
  executor?: string;
  executorInn?: string;
  account?: string;
  totalSum?: number;
  payerAddress?: string;
  period?: string;
  fields: Record<string, string>;
};

export type ParseResult = { ok: true; info: ReceiptInfo } | { ok: false; error: string };

export function parseReceiptQr(raw: string): ParseResult {
  const text = (raw ?? '').trim();
  const header = text.match(/^ST(\d{4})([123])(.)/);
  if (!header) {
    return { ok: false, error: 'Это не платёжный QR-код квитанции. Отсканируйте QR с квитанции ЖКХ.' };
  }
  const sep = header[3];
  const body = text.slice(header[0].length);
  const fields: Record<string, string> = {};
  for (const part of body.split(sep)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (value && !(key in fields)) fields[key] = value;
  }
  if (!fields.name && !fields.payeeinn) {
    return { ok: false, error: 'В QR-коде нет получателя платежа. Введите данные вручную.' };
  }
  const info: ReceiptInfo = { fields };
  if (fields.name) info.executor = fields.name.replace(/\s+/g, ' ');
  if (fields.payeeinn && /^\d{10}(\d{2})?$/.test(fields.payeeinn)) info.executorInn = fields.payeeinn;
  if (fields.persacc) info.account = fields.persacc;
  if (fields.sum && /^\d+$/.test(fields.sum)) info.totalSum = Number(fields.sum) / 100;
  if (fields.payeraddress) info.payerAddress = fields.payeraddress;
  if (fields.paymperiod) info.period = fields.paymperiod;
  return { ok: true, info };
}
