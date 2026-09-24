// Заявление на перерасчёт. Одна структура — два представления: текст для чата и PDF.
// Разделяем факт (время, номер АДС), расчёт (формула, пункт) и требование.
// Реквизиты — по образцу Минстроя (прил. 3.4 к Методическим рекомендациям, приказ от 23.06.2014 № 1411/пр):
// «Руководителю …», заявитель с адресом и контактами, приложения, подпись, отметка о принятии.

import type { CalcResult } from '../calc/engine.ts';
import { coldTariffAmount, refundAmount } from '../calc/engine.ts';
import type { Norms, ServiceNorm } from '../calc/norms.ts';
import { allowedMonthlyHours } from '../calc/norms.ts';
import { fmtNum, fmtPercent, fmtRub, fmtTemp } from '../calc/format.ts';
import { formatDate, formatDateTime, formatDuration, hoursBetween, monthPrepositional, monthTitle } from '../calc/time.ts';
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

/** Адрес дома для документа: «г. Кинешма, Ленина 5». */
export function docAddress(house: House): string {
  if (!house.city) return house.address;
  const street = house.address.startsWith(`${house.city}, `) ? house.address.slice(house.city.length + 2) : house.address;
  return `г. ${house.city}, ${street}`;
}

/** Имя файла по делу: чтобы заявления по разным отключениям не превращались в «(1)», «(2)». */
export function docFileName(kind: string, serviceButton: string, date: Date, tz: string): string {
  const what = serviceButton.toLowerCase().replace(/[^а-яёa-z0-9]+/gi, '_').replace(/^_|_$/g, '');
  return `${kind}_${what}_${formatDate(date, tz)}.pdf`;
}

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
      `Нарушение подтверждено актом от ${formatDate(new Date(act.act.created_at), house.tz)}, составленным и подписанным потребителями${chair ? ' и председателем совета многоквартирного дома' : ''} без участия исполнителя (п. 110(1) Правил).`,
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

/**
 * Как нарушение зафиксировано — по п. 105–106 Правил: куда сообщили, номер и время регистрации,
 * кто принял сообщение. Время регистрации пишем, только если оно известно: для номера первого жителя
 * это начало отключения (п. 111 Правил). Время звонка соседа не спрашивали — не выдумываем.
 */
export function adsFacts(input: Pick<ClaimInput, 'incident' | 'house' | 'participant' | 'claim' | 'act'>, serviceName: string): string[] {
  const { incident, house, participant: p, claim } = input;
  const regTime = formatDateTime(new Date(incident.started_at), house.tz);
  const adsNumber = p.own_ads_number || incident.ads_number;
  // Сосед мог дозвониться сам, даже если первый житель сообщил без номера.
  const evidence = p.own_ads_number && incident.evidence === 'self' ? (p.own_evidence ?? 'ads') : incident.evidence;
  const waste = incident.service_key === 'waste_off';
  const ads = waste ? 'диспетчерскую службу регионального оператора' : 'аварийно-диспетчерскую службу исполнителя';
  const what = `о нарушении предоставления коммунальной услуги «${serviceName}»`;
  const operator = claim.adsOperator?.trim();
  const accepted = operator ? `, сообщение принял(а) ${operator}` : '';
  // Первый житель позвонил ещё раз и получил новый номер — пишем оба, первый не теряем.
  const repeat = p.role === 'reporter' && p.own_ads_number && incident.ads_number && p.own_ads_number !== incident.ads_number;
  if (repeat) {
    return [
      `Я сообщил(а) ${what} в ${ads} (п. 105 Правил). Сообщение зарегистрировано под № ${incident.ads_number}, время регистрации — ${regTime}${accepted}; повторное сообщение зарегистрировано под № ${p.own_ads_number} (п. 106 Правил). С момента первого сообщения исчисляется период нарушения (п. 111 Правил).`,
    ];
  }
  if (evidence === 'ads' && adsNumber && p.own_ads_number) {
    return [`Я сообщил(а) ${what} в ${ads}; сообщение зарегистрировано под № ${adsNumber}${accepted} (п. 105–106 Правил).`];
  }
  if (evidence === 'ads' && adsNumber && p.role === 'neighbour') {
    return [`О том же нарушении в ${ads} сообщил другой житель дома: сообщение зарегистрировано под № ${adsNumber}, время регистрации — ${regTime} (п. 105–106 Правил).`];
  }
  if (evidence === 'ads' && adsNumber) {
    return [
      `Я сообщил(а) ${what} в ${ads} (п. 105 Правил). Сообщение зарегистрировано под № ${adsNumber}, время регистрации — ${regTime}${accepted} (п. 106 Правил). С этого времени исчисляется период нарушения (п. 111 Правил).`,
    ];
  }
  if (evidence === 'written' && adsNumber) {
    return [`О нарушении исполнителю сообщено письменно: обращение № ${adsNumber}${p.own_ads_number ? '' : ` от ${regTime}`} (п. 105 Правил).`];
  }
  // Не дозвонились. Для УК — напоминаем о её обязанности отвечать на звонки (п. 13 Правил № 416):
  // отсутствие номера — не вина жителя.
  const toUk = !waste && (claim.executorType === 'uk' || !claim.executorType);
  const failed = `Дозвониться в ${ads} не удалось${toUk ? ', хотя она обязана ответить на звонок не позднее чем через 5 минут (п. 13 Правил осуществления деятельности по управлению многоквартирными домами, утв. ПП РФ от 15.05.2013 № 416)' : ''}.`;
  if (input.act?.act.status === 'signed') return [`${failed} Время начала нарушения указано в акте.`];
  return [`${failed} Время начала и окончания нарушения указаны потребителем.`];
}

