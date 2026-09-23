// Документы на случай, если исполнитель не сделал перерасчёт:
// 1) требование о перерасчёте и штрафе 50% (ч. 6 ст. 157 ЖК РФ, п. 155(1) Правил);
// 2) жалоба в государственную жилищную инспекцию;
// 3) заявление в общественное объединение потребителей об обращении в суд (ст. 45–46 Закона «О защите прав потребителей»).
// Суммы — ориентировочные. Оговорки о трактовках (ч. 6 ст. 157 ЖК — позиция потребителя, ЗоЗПП и ТСЖ)
// бот говорит жителю в сообщении (bot/escalate.ts), а в документ для адресата не пишет.

import { refundAmount } from '../calc/engine.ts';
import { fmtRub } from '../calc/format.ts';
import { formatDate } from '../calc/time.ts';
import { buildClaim, evidenceExtras, executorLine } from './claim.ts';
import type { ClaimDoc, ClaimInput } from './claim.ts';

const BLANK = '____________________';

export type EscalationKind = 'fine' | 'gji' | 'ozpp';

export type EscalationOpts = {
  /** Сколько исполнитель уже вернул; null — перерасчёта нет. */
  refund: number | null;
  /** Подтверждённые нарушения того же исполнителя в других домах за 90 дней. */
  executorStats?: { houses: number; incidents: number };
  partnerName?: string | null;
};

/** Сколько положено вернуть по расчёту (только месяцы, где житель указал сумму из квитанции). */
export function expectedRefund(input: ClaimInput): number | null {
  let sum = 0;
  let known = false;
  for (const m of input.calc.months) {
    if (m.percent <= 0) continue;
    const bill = input.bills[m.month];
    if (!bill) continue;
    known = true;
    sum += refundAmount(bill, m.percent);
  }
  return known ? Math.round(sum * 100) / 100 : null;
}

function money(input: ClaimInput, opts: EscalationOpts) {
  const expected = expectedRefund(input);
  const refunded = opts.refund ?? 0;
  const excess = expected === null ? null : Math.max(0, Math.round((expected - refunded) * 100) / 100);
  const fine = excess === null ? null : Math.round(excess * 50) / 100;
  return { expected, refunded, excess, fine };
}

function common(input: ClaimInput, opts: EscalationOpts) {
  const base = buildClaim(input);
  const extras = evidenceExtras(input);
  const created = input.claim.createdAt ? formatDate(new Date(input.claim.createdAt), input.house.tz) : null;
  const m = money(input, opts);
  const outcome =
    opts.refund && opts.refund > 0
      ? `В платёжном документе перерасчёт отражён частично: ${fmtRub(opts.refund)}${m.expected !== null ? ` из положенных ≈ ${fmtRub(m.expected)}` : ''}.`
      : 'В платёжном документе за последующий расчётный период перерасчёт не отражён.';
  const facts = [
    ...base.facts,
    `Я обратился(ась) к исполнителю с заявлением о перерасчёте${created ? ` (подготовлено ${created})` : ''}. ${outcome}`,
  ];
  const attachments = [
    'Копия заявления о перерасчёте и подтверждение его направления исполнителю.',
    'Копия платёжного документа, в котором перерасчёт не отражён.',
    ...extras.attachments,
  ];
  return { base, facts, attachments, m };
}

export function buildFineDemand(input: ClaimInput, opts: EscalationOpts): ClaimDoc {
  const { base, facts, attachments, m } = common(input, opts);
  const norm = input.norms.services[input.incident.service_key];
  const serviceName = norm.title.replace(/\s*\(.*\)$/, '');
  const calc =
    m.excess === null
      ? [
          'Положенное снижение платы — по заявлению о перерасчёте: ____ ₽.',
          'Превышение начисленной платы над платой, которую надлежало начислить: ____ ₽.',
          'Штраф 50% величины превышения: ____ ₽.',
        ]
      : [
          `Положенное снижение платы (по заявлению о перерасчёте): ≈ ${fmtRub(m.expected!)}.`,
          `Учтено исполнителем: ${fmtRub(m.refunded)}.`,
          `Превышение начисленной платы: ≈ ${fmtRub(m.excess)}.`,
          `Штраф 50% величины превышения: ≈ ${fmtRub(m.fine!)}.`,
        ];
  return {
    to: base.to,
    from: base.from,
    heading: 'ТРЕБОВАНИЕ',
    title: 'Требование о перерасчёте платы и уплате штрафа за нарушение порядка расчёта платы за коммунальную услугу',
    facts,
    norm: [
      'Согласно ч. 6 ст. 157 Жилищного кодекса РФ лицо, предоставляющее коммунальные услуги, при нарушении порядка расчёта платы за коммунальные услуги, повлёкшем необоснованное увеличение размера такой платы, обязано уплатить потребителю штраф в размере 50% величины превышения начисленной платы над размером платы, которую надлежало начислить. Порядок уплаты штрафа — п. 155(1) Правил (путём снижения размера платы).',
    ],
    calc,
    requestsTitle: 'На основании ч. 6 ст. 157 ЖК РФ и п. 155(1) Правил требую:',
    requests: [
      `1. Произвести перерасчёт платы за коммунальную услугу «${serviceName}»${m.excess !== null ? ` на ≈ ${fmtRub(m.excess)}` : ' в соответствии с заявлением о перерасчёте'}.`,
      `2. Уплатить штраф в размере 50% величины превышения${m.fine !== null ? ` — ≈ ${fmtRub(m.fine)}` : ''} путём снижения размера платы в ближайшем платёжном документе.`,
      '3. Дать письменный ответ на настоящее требование.',
    ],
    attachments,
    // Оговорки для самого жителя (позиция потребителя, срок до оплаты) — в сообщении бота, а не в документе:
    // в требовании к исполнителю они только ослабили бы позицию.
    note: 'Суммы рассчитаны ориентировочно по данным потребителя и Приложению № 1 к Правилам.',
    signature: base.signature,
    total: m.fine ?? 0,
    fileName: 'Требование_о_штрафе.pdf',
  };
}

