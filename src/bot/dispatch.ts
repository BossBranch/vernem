// УК в боте: заявка жителей уходит сотруднику УК или диспетчеру прямо в MAX.
// • Житель пересылает УК ссылку-приглашение (?start=d_<код>), сотрудник подключается к дому.
// • «Отправить заявку в УК» — диспетчеру приходит карточка: «Принять», «Принять со своим номером», «Не наш дом».
// • Принял — номер и время регистрации сразу попадают в дело всех жителей отключения и в заявление.
// • «Выехали», «Устранено» — жители получают статус; «Устранено» житель подтверждает одной кнопкой.
// • УК молчит 30 минут — бот это записывает и предлагает позвонить или собрать акт с соседями.
// Сотрудник УК не может быть жителем того же дома: иначе житель подтверждал бы заявку сам себе.

import type { Dispatch, Dispatcher, House } from '../db/db.ts';
import { formatShort, localParts } from '../calc/time.ts';
import { loadCase } from '../services/cases.ts';
import type { Btn, OutMessage } from './types.ts';
import type { Vernem } from './core.ts';
import { actButtons } from './acts.ts';
import { ICON, backRow, cb, clean, link } from './ui.ts';

const MS_MIN = 60_000;
export const DISPATCH_TIMEOUT_MIN = 30;

export function dispatchInviteLink(bot: Vernem, house: House): string | null {
  return bot.cfg.botUsername ? `https://max.ru/${bot.cfg.botUsername}?start=d_${bot.db.dispatchCodeFor(house.id)}` : null;
}

export function canDispatch(bot: Vernem, houseId: number): boolean {
  return bot.db.listDispatchers(houseId).length > 0;
}

/** Кто принимает заявки дома — для подсказок жителю. */
export function dispatcherNames(bot: Vernem, houseId: number): string {
  return bot.db
    .listDispatchers(houseId)
    .map((d) => clean(d.title))
    .join('; ');
}

// ---------------------------------------------------------------------
// Подключение УК
// ---------------------------------------------------------------------

/** Житель получает сообщение для УК со ссылкой-приглашением. */
export async function sendDispatchInvite(bot: Vernem, userId: number, houseId: number) {
  const h = bot.db.getUserHouse(userId, houseId);
  if (!h) return bot.stale(userId);
  const url = dispatchInviteLink(bot, h);
  if (!url) return bot.send(userId, { text: 'Ссылка для УК появится, когда бот подключён к MAX.', buttons: [backRow()] });
  bot.db.track(userId, 'dispatch_invite', { house: h.id });
  await bot.send(userId, { text: 'Перешлите сообщение ниже в УК: в её чат в MAX, диспетчеру или на почту.' });
  return bot.send(userId, {
    // Ссылка в тексте: при пересылке MAX убирает кнопки, а ссылка продолжает работать.
    text: [
      `🏢 **Заявки жителей дома ${h.address}**`,
      'Жители этого дома сообщают об отключениях через бот «Вернём». Подключите сотрудника или диспетчера: заявки будут приходить ему в MAX, принять их можно одной кнопкой, а номер заявки жители получат сразу.',
      `👉 Подключиться: ${url}`,
    ].join('\n'),
    buttons: [[link('🏢 Подключиться', url)]],
  });
}

/** Сотрудник УК открыл ссылку `d_<код>`. */
export async function onDispatcherLink(bot: Vernem, userId: number, code: string) {
  const house = bot.db.getHouseByDispatchCode(code);
  if (!house) return bot.send(userId, { text: 'Ссылка для УК не найдена. Попросите жителей прислать новую.', buttons: bot.menu() });
  if (bot.db.getUserHouse(userId, house.id)) {
    return bot.send(userId, {
      text: 'Вы житель этого дома, поэтому не можете принимать его заявки от имени УК: иначе житель подтверждал бы заявку сам себе. Подключите отдельный аккаунт сотрудника УК.',
      buttons: bot.menu(),
    });
  }
  const existing = bot.db.getDispatcher(house.id, userId);
  bot.db.setState(userId, 'await_dispatcher_title', { houseId: house.id });
  return bot.send(userId, {
    text: [
      `🏢 Подключение к дому **${house.address}**.`,
      existing ? `Сейчас вы указаны как: ${clean(existing.title)}.` : '',
      'Как вас указывать в заявках? Напишите имя и организацию, например «Иванова А. П., диспетчер ООО «УК Пример»». Это увидят жители, и это попадёт в их заявления.',
    ]
      .filter(Boolean)
      .join('\n'),
    buttons: [backRow()],
  });
}

