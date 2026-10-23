// Адреса и дома.
// • «Мои адреса»: у одного человека может быть несколько квартир (своя, родителей, сдаваемая).
// • Дом выбирается из списка — реестра домов сервиса, — а не вводится каждый раз вручную,
//   поэтому соседи попадают в один дом. В продакшене реестр заменяется ФИАС (нужен токен ФНС).
// • Карточка дома: УК, аварийная служба, ресурсоснабжающие организации — заполняют жители.
// • Сеть дома: когда кто-то фиксирует отключение, бот сам пишет соседям «У вас тоже?».

import type { Alert, Db, ExecutorType, House, HouseInfo, Incident } from '../db/db.ts';
import type { ServiceKey } from '../calc/norms.ts';
import { POPULAR_CITIES, resolveCity } from '../calc/cities.ts';
import { innProblem, plural } from '../calc/format.ts';
import { formatDate, formatShort, hoursBetween } from '../calc/time.ts';
import type { Btn } from './types.ts';
import type { Draft, Vernem } from './core.ts';
import { ICON, backRow, cb, clean, link } from './ui.ts';
import { dispatcherNames, sendDispatchInvite } from './dispatch.ts';

export function inviteLink(bot: Vernem, house: House): string {
  return `https://max.ru/${bot.cfg.botUsername}?start=h_${house.code}`;
}

const members = (bot: Vernem, houseId: number) => {
  const n = bot.db.countHouseMembers(houseId);
  return `${n} ${plural(n, ['житель', 'жителя', 'жителей'])}`;
};

// ---------------------------------------------------------------------
// Выбор адреса при сообщении о проблеме
// ---------------------------------------------------------------------

/** Один адрес — берём его; несколько — спрашиваем; ни одного — ищем дом в реестре. */
export function chooseAddress(bot: Vernem, userId: number, draft: Draft) {
  const list = bot.db.listUserHouses(userId);
  if (list.length === 1) return bot.continueDraft(userId, { ...draft, houseId: list[0].id });
  if (!list.length) return askAddressText(bot, userId, { draft });
  bot.db.setState(userId, 'draft', { draft });
  return bot.send(userId, {
    text: 'Укажите адрес, где произошло нарушение.',
    buttons: [...list.map((h) => [cb(`📍 ${h.address}`.slice(0, 64), `adr:${h.id}`)]), [cb('➕ Другой адрес', 'adrtxt')], backRow()],
  });
}

type AddressBack = { draft?: Draft; city?: string; cities?: string[]; typed?: string };

/** Адрес вводится в два шага: город (кнопкой или текстом), затем улица и дом внутри города. */
export function askAddressText(bot: Vernem, userId: number, back: AddressBack) {
  if (!back.city) return askCity(bot, userId, back);
  bot.db.setState(userId, 'await_address', { draft: back.draft, city: back.city });
  return bot.send(userId, {
    text: `🏙 ${back.city}. Укажите улицу и номер дома. Например: «Садовая 10».`,
    buttons: [[cb('Другой город', 'cty:change')], backRow()],
  });
}

function askCity(bot: Vernem, userId: number, back: AddressBack) {
  const cities = [...new Set([...bot.db.userCities(userId), ...POPULAR_CITIES])].slice(0, 6);
  bot.db.setState(userId, 'await_city', { draft: back.draft, cities });
  const rows: Btn[][] = [];
  for (let i = 0; i < cities.length; i += 2) rows.push(cities.slice(i, i + 2).map((c, j) => cb(c, `cty:${i + j}`)));
  rows.push([cb('✏️ Другой город', 'cty:manual')], backRow());
  return bot.send(userId, { text: 'Укажите город, в котором находится дом.', buttons: rows });
}

