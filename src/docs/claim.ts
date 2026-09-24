// Заявление на перерасчёт. Одна структура — два представления: текст для чата и PDF.
// Разделяем факт (время, номер АДС), расчёт (формула, пункт) и требование.
// Реквизиты — по образцу Минстроя (прил. 3.4 к Методическим рекомендациям, приказ от 23.06.2014 № 1411/пр):
// «Руководителю …», заявитель с адресом и контактами, приложения, подпись, отметка о принятии.

import type { CalcResult } from '../calc/engine.ts';
import { refundAmount } from '../calc/engine.ts';
import type { Norms, ServiceNorm } from '../calc/norms.ts';
import { allowedMonthlyHours } from '../calc/norms.ts';
import { fmtNum, fmtPercent, fmtRub } from '../calc/format.ts';
import { formatDate, formatDateTime, formatDuration, hoursBetween, monthTitle } from '../calc/time.ts';
import type { Act, ActSigner, Claim, House, Incident, Participant, Photo, Reading } from '../db/db.ts';

/**
 * Документ для жителя. Та же структура используется для заявления, акта, требования о штрафе
 * и жалобы: заголовок в PDF — heading, подзаголовок — title без первого слова.
 */
export type ClaimDoc = {
  to: string[];
  from: string[];
  title: string;
  facts: string[];
  norm: string[];
  calc: string[];
  requests: string[];
  note: string;
  signature: string;
  total: number;
  /** «ЗАЯВЛЕНИЕ» по умолчанию; первое слово title. */
  heading?: string;
  /** Заголовок блока calc, по умолчанию «Расчёт». */
  calcTitle?: string;
  /** Интервал между строками calc; в акте больше — там расписываются от руки. */
  calcGap?: number;
  /** Строка перед requests, по умолчанию «На основании п. 98 и 101 Правил прошу:». */
  requestsTitle?: string;
  attachments?: string[];
  /** Отметка о принятии — заполняет исполнитель на экземпляре заявителя. */
  receipt?: string[];
  /** Название файла и метаданных PDF. */
  fileName?: string;
};

export const DEFAULT_REQUESTS_TITLE = 'На основании п. 98 и 101 Правил прошу:';

const BLANK = '____________________';

const EXECUTOR_OF: Record<string, string> = {
  uk: 'управляющей организации (ТСЖ, ЖСК)',
  rso: 'ресурсоснабжающей организации',
  rop: 'регионального оператора по обращению с ТКО',
};

/** Исполнитель одной строкой для текста документа: название и ИНН или пропуск для заполнения. */
export function executorLine(claim: Claim): string {
  return claim.executor ? `${claim.executor}${claim.executorInn ? `, ИНН ${claim.executorInn}` : ''}` : BLANK;
}

export function claimTo(claim: Claim, norm: ServiceNorm): string[] {
  const lines: string[] = [];
  if (claim.executor) lines.push(`Руководителю ${claim.executor}`);
  else lines.push(`Руководителю ${EXECUTOR_OF[claim.executorType ?? ''] ?? `исполнителя услуги «${norm.title}»`} ${BLANK}`);
  if (claim.executorInn) lines.push(`ИНН ${claim.executorInn}`);
  // Реквизиты, которые обычно вписывают от руки: адрес получателя.
  lines.push(`адрес: ${BLANK}`);
  return lines;
}

/** Отметка о принятии: заявление подают в двух экземплярах, отметку ставят на экземпляре заявителя. */
export const RECEIPT_BLOCK = [
  'Отметка о принятии (на втором экземпляре, который остаётся у заявителя):',
  `Заявление принял: ${BLANK} (должность, ФИО)    Подпись: __________`,
  'Дата: «___» ____________ 20___ г.    Вх. № __________',
];

export type ClaimInput = {
  norms: Norms;
  incident: Incident;
  house: House;
  participant: Participant;
  readings: Reading[];
  calc: CalcResult;
  bills: Record<string, number>;
  claim: Claim;
  now: Date;
  photos?: Photo[];
  act?: { act: Act; signers: ActSigner[] } | null;
};