export async function onDispatcherTitle(bot: Vernem, userId: number, text: string, data: { houseId: number }) {
  const title = clean(text).slice(0, 120);
  if (title.length < 5 || !/\p{L}{2}/u.test(title)) {
    return bot.send(userId, { text: 'Напишите имя и организацию, например «Иванова А. П., диспетчер ООО «УК Пример»».', buttons: [backRow()] });
  }
  const house = bot.db.getHouse(data.houseId);
  if (!house || bot.db.getUserHouse(userId, house.id)) return bot.stale(userId);
  const fresh = !bot.db.getDispatcher(house.id, userId);
  bot.db.addDispatcher(house.id, userId, title);
  bot.db.setState(userId, 'idle');
  bot.db.track(userId, 'dispatcher_added', { house: house.id });
  await bot.send(userId, {
    text: [
      `✅ Готово. Заявки жителей дома **${house.address}** будут приходить сюда.`,
      'В заявке кнопки: «Принять» — жители сразу получат номер; потом «Выехали» и «Устранено».',
    ].join('\n'),
    buttons: [[cb('🚫 Отключиться от дома', `dsx:${house.id}`)], [cb('⬅️ Меню', 'menu')]],
  });
  // Заявки, которые уже ждут ответа, — сразу новому сотруднику.
  for (const inc of bot.db.listOpenIncidents(house.id)) {
    const d = bot.db.dispatchFor(inc.id);
    if (d && d.status === 'sent') await sendCard(bot, userId, d);
  }
  if (!fresh) return;
  // Жителям — что теперь можно отправлять заявки прямо из бота.
  for (const u of bot.db.houseSubscribers(house.id)) {
    await bot.safeSend(u.id, {
      text: `🏢 К дому ${house.address} подключилась УК: ${title}. Теперь заявку об отключении можно отправить ей прямо из бота — кнопка «📨 Отправить заявку в УК».`,
    });
  }
}

export async function onDispatcherLeave(bot: Vernem, userId: number, houseId: number) {
  const house = bot.db.getHouse(houseId);
  if (!house || !bot.db.getDispatcher(houseId, userId)) return bot.stale(userId);
  bot.db.removeDispatcher(houseId, userId);
  bot.db.track(userId, 'dispatcher_removed', { house: houseId });
  return bot.send(userId, { text: `Вы отключились от дома ${house.address}: заявки по нему больше не придут.`, buttons: bot.menu() });
}

// ---------------------------------------------------------------------
// Заявка жителя
// ---------------------------------------------------------------------

/** Житель отправляет заявку по своему делу. Возвращает текст ошибки или null. */
export async function dispatchCase(bot: Vernem, userId: number, pid: number): Promise<string | null> {
  const c = bot.ownCase(userId, pid);
  if (!c) return 'Дело не найдено';
  if (c.p.status !== 'tracking') return 'Услугу уже восстановили — заявка в УК не нужна';
  if (c.incident.demo) return 'В демо заявка в УК не отправляется';
  const dispatchers = bot.db.listDispatchers(c.house.id);
  if (!dispatchers.length) return 'УК этого дома ещё не подключена к боту';
  const existing = bot.db.dispatchFor(c.incident.id);
  // Повторное нажатие или сосед отправляет ту же заявку — не дублируем.
  if (existing && existing.status !== 'declined') return null;
  if (c.incident.ads_number) return 'У этого отключения уже есть номер заявки';
  if (existing) bot.db.deleteDispatch(existing.id);
  const d = bot.db.createDispatch(c.incident.id, c.house.id, userId, bot.now());
  for (const disp of dispatchers) await sendCard(bot, disp.user_id, d);
  const due = new Date(bot.now().getTime() + (bot.cfg.fastReminders ? 2 : DISPATCH_TIMEOUT_MIN) * MS_MIN);
  bot.db.schedule('dispatch_timeout', c.p.id, userId, due);
  bot.db.track(userId, 'dispatch_sent', { incident: c.incident.id });
  return null;
}