export async function onCityButton(bot: Vernem, userId: number, value: string) {
  const { state, data } = bot.db.getState<AddressBack>(userId);
  if (value === 'change') return askCity(bot, userId, { draft: data.draft });
  if (state !== 'await_city') return bot.stale(userId);
  if (value === 'manual') return bot.send(userId, { text: 'Укажите город или посёлок, например: «Химки».', buttons: [backRow()] });
  const name = data.cities?.[Number(value)];
  if (!name) return bot.stale(userId);
  return askAddressText(bot, userId, { draft: data.draft, city: name });
}

export async function onCityText(bot: Vernem, userId: number, text: string, data: AddressBack) {
  const city = resolveCity(clean(text), bot.cfg.defaultTz);
  if (!city) return bot.send(userId, { text: 'Укажите название города буквами, например: «Химки».', buttons: [backRow()] });
  return askAddressText(bot, userId, { draft: data.draft, city: city.name });
}

export async function onAddressText(bot: Vernem, userId: number, text: string, back: AddressBack) {
  if (!back.city) return askCity(bot, userId, back);
  const typed = clean(text).replace(/\s+/g, ' ');
  if (typed.length < 3 || typed.length > 200 || !/\d/.test(typed)) {
    return bot.send(userId, { text: 'Укажите улицу и номер дома, например: «Садовая 10».', buttons: [backRow()] });
  }
  const found = bot.db.searchHouses(typed, 6, back.city).filter((h) => !h.demo).slice(0, 5);
  // Дом уже в списке ровно с таким адресом — «добавить новый» не предлагаем, чтобы не путать.
  const exact = bot.db.findHouse(typed, back.city);
  if (exact && !exact.demo && !found.some((h) => h.id === exact.id)) found.unshift(exact);
  bot.db.setState(userId, 'await_address', { ...back, typed });
  const rows: Btn[][] = found.map((h) => [cb(`🏠 ${h.address}`.slice(0, 64), `adrpick:${h.id}`)]);
  if (!exact || exact.demo) rows.push([cb(`➕ Добавить дом «${typed}»`.slice(0, 64), 'adrnew')]);
  rows.push(backRow());
  return bot.send(userId, {
    text: found.length ? 'Выберите дом:' : 'Такого дома пока нет в списке. Добавить его?',
    buttons: rows,
  });
}

/** Выбор дома из моего списка (adr), из реестра (adrpick) или добавление нового (adrnew). */
export async function onAddressButton(bot: Vernem, userId: number, head: string, value: string) {
  const { state, data } = bot.db.getState<AddressBack>(userId);
  if (head === 'adrtxt') return askAddressText(bot, userId, { draft: data.draft });
  if (head === 'adr') {
    const h = bot.db.getUserHouse(userId, Number(value));
    if (!h || !data.draft) return bot.stale(userId);
    bot.db.addUserHouse(userId, h.id);
    return bot.continueDraft(userId, { ...data.draft, houseId: h.id });
  }
  if (state !== 'await_address') return bot.stale(userId);
  let house: House | undefined;
  if (head === 'adrpick') house = bot.db.getHouse(Number(value));
  if (head === 'adrnew' && data.typed && data.city) {
    const city = resolveCity(data.city, bot.cfg.defaultTz)!;
    house = bot.db.upsertHouse(data.typed, city.tz, 0, city.name);
  }
  if (!house) return bot.stale(userId);
  return addressChosen(bot, userId, house, { draft: data.draft });
}

async function addressChosen(bot: Vernem, userId: number, house: House, back: { draft?: Draft }) {
  const had = bot.db.getUserHouse(userId, house.id);
  bot.db.addUserHouse(userId, house.id);
  bot.db.track(userId, 'house_set', { house: house.id });
  if (!had) await bot.send(userId, { text: `📍 Адрес добавлен: ${house.address}. В сети дома: ${members(bot, house.id)}. При сообщении соседей об отключении вы получите уведомление.` });
  // Подъезд спрашиваем один раз для каждого адреса: он попадает в уведомления соседям и в акт.
  if (!had?.entrance) return askEntrance(bot, userId, house.id, back);
  return back.draft ? bot.continueDraft(userId, { ...back.draft, houseId: house.id }) : showHouseCard(bot, userId, house.id);
}