/** Строки о подписанном акте и проверке исполнителя — общие для заявления, требования и жалобы. */
export function evidenceExtras(input: Pick<ClaimInput, 'participant' | 'act' | 'photos' | 'house'>): { facts: string[]; attachments: string[] } {
  const { participant: p, act, photos, house } = input;
  const facts: string[] = [];
  const attachments: string[] = [];
  if (p.inspection === 'executor_act') {
    facts.push('Исполнитель провёл проверку и составил акт о нарушении качества (п. 109 Правил).');
    attachments.push('Копия акта проверки, составленного исполнителем.');
  } else if (p.inspection === 'no_show') {
    facts.push('Проверку качества исполнитель в установленный срок — не позднее 2 часов с момента сообщения (п. 108 Правил) — не провёл.');
  }
  if (act && act.act.status === 'signed') {
    // Число подписей не пишем: соседи могли расписаться на бумаге, не заходя в бот.
    const chair = act.act.chair_signed === 1 || act.signers.some((s) => s.role === 'chair');
    facts.push(
      `Нарушение подтверждено актом, составленным потребителями без участия исполнителя (п. 110(1) Правил), от ${formatDate(new Date(act.act.signed_at ?? act.act.created_at), house.tz)}: подписан потребителями${chair ? ' и председателем совета многоквартирного дома' : ''}.`,
    );
    attachments.push('Копия акта о нарушении качества коммунальной услуги (п. 110(1) Правил).');
  }
  if (photos?.length) {
    const shown = photos.slice(0, 6).map((ph) => formatDateTime(new Date(ph.received_at), house.tz));
    attachments.push(
      `Фотографии (${photos.length} шт.). Время получения сервисом «Вернём»: ${shown.join('; ')}${photos.length > shown.length ? ' и др.' : ''}.`,
    );
  }
  return { facts, attachments };
}