export function buildClaim(input: ClaimInput): ClaimDoc {
  const { norms, incident, house, participant: p, readings, calc, bills, claim, now } = input;
  const norm = norms.services[incident.service_key];
  const serviceName = norm.title.replace(/\s*\(.*\)$/, '');
  const tz = house.tz;
  const start = new Date(p.started_at);
  const end = p.ended_at ? new Date(p.ended_at) : now;
  const fio = claim.fio?.trim() || BLANK;
  // Дата документа — когда житель его впервые получил, а не каждый раз «сегодня».
  const issued = claim.createdAt ? new Date(claim.createdAt) : now;

  // «Заявитель: ФИО» — без склонения фамилии, которое легко сделать с ошибкой.
  const from = [
    `Заявитель: ${fio}`,
    `адрес: ${docAddress(house)}, кв. ${claim.flat?.trim() || '______'}`,
    // В Москве и области лицевой счёт в ЕПД называется «код плательщика».
    `л/с (код плательщика): ${claim.account?.trim() || '______________'}`,
    `телефон, e-mail: ${BLANK}`,
  ];

  const facts: string[] = [];
  if (calc.kind === 'interruption') {
    facts.push(
      `С ${formatDateTime(start, tz)} по ${formatDateTime(end, tz)} (${formatDuration(hoursBetween(start, end))}) коммунальная услуга «${serviceName}» не предоставлялась (перерыв в предоставлении).`,
    );
  } else if (calc.kind === 'heating_temperature') {
    const t = norm.temperature as { norm_c: number; corner_norm_c: number };
    const normC = p.corner ? t.corner_norm_c : t.norm_c;
    facts.push(
      `С ${formatDateTime(start, tz)} по ${formatDateTime(end, tz)} температура воздуха в жилом помещении${p.corner ? ' (угловая комната)' : ''} была ниже нормативной. Результаты измерений:`,
    );
    for (const r of readings) facts.push(`— ${formatDateTime(new Date(r.at), tz)}: ${fmtTemp(r.temp_c)}${r.temp_c >= normC ? ' (в пределах нормы)' : ''}`);
  } else {
    const t = norm.temperature as { norm_c: number; day_tolerance_c: number };
    facts.push(
      `С ${formatDateTime(start, tz)} по ${formatDateTime(end, tz)} температура горячей воды в точке водоразбора отклонялась от нормативной. Результаты измерений:`,
    );
    // Замер в норме тоже пишем — честно помечаем, что в этот момент вода была нормальной.
    for (const r of readings) facts.push(`— ${formatDateTime(new Date(r.at), tz)}: ${fmtTemp(r.temp_c)}${r.temp_c >= t.norm_c - t.day_tolerance_c ? ' (в пределах нормы)' : ''}`);
  }

  facts.push(...adsFacts(input, serviceName));
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
    if (m.coldTariffHours && m.coldTariffHours >= 1) {
      const ct = claim.coldTariff?.[m.month];
      const cold = coldTariffAmount(m.month, m.coldTariffHours, ct);
      if (ct && cold > 0) {
        total += cold;
        calcLines.push(
          `  Горячая вода ниже +40 °C: ${formatDuration(m.coldTariffHours)}. ${fmtNum(ct.volume)} м³ × доля этих часов в месяце × (${fmtRub(ct.hot)} − ${fmtRub(ct.cold)}) за м³ ≈ ${fmtRub(cold)} (при равномерном расходе).`,
        );
      }
      requests.push(
        `за ${formatDuration(m.coldTariffHours)} ${monthPrepositional(m.month)}, когда температура горячей воды была ниже +40 °C, произвести оплату горячей воды по тарифу за холодную воду${cold > 0 ? ` (ориентировочно ${fmtRub(cold)})` : ''};`,
      );
    }
  }
  // Несколько месяцев — итог одной строкой, чтобы УК не складывала сама.
  if (calc.months.filter((m) => m.percent > 0 && bills[m.month]).length > 1) calcLines.push(`Итого ориентировочно: ${fmtRub(Math.round(total * 100) / 100)}.`);
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
    signature: `Дата: ${formatDate(issued, tz)}        Подпись: __________ / ${claim.fio?.trim() || BLANK}`,
    total: Math.round(total * 100) / 100,
    attachments: extras.attachments.length ? extras.attachments : undefined,
    receipt: RECEIPT_BLOCK,
    fileName: docFileName('Заявление', norm.button, issued, tz),
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