// ---------------------------------------------------------------------
// Подъезд
// ---------------------------------------------------------------------

export function askEntrance(bot: Vernem, userId: number, houseId: number, back: { draft?: Draft }) {
  bot.db.setState(userId, 'await_entrance', { ...back, houseId });
  return bot.send(userId, {
    text: 'Укажите номер подъезда. Нарушение может затрагивать только один стояк или подъезд.',
    buttons: [['1', '2', '3', '4'].map((e) => cb(e, `ent:${e}`)), ['5', '6', '7', '8'].map((e) => cb(e, `ent:${e}`)), [cb('✏️ Другой', 'ent:manual'), cb('Пропустить', 'ent:skip')]],
  });
}

export async function onEntranceButton(bot: Vernem, userId: number, value: string) {
  const { state, data } = bot.db.getState<{ draft?: Draft; houseId: number }>(userId);
  if (state !== 'await_entrance') return bot.stale(userId);
  if (value === 'manual') return bot.send(userId, { text: 'Укажите номер подъезда, например: 9 или 2А.', buttons: [[cb('Пропустить', 'ent:skip')]] });
  if (value !== 'skip') bot.db.setUserHouse(userId, data.houseId, { entrance: value });
  return afterEntrance(bot, userId, data);
}

export async function onEntranceText(bot: Vernem, userId: number, text: string, data: { draft?: Draft; houseId: number }) {
  const value = clean(text).toUpperCase();
  if (!/^\d{1,2}[А-ЯA-Z]?$/.test(value)) return bot.send(userId, { text: 'Укажите номер подъезда цифрами, например: 9 или 2А.', buttons: [[cb('Пропустить', 'ent:skip')]] });
  bot.db.setUserHouse(userId, data.houseId, { entrance: value });
  return afterEntrance(bot, userId, data);
}

function afterEntrance(bot: Vernem, userId: number, data: { draft?: Draft; houseId: number }) {
  bot.db.setState(userId, 'idle');
  if (data.draft) return bot.continueDraft(userId, { ...data.draft, houseId: data.houseId });
  return showHouseCard(bot, userId, data.houseId);
}

// ---------------------------------------------------------------------
// «Мои адреса» и карточка дома
// ---------------------------------------------------------------------

export function showAddresses(bot: Vernem, userId: number) {
  bot.db.setState(userId, 'idle');
  const list = bot.db.listUserHouses(userId);
  const rows: Btn[][] = list.map((h) => [cb(`🏠 ${h.address}${h.entrance ? `, под. ${h.entrance}` : ''}`.slice(0, 64), `hs:card:${h.id}`)]);
  rows.push([cb('➕ Добавить адрес', 'hs:add:0')]);
  if (bot.cfg.miniAppEnabled) rows.push([bot.appButton('📱 Открыть в приложении')]);
  rows.push(backRow());
  return bot.send(userId, {
    text: list.length ? '🏠 **Мои адреса**\nВыберите адрес, чтобы просмотреть данные дома, сведения о соседях и настройки уведомлений.' : '🏠 **Мои адреса**\nАдресов пока нет. Добавьте адрес, чтобы получать уведомления об отключениях у соседей.',
    buttons: rows,
  });
}

/**
 * Услуги, за которые обычно платят напрямую поставщику, а не УК: мусор — региональному оператору,
 * газ и свет — газовой и энергосбытовой компании. Поставщик не указан — УК в заявление не подставляем.
 */
const DIRECT_SUPPLIER: ReadonlySet<ServiceKey> = new Set<ServiceKey>(['waste_off', 'gas_off', 'electricity_off']);

/**
 * Кто делает перерасчёт по услуге — по карточке дома: поставщик услуги, а если он указан как «УК»
 * (или не указан — кроме мусора, газа и света) — управляющая организация. null — данных нет, спросим жителя.
 */
