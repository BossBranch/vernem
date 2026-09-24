// Если перерасчёт не пришёл или пришёл не полностью, бот ведёт дело дальше — до денег:
// требование о штрафе 50% исполнителю, жалоба в ГЖИ, передача дела обществу защиты прав потребителей.
// «Давление массой»: в жалобу попадает число домов, где у того же исполнителя подтверждены нарушения.

import { executorKey } from '../db/db.ts';
import { fmtRub } from '../calc/format.ts';
import { MS_HOUR } from '../calc/time.ts';
import { buildEscalation, expectedRefund } from '../docs/escalation.ts';
import type { EscalationKind, EscalationOpts } from '../docs/escalation.ts';
import { claimInputFor, claimOf } from '../services/cases.ts';
import type { CaseBundle } from '../services/cases.ts';
import type { ClaimInput } from '../docs/claim.ts';
import type { Btn } from './types.ts';
import type { Vernem } from './core.ts';
import { cb, link } from './ui.ts';

const STATS_DAYS = 90;

/** Данные для документов: личные данные берём из заявления, а если житель их не сохранял в случае — из профиля. */
function inputFor(bot: Vernem, c: CaseBundle): ClaimInput {
  const input = claimInputFor(bot.db, bot.norms, c, bot.now());
  const u = bot.db.personFor(c.p.user_id, c.house.id);
  input.claim = {
    ...input.claim,
    fio: input.claim.fio ?? u.fio ?? undefined,
    flat: input.claim.flat ?? u.flat ?? undefined,
    account: input.claim.account ?? u.account ?? undefined,
  };
  return input;
}

function optsFor(bot: Vernem, c: CaseBundle): EscalationOpts {
  const key = executorKey(claimOf(c.p));
  return {
    refund: c.p.refund_amount,
    executorStats: key ? bot.db.executorStats(key, new Date(bot.now().getTime() - STATS_DAYS * 24 * MS_HOUR)) : undefined,
    partnerName: bot.cfg.partnerName,
    gji: bot.db.houseInfo(c.house).gji ?? null,
  };
}

/** Документ эскалации для скачивания из мини-приложения. */
export function escalationDocFor(bot: Vernem, c: CaseBundle, kind: EscalationKind) {
  const doc = buildEscalation(kind, inputFor(bot, c), optsFor(bot, c));
  if (c.incident.demo) doc.note = `ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ: не является реальным документом. ${doc.note}`;
  return doc;
}

export async function showEscalation(bot: Vernem, userId: number, pid: number) {
  const c = bot.ownCase(userId, pid);
  if (!c) return bot.stale(userId);
  const input = inputFor(bot, c);
  const opts = optsFor(bot, c);
  const expected = expectedRefund(input);
  const excess = expected === null ? null : Math.max(0, expected - (opts.refund ?? 0));
  const partner = bot.cfg.partnerName ? `«${bot.cfg.partnerName}»` : 'общество защиты прав потребителей';
  const lines = [
    `**Перерасчёт ${opts.refund ? 'сделали не полностью' : 'не сделали'}. Доведём дело до денег.**`,
    'Выберите — я подготовлю документ (текст и PDF):',
    '',
    `1. **Требование: перерасчёт и штраф 50%** (ч. 6 ст. 157 ЖК РФ).${excess ? ` Штраф ≈ ${fmtRub(Math.round(excess * 50) / 100)}.` : ''} Отправьте исполнителю до оплаты квитанции.`,
    '2. **Жалоба в ГЖИ** — инспекция проверит исполнителя и может выдать предписание о перерасчёте.',
    `3. **Передать дело в ${partner}.** Общественное объединение потребителей вправе подать иск в ваших интересах (ст. 45–46 Закона «О защите прав потребителей»), самому ходить в суд не нужно.`,
  ];
  const stats = opts.executorStats;
  if (stats && stats.houses >= 2) {
    lines.push('', `📊 По этому исполнителю бот видит подтверждённые нарушения в ${stats.houses} домах за ${STATS_DAYS} дней — укажу это в жалобе в ГЖИ.`);
  }
  return bot.send(userId, {
    text: lines.join('\n'),
    buttons: [
      [cb('💸 Требование о штрафе 50%', `esc:${pid}:fine`)],
      [cb('🏛 Жалоба в ГЖИ', `esc:${pid}:gji`)],
      [cb('⚖️ Общество защиты прав потребителей', `esc:${pid}:ozpp`)],
      [cb('📋 Мои случаи', 'cases'), cb('⬅️ В начало', 'menu')],
    ],
  });
}

