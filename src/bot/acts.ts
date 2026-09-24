// Акт без исполнителя (п. 110(1) ПП РФ № 354): подписывают не менее 2 потребителей и председатель
// совета дома. Акт — доказательство, заявление — требование денег; акт прикладывается к заявлению.
// PDF для подписи житель получает сразу: в нём пустые строки для соседей, которых нет в боте, —
// можно распечатать и обойти подъезд. Соседей из бота бот зовёт сам и вписывает их имена в акт.
// Строка для подписи председателя есть в самом акте: отдельной роли в боте у него нет.
// Подтверждение в боте — не подпись: акт получает силу после подписи на бумаге.
//
// Здесь же проверка исполнителем (п. 108–109): через 2 часа бот спрашивает, приходили ли с замером.

import type { Act, ActReason, ActSigner, House, Incident } from '../db/db.ts';
import { formatShort, MS_HOUR } from '../calc/time.ts';
import { ACT_REASON } from '../docs/act.ts';
import { actDocFor, loadCase } from '../services/cases.ts';
import type { CaseBundle } from '../services/cases.ts';
import type { Btn } from './types.ts';
import type { Vernem } from './core.ts';
import { ACT_VS_CLAIM, backRow, cb, clean } from './ui.ts';

export const MIN_RESIDENTS = 2;

export const ACT_STATUS_TITLE: Record<Act['status'], string> = {
  collecting: 'ждёт подписей',
  chair: 'ждёт подписей',
  ready: 'ждёт подписей',
  signed: 'подписан',
};

type ActCtx = { act: Act; incident: Incident; house: House; signers: ActSigner[] };

function load(bot: Vernem, actId: number): ActCtx | null {
  const act = Number.isFinite(actId) ? bot.db.getAct(actId) : undefined;
  if (!act) return null;
  const incident = bot.db.getIncident(act.incident_id);
  if (!incident) return null;
  return { act, incident, house: bot.db.getHouse(incident.house_id)!, signers: bot.db.listSigners(act.id) };
}

/** Пока акт не подписан на бумаге, в него можно вписывать соседей. */
const open = (ctx: ActCtx) => ctx.act.status !== 'signed';
const shortName = (fio: string) => {
  const [last, ...rest] = fio.split(' ');
  return [last, ...rest.map((p) => `${p[0]}.`)].join(' ');
};

/** Кнопки акта для карточки случая: собрать или посмотреть статус. */
export function actButtons(bot: Vernem, c: CaseBundle): Btn[][] {
  const act = bot.db.getActByIncident(c.incident.id);
  if (act) return [[cb(`📄 Акт: ${ACT_STATUS_TITLE[act.status]}`, `ak:st:${act.id}`)]];
  const norm = bot.norms.services[c.incident.service_key];
  const useful = c.incident.evidence === 'self' || c.p.inspection === 'no_show' || norm.kind !== 'interruption';
  return useful ? [[cb('📄 Акт с соседями', `ak:new:${c.p.id}`)]] : [];
}

// ---------------------------------------------------------------------
// Создание акта и подтверждения соседей
// ---------------------------------------------------------------------

export async function startAct(bot: Vernem, userId: number, pid: number) {
  const c = bot.ownCase(userId, pid);
  if (!c) return bot.stale(userId);
  const existing = bot.db.getActByIncident(c.incident.id);
  if (existing) return showAct(bot, userId, existing.id);
  const known: ActReason | null = c.p.inspection === 'no_show' ? 'no_inspection' : c.incident.evidence === 'self' ? 'no_ads' : null;
  if (known) return createAct(bot, userId, pid, known);
  return bot.send(userId, {
    text: `${ACT_VS_CLAIM}\n\nАкт составляют, если аварийка не ответила или никто не пришёл на замер. Что у вас?`,
    buttons: [[cb('Не дозвонился', `ak:rs:${pid}:no_ads`)], [cb('Не пришли на замер', `ak:rs:${pid}:no_inspection`)], backRow()],
  });
}

export async function createAct(bot: Vernem, userId: number, pid: number, reason: ActReason) {
  const c = bot.ownCase(userId, pid);
  if (!c || (reason !== 'no_ads' && reason !== 'no_inspection')) return bot.stale(userId);
  const existing = bot.db.getActByIncident(c.incident.id);
  if (existing) return showAct(bot, userId, existing.id);
  const act = bot.db.createAct(c.incident.id, userId, reason);
  bot.db.track(userId, 'act_started', { incident: c.incident.id });
  return askSigner(bot, userId, act.id);
}