export function executorFromHouse(info: HouseInfo, service: ServiceKey): { name: string; type: ExecutorType } | null {
  const bySupplier: Partial<Record<ServiceKey, string | undefined>> = {
    hot_water_off: info.rsoHeat,
    hot_water_temp: info.rsoHeat,
    heating_temp: info.rsoHeat,
    heating_off: info.rsoHeat,
    cold_water_off: info.rsoWater,
    sewerage_off: info.rsoWater,
    electricity_off: info.rsoPower,
    gas_off: info.rsoGas,
    waste_off: info.rop,
  };
  const supplier = bySupplier[service]?.trim();
  const viaUk = !!supplier && /^(ук|тсж|жск|управляющая)/i.test(supplier);
  if (supplier && !viaUk) return { name: supplier, type: service === 'waste_off' ? 'rop' : 'rso' };
  if (!supplier && DIRECT_SUPPLIER.has(service)) return null;
  if (info.ukName) return { name: info.ukName, type: 'uk' };
  return null;
}

/** Юридическая информация о доме — строки для карточки. */
export function houseInfoLines(bot: Vernem, house: House): string[] {
  const i = bot.db.houseInfo(house);
  const lines: string[] = [];
  if (i.ukName) lines.push(`УК / ТСЖ: ${i.ukName}${i.ukInn ? `, ИНН ${i.ukInn}` : ''}`);
  if (i.adsPhone) lines.push(`📞 Аварийная служба: ${i.adsPhone}`);
  if (i.ukEmail) lines.push(`✉️ Почта УК: ${i.ukEmail}`);
  const rso = [
    i.rsoHeat && `тепло и горячая вода: ${i.rsoHeat}`,
    i.rsoWater && `холодная вода: ${i.rsoWater}`,
    i.rsoPower && `свет: ${i.rsoPower}`,
    i.rsoGas && `газ: ${i.rsoGas}`,
    i.rop && `мусор: ${i.rop}`,
  ].filter(Boolean);
  if (rso.length) lines.push(`Поставщики: ${rso.join('; ')}`);
  if (i.gji) lines.push(`Жилинспекция: ${i.gji}`);
  if (lines.length && i.updatedAt) lines.push(`_Данные внесены жителями ${formatDate(new Date(i.updatedAt), house.tz)}. Сверьте их с квитанцией._`);
  return lines;
}

/**
 * Поля карточки, которые попадают в документы: их изменения видны всем жителям дома.
 * Карточка общая (её заполняют жители по квитанции), поэтому каждое изменение записывается — кто, когда и что было.
 */
export const HOUSE_FIELD_TITLE: Partial<Record<keyof HouseInfo, string>> = {
  ukName: 'УК / ТСЖ',
  ukInn: 'ИНН УК',
  ukAddress: 'адрес УК',
  ukEmail: 'почта УК',
  adsPhone: 'телефон аварийной службы',
  rsoHeat: 'поставщик тепла и горячей воды',
  rsoWater: 'поставщик воды',
  rsoPower: 'поставщик света',
  rsoGas: 'поставщик газа',
  rop: 'оператор по вывозу мусора',
  gji: 'жилинспекция',
};

export type HouseChange = { key: string; title: string; prev: string; value: string };

/** Сохраняет карточку дома и возвращает изменения уже заполненных полей (новые пустые поля — не изменения). */
export function saveHouseInfo(db: Db, houseId: number, userId: number, next: HouseInfo, now: Date): HouseChange[] {
  const prev = db.houseInfo(db.getHouse(houseId)!);
  const fieldsBy = { ...(prev.fieldsBy ?? {}) };
  const changes: HouseChange[] = [];
  for (const [key, title] of Object.entries(HOUSE_FIELD_TITLE)) {
    const a = String((prev as Record<string, unknown>)[key] ?? '');
    const b = String((next as Record<string, unknown>)[key] ?? '');
    if (a === b) continue;
    fieldsBy[key] = { by: userId, at: now.toISOString(), ...(a ? { prev: a } : {}) };
    if (a) changes.push({ key, title: title!, prev: a, value: b });
  }
  db.setHouseInfo(houseId, { ...next, fieldsBy, updatedAt: now.toISOString(), updatedBy: userId });
  return changes;
}