export async function onEscalate(bot: Vernem, userId: number, pid: number, kind: string) {
  const c = bot.ownCase(userId, pid);
  if (!c || !c.p.ended_at || !['fine', 'gji', 'ozpp'].includes(kind)) return bot.stale(userId);
  const input = inputFor(bot, c);
  const opts = optsFor(bot, c);
  const doc = buildEscalation(kind as EscalationKind, input, opts);
  if (c.incident.demo) doc.note = `ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ: не является реальным документом. ${doc.note}`;
  bot.db.track(userId, `escalation_${kind}`, { service: c.incident.service_key });

  const rows: Btn[][] = [];
  let text: string;
  if (kind === 'fine') {
    text = [
      '**Требование готово** 📄',
      doc.total ? `Штраф 50% ≈ ${fmtRub(doc.total)} — засчитывается в счёт будущих платежей (п. 155(1) Правил).` : 'Суммы впишите по заявлению о перерасчёте.',
      'Отправьте исполнителю тем же способом, что и заявление, и сохраните подтверждение. Лучше до оплаты квитанции: если исполнитель исправит начисление до обращения или до оплаты, штрафа не будет (ч. 6 ст. 157 ЖК РФ).',
      '',
      'Честно: применять ч. 6 ст. 157 ЖК РФ к непроведённому перерасчёту — позиция потребителя. Исполнитель может не согласиться, тогда спор решает ГЖИ или суд.',
    ].join('\n');
  } else if (kind === 'gji') {
    text = [
      '**Жалоба в ГЖИ готова** 📄',
      'Подайте её через «Госуслуги», ГИС ЖКХ или сайт государственной жилищной инспекции вашего региона. Впишите регион и телефон, приложите заявление, подтверждение отправки и квитанцию.',
      opts.executorStats && opts.executorStats.houses >= 2 ? `В жалобе указано: подтверждённые нарушения этого исполнителя в ${opts.executorStats.houses} домах.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  } else {
    const partner = bot.cfg.partnerName;
    text = [
      `**Заявление в ${partner ? `«${partner}»` : 'общество защиты прав потребителей'} готово** 📄`,
      partner
        ? 'Отправьте его вместе с приложениями — юрист объединения свяжется с вами.'
        : 'Партнёрская организация к боту пока не подключена. Отнесите заявление в общество защиты прав потребителей вашего города.',
      'Если иск подаёт общественное объединение, половину штрафа по п. 6 ст. 13 закона суд перечисляет ему. Условия работы уточните в объединении.',
      'Если ваш дом в ТСЖ или ЖСК и вы его член, закон о защите прав потребителей может применяться ограниченно — спросите об этом юриста объединения.',
    ].join('\n');
    if (partner && bot.cfg.partnerUrl) rows.push([link(`⚖️ Перейти в «${partner}»`.slice(0, 64), bot.cfg.partnerUrl)]);
  }
  await bot.send(userId, { text });
  await bot.sendDocPdf(userId, doc, 'PDF для печати или отправки:');
  rows.push([cb('↩️ Другие варианты', `escm:${pid}`)], [cb('📋 Мои случаи', 'cases'), cb('⬅️ В начало', 'menu')]);
  return bot.send(userId, { text: 'Что ещё сделать?', buttons: rows });
}