export function buildGjiComplaint(input: ClaimInput, opts: EscalationOpts): ClaimDoc {
  const { base, facts, attachments } = common(input, opts);
  const executor = executorLine(input.claim);
  const stats = opts.executorStats;
  const mass =
    stats && stats.houses >= 2
      ? [
          `По данным сервиса «Вернём», за последние 90 дней жители ${stats.houses} домов, где исполнителем является ${input.claim.executor ?? 'та же организация'}, зафиксировали ${stats.incidents} нарушений с регистрацией в аварийно-диспетчерской службе, письменным обращением или актом. Это может указывать на систематическое нарушение требований к предоставлению коммунальных услуг.`,
        ]
      : [];
  return {
    to: ['В Государственную жилищную инспекцию', `${BLANK} (субъект РФ)`],
    from: base.from,
    heading: 'ЖАЛОБА',
    title: 'Жалоба на неисполнение обязанности по перерасчёту платы за коммунальную услугу ненадлежащего качества',
    facts: [`Исполнитель коммунальной услуги: ${executor}.`, ...facts, ...mass],
    norm: [
      'Исполнитель обязан снизить размер платы при предоставлении коммунальной услуги ненадлежащего качества и (или) с перерывами, превышающими допустимую продолжительность (п. 98, 101 Правил и Приложение № 1 к Правилам предоставления коммунальных услуг, утв. ПП РФ от 06.05.2011 № 354).',
    ],
    calc: [],
    requestsTitle: 'Прошу:',
    requests: [
      '1. Провести проверку соблюдения исполнителем Правил предоставления коммунальных услуг по изложенным обстоятельствам.',
      '2. Выдать исполнителю предписание о перерасчёте платы.',
      '3. Рассмотреть вопрос о привлечении исполнителя к административной ответственности.',
      '4. Сообщить о результатах рассмотрения в письменной форме.',
    ],
    attachments,
    note: mass.length
      ? 'Сведения о других домах — обезличенная статистика сервиса «Вернём»: учитываются только нарушения, подтверждённые номером АДС, письменным обращением или подписанным актом.'
      : 'Суммы рассчитаны ориентировочно по данным потребителя и Приложению № 1 к Правилам.',
    signature: base.signature,
    total: 0,
    fileName: 'Жалоба_в_ГЖИ.pdf',
  };
}

export function buildConsumerOrgRequest(input: ClaimInput, opts: EscalationOpts): ClaimDoc {
  const { base, facts, attachments, m } = common(input, opts);
  return {
    to: [opts.partnerName ? `В ${opts.partnerName}` : `В общественное объединение потребителей ${BLANK}`],
    from: base.from,
    heading: 'ЗАЯВЛЕНИЕ',
    title: 'Заявление об обращении в суд в защиту прав потребителя',
    facts: [`Исполнитель коммунальной услуги: ${executorLine(input.claim)}.`, ...facts],
    norm: [
      'В соответствии со ст. 45 Закона РФ от 07.02.1992 № 2300-1 «О защите прав потребителей» общественные объединения потребителей вправе обращаться в суды с заявлениями в защиту прав потребителей.',
    ],
    calc: [],
    requestsTitle: 'Прошу:',
    requests: [
      `1. Обратиться в суд с иском в защиту моих прав к исполнителю о перерасчёте платы${m.excess !== null ? ` (≈ ${fmtRub(m.excess)})` : ''}, взыскании штрафа по ч. 6 ст. 157 ЖК РФ, компенсации морального вреда и штрафа по п. 6 ст. 13 Закона «О защите прав потребителей».`,
      '2. Сообщить мне о принятом решении.',
      '3. Согласие на обработку моих персональных данных в целях обращения в суд даю.',
    ],
    attachments,
    note: 'Суммы рассчитаны ориентировочно по данным потребителя и Приложению № 1 к Правилам.',
    signature: base.signature,
    total: 0,
    fileName: 'Заявление_в_общество_защиты_прав_потребителей.pdf',
  };
}

export function buildEscalation(kind: EscalationKind, input: ClaimInput, opts: EscalationOpts): ClaimDoc {
  if (kind === 'fine') return buildFineDemand(input, opts);
  if (kind === 'gji') return buildGjiComplaint(input, opts);
  return buildConsumerOrgRequest(input, opts);
}