/** Соседи узнают, что кто-то изменил уже заполненные данные дома: они попадают в их заявления. */
export async function tellHouseInfoChanged(bot: Vernem, userId: number, houseId: number, changes: HouseChange[]) {
  const house = bot.db.getHouse(houseId);
  if (!changes.length || !house || house.demo) return;
  const lines = changes.map((c) => `${c.title}: было «${clean(c.prev)}», стало ${c.value ? `«${clean(c.value)}»` : 'пусто'}`);
  for (const u of bot.db.houseSubscribers(houseId)) {
    if (u.id === userId) continue;
    await bot.safeSend(u.id, {
      text: [`🏠 Сосед изменил данные дома ${house.address}:`, ...lines, 'Эти сведения указываются в заявлениях. При ошибке исправьте их по квитанции.'].join('\n'),
      buttons: [[bot.cfg.miniAppEnabled ? bot.appButton('✏️ Данные дома', `house_${houseId}`) : cb('🏠 Карточка дома', `hs:card:${houseId}`)]],
    });
  }
}

/** Почту УК недавно поменял другой житель — перед отправкой заявления на неё стоит проверить адрес. */
export function ukEmailChangedByOther(info: HouseInfo, userId: number, now: Date): string | null {
  const f = info.fieldsBy?.ukEmail;
  if (!f || !f.prev || f.by === userId) return null;
  return hoursBetween(new Date(f.at), now) <= 7 * 24 ? f.at : null;
}

export function showHouseCard(bot: Vernem, userId: number, houseId: number) {
  bot.db.setState(userId, 'idle');
  const h = bot.db.getUserHouse(userId, houseId);
  if (!h) return bot.stale(userId);
  const info = houseInfoLines(bot, h);
  const dispatchers = bot.db.listDispatchers(h.id);
  return bot.send(userId, {
    text: [
      `🏠 **${h.address}**${h.entrance ? `, подъезд ${h.entrance}` : ''}`,
      ...(info.length ? info : ['Данных о доме пока нет. Заполните их по квитанции: сведения будут доступны соседям и указаны в заявлениях.']),
      '',
      `В сети дома: ${members(bot, h.id)}. Уведомления ${h.notify ? 'включены' : 'выключены'}.`,
      dispatchers.length
        ? `🏢 Заявки в боте принимает УК: ${dispatcherNames(bot, h.id)}`
        : '🏢 УК не подключена к боту. Пригласите её, чтобы направлять заявки через бот.',
    ].join('\n'),
    buttons: [
      [bot.cfg.miniAppEnabled ? bot.appButton('✏️ Данные дома', `house_${h.id}`) : cb('✏️ Данные дома', `hs:info:${h.id}`), cb('📨 Позвать соседей', `hs:invite:${h.id}`)],
      [cb(h.notify ? '🔕 Без уведомлений' : '🔔 Уведомлять', `hs:notify:${h.id}`), cb('🚪 Подъезд', `hs:ent:${h.id}`)],
      [cb('🏢 Пригласить УК в бот', `hs:uk:${h.id}`)],
      // Любой житель может отключить сотрудника, если это не их УК.
      ...dispatchers.map((d) => [cb(`🚫 Отключить: ${clean(d.title)}`.slice(0, 64), `dsr:${h.id}:${d.id}`)]),
      [cb('🗑 Убрать адрес', `hs:rm:${h.id}`), cb('⬅️ Мои адреса', 'house')],
    ],
  });
}