export function buildClaim(input: ClaimInput): ClaimDoc {
  const { norms, incident, house, participant: p, readings, calc, bills, claim, now } = input;
  const norm = norms.services[incident.service_key];
  const serviceName = norm.title.replace(/\s*\(.*\)$/, '');
  const tz = house.tz;
  const start = new Date(p.started_at);
  const end = p.ended_at ? new Date(p.ended_at) : now;
  const fio = claim.fio?.trim() || BLANK;

  const from = [
    `от ${fio}`,
    `адрес: ${house.address}, кв. ${claim.flat?.trim() || '______'}`,
    // В Москве и области лицевой счёт в ЕПД называется «код плательщика».
    `лицевой счёт (код плательщика): ${claim.account?.trim() || BLANK}`,
    `телефон, e-mail для связи: ${BLANK}`,
  ];

  const facts: string[] = [];
  if (calc.kind === 'interruption') {
    facts.push(
      `С ${formatDateTime(start, tz)} по ${formatDateTime(end, tz)} (${formatDuration(hoursBetween(start, end))}) коммунальная услуга «${serviceName}» не предоставлялась (перерыв в предоставлении).`,
    );
  } else if (calc.kind === 'heating_temperature') {
    facts.push(
      `С ${formatDateTime(start, tz)} по ${formatDateTime(end, tz)} температура воздуха в жилом помещении${p.corner ? ' (угловая комната)' : ''} была ниже нормативной. Результаты измерений:`,
    );
    for (const r of readings) facts.push(`— ${formatDateTime(new Date(r.at), tz)}: +${fmtNum(r.temp_c, 1)} °C`);
  } else {
    facts.push(
      `С ${formatDateTime(start, tz)} по ${formatDateTime(end, tz)} температура горячей воды в точке водоразбора была ниже нормативной. Результаты измерений:`,
    );
    for (const r of readings) facts.push(`— ${formatDateTime(new Date(r.at), tz)}: +${fmtNum(r.temp_c, 1)} °C`);
  }

  const adsNumber = p.own_ads_number || incident.ads_number;
  // Сосед мог дозвониться сам, даже если первый житель сообщил без номера.
  const evidence = p.own_ads_number && incident.evidence === 'self' ? 'ads' : incident.evidence;
  if (evidence === 'ads' && adsNumber) {
    const whose = p.own_ads_number ? '' : p.role === 'neighbour' ? ' (сообщение другого жителя дома о том же нарушении)' : '';
    facts.push(
      `Нарушение зафиксировано: сообщение в аварийно-диспетчерскую службу зарегистрировано под № ${adsNumber} ${formatDateTime(new Date(incident.started_at), tz)}${whose} (п. 105–106 Правил).`,
    );
  } else if (evidence === 'written' && adsNumber) {
    facts.push(`О нарушении исполнителю сообщено письменно: обращение № ${adsNumber} от ${formatDateTime(new Date(incident.started_at), tz)} (п. 105 Правил).`);
  } else if (input.act?.act.status === 'signed') {
    facts.push('Сообщить о нарушении в аварийно-диспетчерскую службу не удалось. Время начала нарушения указано в акте (п. 111 Правил).');
  } else {
    facts.push(
      'Сообщить о нарушении в аварийно-диспетчерскую службу не удалось. Время начала и окончания нарушения указаны потребителем (п. 111–113 Правил); акт о нарушении прилагается при наличии.',
    );
  }
  const extras = evidenceExtras(input);
  facts.push(...extras.facts);

  const normLines: string[] = [];
  if (calc.kind === 'interruption' && norm.interruption) {
    const allowed = allowedMonthlyHours(norm.interruption, incident.variant);
    const unit = norm.interruption.unit_hours === 1 ? 'каждый час' : `каждые ${norm.interruption.unit_hours} ч`;
    normLines.push(
      `Согласно ${norm.item} к Правилам предоставления коммунальных услуг (утв. ПП РФ от 06.05.2011 № 354) допустимая продолжительность перерыва составляет ${fmtNum(allowed)} ч суммарно в течение месяца; за ${unit} превышения размер платы за месяц снижается на ${fmtPercent(norm.interruption.rate_percent)}.`,
    );
  } else {
    normLines.push(
      `Согласно ${norm.item} к Правилам предоставления коммунальных услуг (утв. ПП РФ от 06.05.2011 № 354) при отклонении температуры от нормативной размер платы за услугу снижается за каждый час отклонения.`,
    );
  }

  const calcLines: string[] = [];
  const requests: string[] = [];
  let total = 0;
  for (const m of calc.months) {
    calcLines.push(`${monthTitle(m.month)}:`);
    for (const l of m.lines) calcLines.push(`  ${l}`);
    const bill = bills[m.month];
    if (m.percent > 0) {
      const sum = bill ? refundAmount(bill, m.percent) : 0;
      total += sum;
      if (bill) calcLines.push(`  Плата за месяц ${fmtRub(bill)} × ${fmtPercent(m.percent)} ≈ ${fmtRub(sum)}.`);
      requests.push(
        `произвести перерасчёт (снизить размер платы) за коммунальную услугу «${serviceName}» за ${monthTitle(m.month)} на ${fmtPercent(m.percent)}${bill ? ` (ориентировочно ${fmtRub(sum)})` : ''};`,
      );
    }
    if (m.coldTariffHours && m.coldTariffHours > 0) {
      requests.push(
        `за ${formatDuration(m.coldTariffHours)} в ${monthTitle(m.month)}, когда температура горячей воды была ниже +40 °C, произвести оплату горячей воды по тарифу за холодную воду;`,
      );
    }
  }
  requests.push('отразить перерасчёт в платёжном документе за ближайший расчётный период;');
  requests.push('дать письменный ответ на настоящее заявление по указанному адресу.');

  return {
    to: claimTo(claim, norm),
    from,
    title: 'Заявление о перерасчёте размера платы за коммунальную услугу при предоставлении коммунальной услуги ненадлежащего качества и (или) с перерывами, превышающими установленную продолжительность',
    facts,
    norm: normLines,
    calc: calcLines,
    requests: requests.map((r, i) => `${i + 1}. ${r[0].toUpperCase()}${r.slice(1)}`),
    note: `Расчёт ориентировочный и выполнен по данным потребителя; итоговый размер снижения платы определяет исполнитель (${norms.source.recalculation_items}). Нормы: ${norms.source.title}, ${norms.source.edition}.`,
    signature: `Дата: ${formatDate(now, tz)}        Подпись: __________ / ${claim.fio?.trim() || BLANK}`,
    total: Math.round(total * 100) / 100,
    attachments: extras.attachments.length ? extras.attachments : undefined,
    receipt: RECEIPT_BLOCK,
    fileName: 'Заявление_на_перерасчёт.pdf',
  };
}

export function claimToText(doc: ClaimDoc): string {
  const block = (lines: string[]) => (lines.length ? [...lines, ''] : []);
  return [
    ...doc.to,
    ...doc.from,
    ...(doc.to.length || doc.from.length ? [''] : []),
    doc.title.toUpperCase(),
    '',
    ...block(doc.facts),
    ...block(doc.norm),
    ...(doc.calc.length ? [`${doc.calcTitle ?? 'Расчёт'}:`, ...doc.calc, ''] : []),
    ...(doc.requests.length ? [doc.requestsTitle ?? DEFAULT_REQUESTS_TITLE, ...doc.requests, ''] : []),
    ...(doc.attachments?.length ? ['Приложения:', ...doc.attachments.map((a, i) => `${i + 1}. ${a}`), ''] : []),
    doc.note,
    '',
    doc.signature,
    ...(doc.receipt?.length ? ['', ...doc.receipt] : []),
  ].join('\n');
}