/** ФИО и квартира подписанта: подставляем сохранённые или спрашиваем. */
function askSigner(bot: Vernem, userId: number, actId: number) {
  const u = bot.db.getUser(userId)!;
  if (u.fio && u.flat) {
    return bot.send(userId, {
      text: `Вписать в акт: ${clean(u.fio)}, кв. ${clean(u.flat)}?`,
      buttons: [[cb('✅ Да', `ak:me:${actId}`), cb('Другие данные', `ak:data:${actId}`)]],
    });
  }
  return askFio(bot, userId, actId);
}

function askFio(bot: Vernem, userId: number, actId: number) {
  bot.db.setState(userId, 'await_act_fio', { actId });
  return bot.send(userId, {
    text: 'Ваши ФИО для акта? Их увидят соседи, которые его подписывают, и УК.',
    buttons: [backRow()],
  });
}

export async function onActText(bot: Vernem, userId: number, state: string, text: string, data: { actId: number; fio?: string }) {
  const value = clean(text).replace(/\s+/g, ' ').slice(0, 150);
  if (state === 'await_act_fio') {
    if (value.length < 5 || /\d/.test(value)) return bot.send(userId, { text: 'Фамилия, имя и отчество буквами, например «Иванова Анна Петровна».' });
    bot.db.setState(userId, 'await_act_flat', { ...data, fio: value });
    return bot.send(userId, { text: 'Номер квартиры?', buttons: [backRow()] });
  }
  if (!/^[\dА-Яа-яA-Za-z/-]{1,10}$/.test(value)) return bot.send(userId, { text: 'Номер квартиры, например 42 или 12А.' });
  return confirmSigner(bot, userId, data.actId, data.fio!, value);
}