/** Поля карточки дома, которые можно заполнить прямо в чате (остальные — в приложении). */
const INFO_FIELDS: { key: keyof HouseInfo; ask: string }[] = [
  { key: 'ukName', ask: 'Укажите название УК или ТСЖ, как в квитанции в строке получателя за «содержание жилья».' },
  { key: 'ukInn', ask: 'Укажите ИНН УК. Он состоит из 10 цифр и указан в квитанции.' },
  { key: 'adsPhone', ask: 'Укажите телефон аварийной службы из квитанции или с информационной доски в подъезде.' },
  { key: 'rsoHeat', ask: 'Укажите получателя платы за отопление и горячую воду, например: «АО Теплосеть». Если это УК, укажите «УК».' },
];

export async function onHouseButton(bot: Vernem, userId: number, action: string, houseId: number): Promise<unknown> {
  if (action === 'add') return askAddressText(bot, userId, {});
  const h = bot.db.getUserHouse(userId, houseId);
  if (!h) return bot.stale(userId);
  switch (action) {
    case 'card':
      bot.db.addUserHouse(userId, h.id);
      return showHouseCard(bot, userId, h.id);
    case 'ent':
      return askEntrance(bot, userId, h.id, {});
    case 'notify':
      bot.db.setUserHouse(userId, h.id, { notify: h.notify ? 0 : 1 });
      return showHouseCard(bot, userId, h.id);
    case 'rm':
      return bot.send(userId, { text: `Удалить адрес «${h.address}» из списка? Обращения по этому адресу сохранятся.`, buttons: [[cb('🗑 Да, удалить', `hs:rmy:${h.id}`), cb('Отмена', `hs:card:${h.id}`)]] });
    case 'rmy':
      bot.db.removeUserHouse(userId, h.id);
      return showAddresses(bot, userId);
    case 'info':
      return askInfo(bot, userId, h.id, 0);
    case 'uk':
      return sendDispatchInvite(bot, userId, h.id);
    case 'invite': {
      bot.db.track(userId, 'house_invite', { house: h.id });
      const url = inviteLink(bot, h);
      await bot.send(userId, { text: 'Перешлите сообщение ниже соседям или в чат дома.' });
      return bot.send(userId, {
        // Ссылка в тексте: при пересылке MAX убирает кнопки, а ссылка продолжает работать.
        text: [`🏠 **Сеть дома ${h.address}**`, 'При отключении воды, света или тепла бот «Вернём» уведомит соседей и поможет подготовить заявление о перерасчёте.', `👉 Подключиться: ${url}`].join('\n'),
        buttons: [[link('🏠 Подключиться', url)]],
      });
    }
  }
  return bot.stale(userId);
}

function askInfo(bot: Vernem, userId: number, houseId: number, idx: number) {
  if (idx >= INFO_FIELDS.length) {
    bot.db.setState(userId, 'idle');
    return showHouseCard(bot, userId, houseId);
  }
  bot.db.setState(userId, 'await_house_info', { houseId, idx });
  return bot.send(userId, { text: `${idx + 1}/${INFO_FIELDS.length}. ${INFO_FIELDS[idx].ask}`, buttons: [[cb('Пропустить', `hsi:${houseId}:${idx}`), cb('Готово', `hs:card:${houseId}`)]] });
}

