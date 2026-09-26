// Акт о нарушении качества коммунальной услуги, составленный потребителями без исполнителя
// (п. 110(1) ПП РФ № 354): подписывают не менее 2 потребителей и председатель совета МКД.
// Бот собирает подтверждения и готовит документ, но подтверждение в боте — не подпись:
// акт получает силу после собственноручной подписи всех, кто в нём указан.

import type { Norms } from '../calc/norms.ts';
import { fmtTemp } from '../calc/format.ts';
import { formatDateTime } from '../calc/time.ts';
import type { Act, ActSigner, House, Incident, Reading } from '../db/db.ts';
import type { ClaimDoc } from './claim.ts';
import { docAddress, docFileName } from './claim.ts';

export type ActDocInput = {
  norms: Norms;
  incident: Incident;
  house: House;
  act: Act;
  signers: ActSigner[];
  /** Измерения температуры жителей, подтвердивших акт: квартира → показания. */
  readings: { flat: string | null; readings: Reading[] }[];
  now: Date;
};

/** Сколько строк для подписей жителей в акте (заполненных и пустых). */
const BLANK_RESIDENT_LINES = 4;

export const ACT_REASON: Record<Act['reason'], string> = {
  no_ads: 'Уведомить аварийно-диспетчерскую службу исполнителя не удалось.',
  no_inspection: 'Исполнитель уведомлён о нарушении, но проверку в установленный срок — не позднее 2 часов с момента сообщения (п. 108 Правил) — не провёл.',
};

export function buildActDoc(input: ActDocInput): ClaimDoc {
  const { norms, incident, house, act, signers, readings } = input;
  const norm = norms.services[incident.service_key];
  const tz = house.tz;
  const serviceName = norm.title.replace(/\s*\(.*\)$/, '');
  const start = new Date(incident.started_at);
  // Скачанная позже копия должна совпадать с подписанной бумагой: окончание пишем, только если оно было известно при составлении.
  const endedAtAct = incident.ended_at && new Date(incident.ended_at).getTime() <= new Date(act.created_at).getTime() ? new Date(incident.ended_at) : null;
  const what = norm.kind === 'interruption' ? 'коммунальная услуга не предоставляется' : `${norm.kind === 'heating_temperature' ? 'температура воздуха в жилых помещениях' : 'температура горячей воды'} ниже нормативной`;

  const facts = [
    `Адрес: ${docAddress(house)}${incident.entrance ? `, подъезд ${incident.entrance}` : ''}.`,
    `Коммунальная услуга: «${serviceName}».`,
    `Нарушение: ${what} с ${formatDateTime(start, tz)}${endedAtAct ? ` по ${formatDateTime(endedAtAct, tz)}` : ' — на момент составления акта не устранено'}.`,
  ];
  const measured = readings.filter((r) => r.readings.length);
  if (measured.length) {
    facts.push('Результаты измерений:');
    for (const r of measured) {
      for (const x of r.readings) facts.push(`— кв. ${r.flat ?? '___'}, ${formatDateTime(new Date(x.at), tz)}: ${fmtTemp(x.temp_c)}`);
    }
  }
  // Мосжилинспекция: в акте должны быть способ и средства измерения, иначе исполнитель оспорит цифры.
  if (norm.kind !== 'interruption') {
    facts.push(
      norm.kind === 'heating_temperature'
        ? 'Способ измерения: в жилой комнате, в центре помещения, на высоте около 1 м от пола, вдали от окон и отопительных приборов.'
        : 'Способ измерения: в точке водоразбора (кран) после слива воды.',
    );
    facts.push('Средство измерения (термометр, модель): ______________________');
  }
  if (incident.ads_number) facts.push(`Сообщение о нарушении исполнителю: № ${incident.ads_number} от ${formatDateTime(start, tz)}.`);
  facts.push(ACT_REASON[act.reason]);

  const signLines = signers.map(
    (s, i) => `${i + 1}. ${s.fio}${s.flat ? `, кв. ${s.flat}` : ''} — ${s.role === 'chair' ? 'председатель совета многоквартирного дома' : 'потребитель'}.  Подпись: ____________`,
  );
  // Пустые строки — для соседей, которых нет в боте: акт распечатывают и подписывают на бумаге.
  const residents = signers.filter((s) => s.role !== 'chair').length;
  for (let i = residents; i < BLANK_RESIDENT_LINES; i++) {
    signLines.push(`${signLines.length + 1}. ______________________________, кв. ______ — потребитель.  Подпись: ____________`);
  }
  // Подпись председателя совета МКД (или правления ТСЖ/ЖСК) обязательна по п. 110(1) — ставится на бумаге.
  if (!signers.some((s) => s.role === 'chair')) {
    signLines.push('Председатель совета многоквартирного дома (правления ТСЖ/ЖСК): ______________________ / ____________');
  }

  return {
    to: [],
    from: [],
    heading: 'АКТ',
    title: 'Акт о нарушении качества (непредоставлении) коммунальной услуги, составленный потребителями в отсутствие исполнителя',
    facts,
    norm: [
      'Акт составлен на основании п. 110(1) Правил предоставления коммунальных услуг (утв. ПП РФ от 06.05.2011 № 354). Дата и время начала нарушения определяются по настоящему акту (п. 111 Правил).',
    ],
    calcTitle: 'Подписи',
    calcGap: 12,
    calc: signLines,
    requests: [],
    note:
      'Акт имеет силу после собственноручных подписей. Копию акта каждый подписавший прикладывает к своему заявлению о перерасчёте; один экземпляр передаётся исполнителю.',
    // Дата составления — когда акт создали: копия, скачанная позже, совпадает с подписанной бумагой.
    signature: `Дата и время составления: ${formatDateTime(new Date(act.created_at), tz)}`,
    total: 0,
    fileName: docFileName('Акт', norm.button, new Date(act.created_at), tz),
  };
}