function cardText(bot: Vernem, d: Dispatch): string {
  const inc = bot.db.getIncident(d.incident_id)!;
  const house = bot.db.getHouse(d.house_id)!;
  const norm = bot.norms.services[inc.service_key];
  const people = bot.db.listParticipants(inc.id);
  const lines = [
    `🚨 **Заявка жителей:** ${ICON[inc.service_key]} ${norm.title}`,
    `${house.address}${inc.entrance ? `, подъезд ${clean(inc.entrance)}` : ''}`,
    `С ${formatShort(new Date(inc.started_at), house.tz)}, сообщили: ${people.length}`,
  ];
  const readings = people.flatMap((p) => bot.db.listReadings(p.id)).sort((a, b) => a.at.localeCompare(b.at));
  if (readings.length) lines.push(`Последний замер: +${String(readings[readings.length - 1].temp_c).replace('.', ',')} °C`);
  lines.push(`Отправлена ${formatShort(new Date(d.sent_at), house.tz)}.`);
  return lines.join('\n');
}

function sendCard(bot: Vernem, userId: number, d: Dispatch) {
  return bot.safeSend(userId, {
    text: cardText(bot, d),
    buttons: [[cb('✅ Принять', `dsp:${d.id}:acc`)], [cb('✏️ Принять со своим номером', `dsp:${d.id}:num`)], [cb('🚫 Не наш дом', `dsp:${d.id}:no`)]],
  });
}

/** Номер, если диспетчер не назвал свой: день и месяц + порядковый номер заявки в сервисе. */
function autoNumber(d: Dispatch, tz: string, now: Date): string {
  const p = localParts(now, tz);
  return `${String(p.day).padStart(2, '0')}${String(p.month).padStart(2, '0')}-${d.id}`;
}

function takenText(d: Dispatch, userId: number): string {
  if (d.status === 'declined') return 'Эту заявку уже отклонили: «Не наш дом».';
  if (d.accepted_by === userId) return `Вы уже приняли эту заявку: № ${clean(d.number)}.`;
  return `Заявку уже принял(а) ${clean(d.accepted_title)}: № ${clean(d.number)}.`;
}

async function notifyParticipants(bot: Vernem, incidentId: number, build: (pid: number) => OutMessage, onlyTracking = false) {
  for (const p of bot.db.listParticipants(incidentId)) {
    if (onlyTracking && p.status !== 'tracking') continue;
    await bot.safeSend(p.user_id, build(p.id));
  }
}

const caseRow = (pid: number): Btn[] => [cb('📋 К делу', `cs:${pid}`)];

async function accept(bot: Vernem, userId: number, d: Dispatch, me: Dispatcher, number: string) {
  if (d.status !== 'sent') return bot.send(userId, { text: takenText(d, userId) });
  const house = bot.db.getHouse(d.house_id)!;
  const now = bot.now();
  bot.db.updateDispatch(d.id, { status: 'accepted', number, accepted_at: now.toISOString(), accepted_by: userId, accepted_title: me.title });
  // Номер заявки становится доказательством для всех жителей этого отключения.
  const inc = bot.db.getIncident(d.incident_id)!;
  if (!inc.ads_number) bot.db.setIncidentEvidence(inc.id, 'ads', number);
  for (const p of bot.db.listParticipants(inc.id)) bot.db.cancelReminders(p.id, 'dispatch_timeout');
  bot.db.track(userId, 'dispatch_accepted', { incident: inc.id });
  await bot.send(userId, {
    text: `✅ Приняли заявку № ${number}. Жители уже видят номер. Когда выедете и когда устраните — нажмите:`,
    buttons: [[cb('🚗 Выехали', `dsp:${d.id}:go`), cb('✅ Устранено', `dsp:${d.id}:fix`)]],
  });
  for (const other of bot.db.listDispatchers(d.house_id)) {
    if (other.user_id !== userId) await bot.safeSend(other.user_id, { text: `ℹ️ Заявку по ${house.address} принял(а) ${clean(me.title)}: № ${number}.` });
  }
  await notifyParticipants(bot, inc.id, (pid) => ({
    text: `✅ **УК приняла заявку**: № ${number}, ${formatShort(now, house.tz)}. Принял(а): ${clean(me.title)}.\nНомер уже в вашем деле и попадёт в заявление.`,
    buttons: [caseRow(pid)],
  }));
}