export async function onHouseInfoText(bot: Vernem, userId: number, text: string, data: { houseId: number; idx: number }) {
  const h = bot.db.getUserHouse(userId, data.houseId);
  if (!h) return bot.stale(userId);
  const field = INFO_FIELDS[data.idx];
  const value = clean(text).replace(/\s+/g, ' ').slice(0, 150);
  const innErr = field.key === 'ukInn' ? innProblem(value) : null;
  if (innErr) return bot.send(userId, { text: `${innErr}.`, buttons: [[cb('Пропустить', `hsi:${h.id}:${data.idx}`)]] });
  // Телефон видят все соседи и нажимают «позвонить» — только цифры, иначе ссылка не сработает.
  if (field.key === 'adsPhone' && (value.replace(/\D/g, '').length < 3 || /[^\d\s+()\-.]/.test(value))) {
    return bot.send(userId, { text: 'Укажите телефон цифрами, например: +7 495 123-45-67 или 112.', buttons: [[cb('Пропустить', `hsi:${h.id}:${data.idx}`)]] });
  }
  const changes = saveHouseInfo(bot.db, h.id, userId, { ...bot.db.houseInfo(h), [field.key]: value }, bot.now());
  bot.db.track(userId, 'house_info', { house: h.id, field: field.key });
  await tellHouseInfoChanged(bot, userId, h.id, changes);
  return askInfo(bot, userId, h.id, data.idx + 1);
}

export function onHouseInfoSkip(bot: Vernem, userId: number, houseId: number, idx: number) {
  const { state, data } = bot.db.getState<{ houseId: number; idx: number }>(userId);
  if (state !== 'await_house_info' || data.houseId !== houseId || data.idx !== idx) return bot.stale(userId);
  return askInfo(bot, userId, houseId, idx + 1);
}

/** Переход по ссылке-приглашению в сеть дома. */
export async function joinHouseByCode(bot: Vernem, userId: number, code: string) {
  const house = bot.db.getHouseByCode(code);
  if (!house) return bot.send(userId, { text: 'Ссылка на дом не найдена. Добавьте адрес в разделе «🏠 Мои адреса».', buttons: bot.menu() });
  const had = bot.db.getUserHouse(userId, house.id);
  bot.db.addUserHouse(userId, house.id);
  bot.db.track(userId, 'house_joined', { house: house.id });
  const open = bot.db.listOpenIncidents(house.id).slice(0, 3);
  await bot.send(userId, {
    text: [`✅ Вы подключены к сети дома **${house.address}**. Участников: ${members(bot, house.id)}.`, 'При сообщении соседей об отключении вы получите уведомление.', open.length ? '\nТекущие отключения:' : '']
      .filter(Boolean)
      .join('\n'),
    buttons: open.length
      ? open.map((i) => [cb(`${ICON[i.service_key]} ${bot.norms.services[i.service_key].button} с ${formatShort(new Date(i.started_at), house.tz)}: у меня тоже`.slice(0, 64), `jn:${i.id}`)])
      : undefined,
  });
  if (!had?.entrance) return askEntrance(bot, userId, house.id, {});
  return showHouseCard(bot, userId, house.id);
}

// ---------------------------------------------------------------------
// Уведомления соседей
// ---------------------------------------------------------------------

/** Ставит в очередь уведомления всем подписанным жителям дома и сразу отправляет дневные. */
export async function queueHouseAlerts(bot: Vernem, incident: Incident): Promise<number> {
  if (incident.demo) return 0;
  const house = bot.db.getHouse(incident.house_id);
  if (!house) return 0;
  // Ночью (23:00–08:00) не будим: уведомление уйдёт в 08:00, время начала отключения от этого не меняется.
  const due = bot.quietShift(bot.now(), house.tz);
  const inCase = new Set(bot.db.listParticipants(incident.id).map((p) => p.user_id));
  let n = 0;
  for (const u of bot.db.houseSubscribers(house.id)) {
    if (inCase.has(u.id)) continue;
    bot.db.queueAlert(incident.id, u.id, due);
    n++;
  }
  if (n) bot.db.track(incident.reporter_user_id, 'alerts_queued', { incident: incident.id, n });
  await flushAlerts(bot);
  return n;
}