async function confirmSigner(bot: Vernem, userId: number, actId: number, fio: string, flat: string | null) {
  bot.db.setState(userId, 'idle');
  const ctx = load(bot, actId);
  if (!ctx) return bot.stale(userId);
  if (!open(ctx) || ctx.signers.some((s) => s.user_id === userId)) return showAct(bot, userId, actId);
  if (!bot.db.getParticipantFor(ctx.incident.id, userId)) return askJoinFirst(bot, userId, ctx);

  bot.db.addSigner(actId, userId, 'resident', fio, flat, bot.now());
  bot.db.track(userId, 'act_resident', { act: actId });
  const u = bot.db.getUser(userId)!;
  if (u.save_personal) bot.db.updateUser(userId, { fio, flat: flat ?? u.flat });
  const fresh = load(bot, actId)!;
  const n = fresh.signers.length;

  if (userId === ctx.act.initiator_user_id && n === 1) {
    // Акт — сразу: не ждём, пока соседи появятся в боте. Пустые строки — для подписей на бумаге.
    const sent = await inviteParticipants(bot, fresh);
    await bot.send(userId, {
      text: [
        '📄 **Акт готов к подписи.** Распечатайте и попросите расписаться 2+ соседей и председателя совета дома.',
        sent ? `Ещё отправил его ${sent} ${sent === 1 ? 'соседу' : 'соседям'} в бот — кто подтвердит, того впишу сам.` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
    await sendActPdf(bot, userId, actId);
    const pid = bot.db.getParticipantFor(fresh.incident.id, userId)!.id;
    return bot.send(userId, {
      text: 'Когда подпишут — отметьте. Акт попадёт в ваше заявление.',
      buttons: [[cb('✅ Акт подписан', `ak:done:${actId}`)], [cb('👥 Позвать соседей', `nb:${pid}`)]],
    });
  }
  await bot.send(userId, { text: '✍️ Вы в акте.' });
  if (userId !== fresh.act.initiator_user_id) {
    await bot.safeSend(fresh.act.initiator_user_id, { text: `✍️ ${shortName(fio)} подтвердил(а) акт. Жителей в акте: ${n}.` });
  }
  if (n >= MIN_RESIDENTS && fresh.act.status === 'collecting') {
    bot.db.setActStatus(actId, 'ready', bot.now());
    return finalize(bot, actId);
  }
  // Акт уже разослан — новому соседу нужен свой экземпляр.
  if (fresh.act.status === 'ready') return sendActPdf(bot, userId, actId);
}

function actSummaryLines(bot: Vernem, ctx: ActCtx): string[] {
  const norm = bot.norms.services[ctx.incident.service_key];
  return [`${norm.title}: ${ctx.house.address}${ctx.incident.entrance ? `, подъезд ${ctx.incident.entrance}` : ''}, с ${formatShort(new Date(ctx.incident.started_at), ctx.house.tz)}.`];
}

async function sendActRequest(bot: Vernem, ctx: ActCtx, userId: number) {
  await bot.safeSend(userId, {
    text: [
      '✍️ **Соседи составляют акт о нарушении**',
      ...actSummaryLines(bot, ctx),
      'Он заменит проверку УК. Подтвердите, что у вас то же самое, — впишу ваши ФИО и квартиру.',
    ].join('\n'),
    buttons: [[cb('✍️ Подтверждаю', `ak:sg:${ctx.act.id}`), cb('Не могу', `ak:no:${ctx.act.id}`)]],
  });
}

async function inviteParticipants(bot: Vernem, ctx: ActCtx): Promise<number> {
  const signed = new Set(ctx.signers.map((s) => s.user_id));
  let n = 0;
  for (const p of bot.db.listParticipants(ctx.incident.id)) {
    if (signed.has(p.user_id) || p.user_id === ctx.act.initiator_user_id) continue;
    await sendActRequest(bot, ctx, p.user_id);
    n++;
  }
  return n;
}

/** Новый участник отключения сразу получает акт, если его собирают. */
export async function inviteToAct(bot: Vernem, incidentId: number, userId: number) {
  const act = bot.db.getActByIncident(incidentId);
  if (!act) return;
  const ctx = load(bot, act.id)!;
  if (!open(ctx) || ctx.signers.some((s) => s.user_id === userId)) return;
  await sendActRequest(bot, ctx, userId);
}

// ---------------------------------------------------------------------
// Готовый акт
// ---------------------------------------------------------------------

async function finalize(bot: Vernem, actId: number) {
  const ctx = load(bot, actId)!;
  bot.db.track(ctx.act.initiator_user_id, 'act_ready', { act: actId });
  const recipients = [...new Set([ctx.act.initiator_user_id, ...ctx.signers.map((s) => s.user_id)])];
  for (const uid of recipients) {
    const initiator = uid === ctx.act.initiator_user_id;
    await bot.safeSend(uid, {
      text: '📄 **Акт с именами соседей.** Распечатайте и подпишите вместе с председателем совета дома. Галочка в боте — не подпись.',
    });
    await sendActPdf(bot, uid, actId);
    if (initiator) await bot.safeSend(uid, { text: 'Когда подпишут — отметьте:', buttons: [[cb('✅ Акт подписан', `ak:done:${actId}`)]] });
  }
}

async function sendActPdf(bot: Vernem, userId: number, actId: number) {
  return bot.sendDocPdf(userId, actDocFor(bot.db, bot.norms, actId, bot.now())!, 'Акт (PDF):');
}

/**
 * Акт из мини-приложения: создать (если ещё нет) и вписать жителя. Дальше всё как в чате —
 * PDF приходит и в диалог, соседей из бота бот зовёт сам. Возвращает id акта.
 */
export async function actFromApp(bot: Vernem, userId: number, pid: number, fio: string, flat: string | null): Promise<number | null> {
  const c = bot.ownCase(userId, pid);
  if (!c) return null;
  let act = bot.db.getActByIncident(c.incident.id);
  if (!act) {
    // Позвонили, но на замер никто не пришёл, — иначе не дозвонились.
    const reason: ActReason = c.incident.evidence === 'self' && c.p.inspection !== 'no_show' ? 'no_ads' : 'no_inspection';
    act = bot.db.createAct(c.incident.id, userId, reason);
    bot.db.track(userId, 'act_started', { incident: c.incident.id, via: 'app' });
  }
  const ctx = load(bot, act.id)!;
  if (open(ctx) && !ctx.signers.some((s) => s.user_id === userId)) await confirmSigner(bot, userId, act.id, fio, flat);
  return act.id;
}

/** «Акт подписан на бумаге» — отмечает только тот, кто начал акт. */
export async function markActSigned(bot: Vernem, userId: number, actId: number, chair: boolean): Promise<boolean> {
  const ctx = load(bot, actId);
  if (!ctx || ctx.act.initiator_user_id !== userId || !open(ctx)) return false;
  bot.db.setActChairSigned(actId, chair ? 1 : 0);
  bot.db.setActStatus(actId, 'signed', bot.now());
  bot.db.track(userId, 'act_signed', { act: actId, chair });
  for (const s of ctx.signers) {
    if (s.user_id !== userId) await bot.safeSend(s.user_id, { text: 'Акт подписан ✅ Он попадёт в заявления всех участников.' });
  }
  return true;
}

export async function showAct(bot: Vernem, userId: number, actId: number) {
  const ctx = load(bot, actId);
  if (!ctx) return bot.stale(userId);
  const isInitiator = ctx.act.initiator_user_id === userId;
  const mine = ctx.signers.some((s) => s.user_id === userId);
  if (!isInitiator && !mine && !bot.db.getParticipantFor(ctx.incident.id, userId)) return bot.stale(userId);
  const rows: Btn[][] = [];
  if (!mine && open(ctx)) rows.push([cb('✍️ Подтвердить акт', `ak:sg:${actId}`)]);
  if (mine || isInitiator) rows.push([cb('📄 Акт (PDF)', `ak:pdf:${actId}`)]);
  if (open(ctx) && isInitiator) rows.push([cb('✅ Акт подписан', `ak:done:${actId}`)]);
  rows.push([cb('⬅️ Меню', 'menu')]);
  return bot.send(userId, {
    text: [
      `✍️ **Акт: ${ACT_STATUS_TITLE[ctx.act.status]}**`,
      ...actSummaryLines(bot, ctx),
      ...ctx.signers.map((s, i) => `${i + 1}. ${shortName(s.fio)}${s.flat ? `, кв. ${s.flat}` : ''}`),
      open(ctx) ? `Нужны подписи минимум ${MIN_RESIDENTS} жителей и председателя совета дома.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    buttons: rows,
  });
}

async function askJoinFirst(bot: Vernem, userId: number, ctx: ActCtx) {
  const norm = bot.norms.services[ctx.incident.service_key];
  return bot.send(userId, {
    text: `Сначала отметьте, что у вас тоже: ${norm.button.toLowerCase()}, ${ctx.house.address}. Потом пришлю акт.`,
    buttons: [[cb('✅ У меня тоже', `jn:${ctx.incident.id}`)], backRow()],
  });
}

// ---------------------------------------------------------------------
// Кнопки акта: ak:<действие>:<id>[:<значение>]
// ---------------------------------------------------------------------

export async function onActButton(bot: Vernem, userId: number, action: string, a: string, b: string | undefined): Promise<unknown> {
  const id = Number(a);
  switch (action) {
    case 'new':
      return startAct(bot, userId, id);
    case 'rs':
      return createAct(bot, userId, id, b as ActReason);
    case 'me': {
      const u = bot.db.getUser(userId)!;
      return u.fio ? confirmSigner(bot, userId, id, u.fio, u.flat) : askFio(bot, userId, id);
    }
    case 'data':
      return askFio(bot, userId, id);
    case 'sg': {
      const ctx = load(bot, id);
      if (!ctx) return bot.stale(userId);
      if (ctx.signers.some((s) => s.user_id === userId) || !open(ctx)) return showAct(bot, userId, id);
      if (!bot.db.getParticipantFor(ctx.incident.id, userId)) return askJoinFirst(bot, userId, ctx);
      return askSigner(bot, userId, id);
    }
    case 'no': {
      const ctx = load(bot, id);
      if (!ctx) return bot.stale(userId);
      await bot.safeSend(ctx.act.initiator_user_id, { text: 'Один сосед не смог подтвердить акт. Позовите других — пришлю акт каждому, кто отметит отключение.' });
      return bot.send(userId, { text: 'Понял, не вписываю вас.', buttons: bot.menu() });
    }
    case 'st':
      return showAct(bot, userId, id);
    case 'pdf': {
      const ctx = load(bot, id);
      if (!ctx || (!ctx.signers.some((s) => s.user_id === userId) && ctx.act.initiator_user_id !== userId)) return bot.stale(userId);
      return sendActPdf(bot, userId, id);
    }
    case 'done': {
      const ctx = load(bot, id);
      if (!ctx || ctx.act.initiator_user_id !== userId) return bot.stale(userId);
      if (!open(ctx)) return showAct(bot, userId, id);
      return bot.send(userId, {
        text: 'На бумаге подписали хотя бы 2 жителя (вместе с вами)?',
        buttons: [[cb('✅ Да, и председатель', `ak:chair:${id}:1`)], [cb('✅ Да, без председателя', `ak:chair:${id}:0`)], [cb('Ещё нет', `ak:st:${id}`)]],
      });
    }
    case 'chair': {
      const ctx = load(bot, id);
      if (!ctx || !(await markActSigned(bot, userId, id, b === '1'))) return bot.stale(userId);
      const p = bot.db.getParticipantFor(ctx.incident.id, userId);
      return bot.send(userId, {
        text: `✅ Акт подписан — он попадёт в заявления всех участников. Сфотографируйте его: оригинал понадобится.${b === '1' ? '' : '\nБез подписи председателя акт слабее, но подписи жителей всё равно подтверждают нарушение.'}`,
        buttons: [[cb('📷 Фото подписанного акта', p ? `phadd:${p.id}:act` : 'menu')], [cb('⬅️ Меню', 'menu')]],
      });
    }
  }
  return bot.stale(userId);
}

/** Ссылка на акт (переслана соседу): показать акт и предложить подтвердить. */
export async function onActLink(bot: Vernem, userId: number, code: string) {
  const act = bot.db.getActByCode(code);
  const ctx = act ? load(bot, act.id) : null;
  if (!ctx) return bot.send(userId, { text: 'Акт по этой ссылке не найден.', buttons: bot.menu() });
  if (!bot.db.getParticipantFor(ctx.incident.id, userId)) return askJoinFirst(bot, userId, ctx);
  return showAct(bot, userId, ctx.act.id);
}

// ---------------------------------------------------------------------
// Проверка исполнителем через 2 часа (п. 108–109)
// ---------------------------------------------------------------------

export function scheduleInspectionCheck(bot: Vernem, pid: number, userId: number, tz: string, hours = 2) {
  const due = bot.cfg.fastReminders ? new Date(bot.now().getTime() + 60_000) : bot.quietShift(new Date(bot.now().getTime() + hours * MS_HOUR), tz);
  bot.db.schedule('ask_inspection', pid, userId, due);
}

export async function remindInspection(bot: Vernem, pid: number) {
  const c = loadCase(bot.db, pid);
  if (!c || c.p.status !== 'tracking' || c.p.inspection === 'executor_act' || c.p.inspection === 'no_show') return;
  return bot.safeSend(c.p.user_id, {
    text: `Прошло 2 часа. Приходили из УК замерить температуру и составить акт? По правилам — не позднее 2 часов (п. 108 ПП № 354).`,
    buttons: [[cb('✅ Да, акт есть', `insp:${pid}:act`), cb('❌ Никто', `insp:${pid}:none`)], [cb('Договорились на потом', `insp:${pid}:later`)]],
  });
}

export async function onInspection(bot: Vernem, userId: number, pid: number, value: string) {
  const c = bot.ownCase(userId, pid);
  if (!c) return bot.stale(userId);
  if (value === 'act') {
    bot.db.updateParticipant(pid, { inspection: 'executor_act' });
    bot.db.track(userId, 'inspection_act');
    return bot.send(userId, {
      text: 'Отлично — это сильное доказательство. Возьмите свой экземпляр акта и пришлите фото.',
      buttons: [[cb('📷 Фото акта', `phadd:${pid}:act`), cb('⬅️ К делу', `cs:${pid}`)]],
    });
  }
  if (value === 'none') {
    bot.db.updateParticipant(pid, { inspection: 'no_show' });
    bot.db.track(userId, 'inspection_no_show');
    return bot.send(userId, {
      text: 'УК не пришла в срок — значит, акт можно составить с соседями без неё (п. 110(1)). Соберу его сам.',
      buttons: [[cb('✍️ Акт с соседями', `ak:new:${pid}`), cb('⬅️ К делу', `cs:${pid}`)]],
    });
  }
  if (value === 'later') {
    bot.db.updateParticipant(pid, { inspection: 'rescheduled' });
    scheduleInspectionCheck(bot, pid, userId, c.house.tz, 3);
    return bot.send(userId, { text: 'Хорошо, спрошу через 3 часа.', buttons: [[cb('⬅️ К делу', `cs:${pid}`)]] });
  }
  return bot.stale(userId);
}