/** Кнопки сотрудника УК в карточке заявки. */
export async function onDispatchButton(bot: Vernem, userId: number, dispatchId: number, action: string) {
  const d = bot.db.getDispatch(dispatchId);
  if (!d) return bot.stale(userId);
  const me = bot.db.getDispatcher(d.house_id, userId);
  if (!me) return bot.send(userId, { text: 'Вы больше не подключены к этому дому.', buttons: bot.menu() });
  const house = bot.db.getHouse(d.house_id)!;
  const now = bot.now();
  switch (action) {
    case 'acc':
      return accept(bot, userId, d, me, autoNumber(d, house.tz, now));
    case 'num':
      if (d.status !== 'sent') return bot.send(userId, { text: takenText(d, userId) });
      bot.db.setState(userId, 'await_dispatch_number', { dispatchId: d.id });
      return bot.send(userId, { text: 'Напишите номер заявки из вашего журнала:', buttons: [[cb('Отмена', `dsp:${d.id}:card`)]] });
    case 'card':
      bot.db.setState(userId, 'idle');
      return d.status === 'sent' ? sendCard(bot, userId, d) : bot.send(userId, { text: takenText(d, userId) });
    case 'no': {
      if (d.status !== 'sent') return bot.send(userId, { text: takenText(d, userId) });
      bot.db.updateDispatch(d.id, { status: 'declined', declined_at: now.toISOString() });
      bot.db.track(userId, 'dispatch_declined', { incident: d.incident_id });
      for (const p of bot.db.listParticipants(d.incident_id)) bot.db.cancelReminders(p.id, 'dispatch_timeout');
      const phone = bot.db.houseInfo(house).adsPhone;
      await notifyParticipants(
        bot,
        d.incident_id,
        (pid) => ({
          text: `🏢 УК ответила, что дом ${house.address} не обслуживает. Позвоните в аварийную службу${phone ? `: ${phone}` : ' — телефон есть в квитанции'} и запишите номер заявки.`,
          buttons: [[cb('✏️ Ввести номер заявки', `own:${pid}`)], caseRow(pid)],
        }),
        true,
      );
      return bot.send(userId, {
        text: 'Отметил: это не ваш дом, жители предупреждены. Если вас подключили к чужому дому по ошибке — отключитесь.',
        buttons: [[cb('🚫 Отключиться от дома', `dsx:${house.id}`)]],
      });
    }
    case 'go':
    case 'fix': {
      // Статусы может отметить любой сотрудник, подключённый к дому, — не только тот, кто принял.
      if (d.status === 'sent' || d.status === 'declined') return bot.send(userId, { text: 'Сначала примите заявку.' });
      if (action === 'go') {
        if (d.status !== 'accepted') return bot.send(userId, { text: 'Этот статус уже отмечен.', buttons: [[cb('✅ Устранено', `dsp:${d.id}:fix`)]] });
        bot.db.updateDispatch(d.id, { status: 'onsite', onsite_at: now.toISOString() });
        await notifyParticipants(bot, d.incident_id, (pid) => ({ text: `🚗 УК по заявке № ${clean(d.number)}: выехали на место (${formatShort(now, house.tz)}).`, buttons: [caseRow(pid)] }), true);
        return bot.send(userId, { text: 'Отметил: выехали. Когда устраните — нажмите:', buttons: [[cb('✅ Устранено', `dsp:${d.id}:fix`)]] });
      }
      if (d.status === 'fixed') return bot.send(userId, { text: 'Уже отмечено: устранено.' });
      bot.db.updateDispatch(d.id, { status: 'fixed', fixed_at: now.toISOString() });
      bot.db.track(userId, 'dispatch_fixed', { incident: d.incident_id });
      const at = formatShort(now, house.tz);
      await notifyParticipants(
        bot,
        d.incident_id,
        (pid) => ({
          text: `🔧 УК по заявке № ${clean(d.number)} сообщает: устранено в ${at}. У вас тоже всё в порядке?`,
          buttons: [[cb(`✅ Да, с ${at.slice(-5)}`, `dspend:${pid}`), cb('Ещё нет', `rest:${pid}:n`)]],
        }),
        true,
      );
      return bot.send(userId, { text: `Отметил: устранено в ${at}. Жители подтвердят у себя.` });
    }
  }
  return bot.stale(userId);
}