/** Отправляет наступившие уведомления. Вызывается при фиксации отключения и планировщиком. Не дошло — повторим через 10 минут. */
export async function flushAlerts(bot: Vernem): Promise<number> {
  let sent = 0;
  for (const a of bot.db.takeDueAlerts(bot.now())) {
    try {
      if (await sendAlert(bot, a)) sent++;
    } catch (e) {
      const again = bot.db.retryAlert(a.id, new Date(bot.now().getTime() + 10 * 60_000));
      console.error(`[house] уведомление ${a.id} не доставлено${again ? ', повторю' : ', попытки кончились'}`, e);
    }
  }
  return sent;
}

async function sendAlert(bot: Vernem, alert: Alert): Promise<boolean> {
  const incident = bot.db.getIncident(alert.incident_id);
  if (!incident) return false;
  // Житель мог сам отметить то же отключение, отписаться или убрать адрес, пока уведомление ждало утра.
  const mine = bot.db.getUserHouse(alert.user_id, incident.house_id);
  if (!mine || !mine.notify) return false;
  if (bot.db.getParticipantFor(incident.id, alert.user_id)) return false;
  const house = bot.db.getHouse(incident.house_id)!;
  const norm = bot.norms.services[incident.service_key];
  const what = norm.kind === 'interruption' ? `нет ${norm.genitive}` : norm.button.toLowerCase();
  const ended = incident.ended_at ? new Date(incident.ended_at) : null;
  // send, а не safeSend: если MAX не принял сообщение, flushAlerts вернёт уведомление в очередь.
  await bot.send(alert.user_id, {
    text: [
      `🚨 **${house.address}${incident.entrance ? `, подъезд ${incident.entrance}` : ''}: ${what}**`,
      `с ${formatShort(new Date(incident.started_at), house.tz)}${ended ? ` по ${formatShort(ended, house.tz)}` : ''}${incident.ads_number && incident.evidence === 'ads' ? `, заявка № ${clean(incident.ads_number)}` : ''}.`,
      ended ? 'Нарушение затронуло и вас? Будет подготовлен расчёт перерасчёта.' : 'Нарушение затронуло и вас? После подтверждения время будет сохранено.',
    ].join('\n'),
    buttons: [[cb('✅ У меня тоже', `al:${alert.id}:y`), cb('Нет', `al:${alert.id}:n`)], [cb('🔕 Не присылать по этому дому', `al:${alert.id}:off`)]],
  });
  bot.db.track(alert.user_id, 'alert_sent', { incident: incident.id });
  return true;
}

export async function onAlertAnswer(bot: Vernem, userId: number, alertId: number, answer: string) {
  const alert = bot.db.getAlert(alertId);
  if (!alert || alert.user_id !== userId) return bot.stale(userId);
  const incident = bot.db.getIncident(alert.incident_id);
  if (!incident) return bot.stale(userId);
  if (answer === 'y') {
    // Старое уведомление: отключение давно закончилось — присоединиться уже нельзя (как и по ссылке).
    const mine = bot.db.getParticipantFor(incident.id, userId);
    if (mine) return bot.showCase(userId, mine.id);
    if (incident.ended_at && hoursBetween(new Date(incident.ended_at), bot.now()) > 24 * 45) {
      return bot.send(userId, { text: 'Это отключение закончилось больше полутора месяцев назад, присоединиться уже нельзя.', buttons: bot.menu() });
    }
    bot.db.answerAlert(alert.id, 'yes');
    bot.db.track(userId, 'alert_yes', { incident: incident.id });
    return bot.joinIncident(userId, incident);
  }
  if (answer === 'n') {
    bot.db.answerAlert(alert.id, 'no');
    bot.db.track(userId, 'alert_no', { incident: incident.id });
    return bot.send(userId, { text: 'Ответ учтён.', buttons: bot.menu() });
  }
  if (answer === 'off') {
    bot.db.answerAlert(alert.id, 'off');
    bot.db.setUserHouse(userId, incident.house_id, { notify: 0 });
    return bot.send(userId, { text: 'Уведомления по этому дому отключены. Их можно включить в разделе «🏠 Мои адреса».', buttons: bot.menu() });
  }
  return bot.stale(userId);
}