export async function onDispatchNumber(bot: Vernem, userId: number, text: string, data: { dispatchId: number }) {
  const number = clean(text).slice(0, 40);
  const d = bot.db.getDispatch(data.dispatchId);
  if (!d) return bot.stale(userId);
  if (!/\d/.test(number)) return bot.send(userId, { text: 'В номере должны быть цифры, например 4512 или А-17.', buttons: [[cb('Отмена', `dsp:${d.id}:card`)]] });
  const me = bot.db.getDispatcher(d.house_id, userId);
  if (!me) return bot.stale(userId);
  bot.db.setState(userId, 'idle');
  return accept(bot, userId, d, me, number);
}

/** Напоминание: УК не ответила вовремя. Бот записывает это и предлагает запасные пути. */
export async function remindDispatch(bot: Vernem, pid: number) {
  const c = loadCase(bot.db, pid);
  if (!c) return;
  const d = bot.db.dispatchFor(c.incident.id);
  if (!d || d.status !== 'sent' || d.timeout_at) return;
  bot.db.updateDispatch(d.id, { timeout_at: bot.now().toISOString() });
  bot.db.track(c.p.user_id, 'dispatch_timeout', { incident: c.incident.id });
  const phone = bot.db.houseInfo(c.house).adsPhone;
  const minutes = Math.round((bot.now().getTime() - new Date(d.sent_at).getTime()) / MS_MIN);
  for (const p of bot.db.listParticipants(c.incident.id)) {
    if (p.status !== 'tracking') continue;
    const pc = loadCase(bot.db, p.id)!;
    await bot.safeSend(p.user_id, {
      text: [
        `⏰ УК не ответила на заявку за ${minutes} мин. Я это записал: заявка отправлена ${formatShort(new Date(d.sent_at), c.house.tz)}, ответа нет — это тоже попадёт в заявление.`,
        `Позвоните в аварийную службу${phone ? `: ${phone}` : ' — телефон есть в квитанции'} и запишите номер. Не дозвонитесь — соберите акт с соседями.`,
      ].join('\n'),
      buttons: [[cb('✏️ Ввести номер заявки', `own:${p.id}`)], ...actButtons(bot, pc), caseRow(p.id)],
    });
  }
}

/** Житель подтверждает окончание по сообщению УК «Устранено». */
export async function onDispatchEnd(bot: Vernem, userId: number, pid: number) {
  const c = bot.ownCase(userId, pid);
  if (!c) return bot.stale(userId);
  const d = bot.db.dispatchFor(c.incident.id);
  if (!d?.fixed_at || c.p.status !== 'tracking') return bot.showCase(userId, pid);
  return bot.setEnded(userId, c, new Date(d.fixed_at));
}

/** Жители отметили, что починили, а УК ещё не нажала «Устранено» — сообщаем ей. */
export async function tellDispatchersRestored(bot: Vernem, incidentId: number, endedAt: Date) {
  const d = bot.db.dispatchFor(incidentId);
  if (!d || (d.status !== 'accepted' && d.status !== 'onsite')) return false;
  const house = bot.db.getHouse(d.house_id)!;
  for (const disp of bot.db.listDispatchers(d.house_id)) {
    await bot.safeSend(disp.user_id, { text: `ℹ️ Жители дома ${house.address} отметили по заявке № ${clean(d.number)}: восстановлено в ${formatShort(endedAt, house.tz)}.` });
  }
  return true;
}

/** Строка о заявке в УК для сообщений бота. */
export function dispatchLine(d: Dispatch, tz: string): string {
  const t = (iso: string | null) => (iso ? formatShort(new Date(iso), tz) : '');
  if (d.status === 'declined') return '🚫 УК ответила, что не обслуживает этот дом.';
  if (d.status === 'sent') return d.timeout_at ? `📨 Заявка в УК отправлена ${t(d.sent_at)} — УК не ответила.` : `📨 Заявка в УК отправлена ${t(d.sent_at)}, ждём ответа.`;
  const parts = [`✅ УК приняла заявку: № ${clean(d.number)}, ${t(d.accepted_at)} (${clean(d.accepted_title)}).`];
  if (d.onsite_at) parts.push(`Выехали ${t(d.onsite_at)}.`);
  if (d.fixed_at) parts.push(`Сообщили: устранено ${t(d.fixed_at)}.`);
  return parts.join(' ');
}
