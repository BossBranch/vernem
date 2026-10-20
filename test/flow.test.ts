import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Harness } from '../src/sim/harness.ts';
import { fromLocal } from '../src/calc/time.ts';
import { actDocFor, calcFor, claimDocFor, claimTextFor, loadCase, summarize } from '../src/services/cases.ts';
import { claimToPdf } from '../src/docs/pdf.ts';
import { buildActDoc } from '../src/docs/act.ts';
import { claimToText } from '../src/docs/claim.ts';

const TZ = 'Europe/Moscow';
const START = fromLocal(2026, 9, 22, 12, 0, TZ); // вторник, 12:00 МСК
const H = 3_600_000;

const textOf = (h: Harness, user: number, since = 0) =>
  h
    .sentTo(user, since)
    .map((m) => m.text)
    .join('\n---\n');

/** Кнопки последнего сообщения с кнопками. */
const lastButtons = (h: Harness, user: number) => [...h.sentTo(user)].reverse().find((m) => m.buttons?.length)?.buttons?.flat() ?? [];

/**
 * Житель пишет адрес: если дом уже есть в списке — выбирает его, иначе добавляет новый.
 * Подъезд пропускает (или указывает entrance).
 */
async function typeAddress(h: Harness, user: number, address: string, entrance?: string, city = 'Москва') {
  const st = h.db.getState<{ city?: string }>(user);
  if (st.state === 'await_address' && st.data.city !== city) await h.press(user, 'Другой город');
  if (h.db.getState(user).state === 'await_city') {
    if (lastButtons(h, user).some((b) => b.text === city)) await h.press(user, city);
    else {
      await h.press(user, '✏️ Другой город');
      await h.text(user, city);
    }
  }
  await h.text(user, address);
  const existing = lastButtons(h, user).find((b) => b.text.startsWith('🏠'));
  await h.press(user, existing ? existing.text : 'Моего дома нет');
  if (lastButtons(h, user).some((b) => b.type === 'callback' && b.payload === 'ent:skip')) await h.press(user, entrance ?? 'Пропустить');
}

/** Текст заявления по делу жителя (в чат бот шлёт только PDF). */
function claimText(h: Harness, user: number, idx = 0) {
  const p = h.db.listUserParticipants(user)[idx];
  return claimTextFor(h.db, h.bot.norms, loadCase(h.db, p.id)!, h.now());
}

async function reportHotWater(h: Harness, user: number, address = 'ул. Примерная, д. 5') {
  await h.start(user);
  await h.press(user, 'Что-то сломалось');
  await h.press(user, 'Нет горячей воды');
  if (!h.db.listUserHouses(user).length) await typeAddress(h, user, address);
  await h.press(user, 'Внезапно');
  await h.press(user, 'Позвонил');
  await h.text(user, '4512');
  await h.press(user, 'Ввести время');
  await h.text(user, '20.09 08:10');
}

test('основной сценарий: фиксация → напоминание → расчёт → заявление → перерасчёт', async () => {
  const h = new Harness({ start: START });
  await reportHotWater(h, 1);
  assert.match(textOf(h, 1), /Записал\./);
  assert.match(textOf(h, 1), /заявка № 4512/);

  // Через 3 часа бот сам спрашивает, дали ли воду.
  const mark = h.out.log.length;
  assert.equal(await h.advance(3 * H), 1);
  assert.match(textOf(h, 1, mark), /Починили\?/);

  await h.press(1, 'Да, восстановили');
  await h.press(1, 'Только что'); // 22.09 15:00 → 54 ч 50 мин, превышение 46 ч
  assert.match(textOf(h, 1), /Сколько начислено/);
  await h.text(1, '1 200');
  const calc = textOf(h, 1);
  assert.match(calc, /46 × 0,15% = 6,9%/);
  assert.match(calc, /Положено ≈ 82,80 ₽/);

  await h.press(1, 'УК / ТСЖ');
  await h.text(1, 'Иванов Иван Иванович');
  await h.text(1, '42');
  await h.text(1, '1234567890');
  await h.press(1, 'Пропустить');
  const before = h.out.log.length;
  await h.press(1, 'Не сохранять');

  // В чат — только PDF с короткой подписью, без полотна текста.
  const msgs = h.sentTo(1, before);
  const pdf = msgs.find((m) => m.file)?.file;
  assert.ok(pdf && existsSync(pdf.path), 'PDF отправлен');
  assert.equal(readFileSync(pdf!.path).subarray(0, 4).toString(), '%PDF');
  assert.match(msgs.map((m) => m.text).join('\n'), /Заявление готово.*82,80 ₽/);
  assert.doesNotMatch(msgs.map((m) => m.text).join('\n'), /ЗАЯВЛЕНИЕ О ПЕРЕРАСЧЁТЕ/);

  // «Не сохранять»: персональные данные стёрты из БД; в документе — реквизиты по форме.
  const p = h.db.listUserParticipants(1)[0];
  assert.equal(p.status, 'claim_ready');
  assert.ok(!p.claim!.includes('Иванов'));
  assert.equal(h.db.getUser(1)!.fio, null);
  const doc = claimText(h, 1);
  assert.match(doc, /ЗАЯВЛЕНИЕ О ПЕРЕРАСЧЁТЕ/);
  assert.match(doc, /№ 4512/);
  assert.match(
    doc,
    /Я сообщил\(а\) о нарушении предоставления коммунальной услуги «Горячее водоснабжение» в аварийно-диспетчерскую службу исполнителя \(п\. 105 Правил\)\. Сообщение зарегистрировано под № 4512, время регистрации — 20\.09\.2026 08:10 \(п\. 106 Правил\)\. С этого времени исчисляется период нарушения \(п\. 111 Правил\)\./,
  );
  assert.match(doc, /п\. 4 Приложения № 1/);
  assert.match(doc, /телефон, e-mail/);
  assert.match(doc, /Заявитель: /);
  assert.match(doc, /адрес: г\. Москва, ул\. Примерная, д\. 5/);
  assert.match(doc, /Руководителю управляющей организации/);
  assert.match(doc, /Отметка о принятии/);

  // Подал заявление — с этой даты бот ждёт квитанцию.
  await submitClaim(h, 1);
  assert.match(h.last(1).text, /Записал: подано 22\.09\.2026/);

  // Через месяц — вопрос о квитанции.
  const mark2 = h.out.log.length;
  await h.advance(31 * 24 * H);
  assert.match(textOf(h, 1, mark2), /Пришла новая квитанция/);
  await h.press(1, 'Да, вернули');
  await h.text(1, '82,80');
  assert.match(textOf(h, 1), /Всего вы вернули с ботом: \*\*82,80 ₽\*\*/);
  assert.equal(h.db.listUserParticipants(1)[0].status, 'refunded');

  const funnel = h.db.funnel();
  for (const k of ['start', 'report_started', 'fixed', 'restored', 'calc_done', 'claim_created', 'refund_yes']) assert.equal(funnel[k], 1, k);
  h.close();
});

test('два отключения в одном месяце: лимит общий, деньги не считаются дважды', async () => {
  const h = new Harness({ start: START });
  await reportHotWater(h, 1); // 20.09 08:10
  await h.advance(3 * H);
  await h.press(1, 'Да, восстановили');
  await h.press(1, 'Только что'); // 22.09 15:00 → 54 ч 50 мин, превышение 46 ч → 6,9%
  // Второе отключение того же дня недели позже: 23.09 08:00–13:00.
  await h.advance(17 * H);
  await h.start(1);
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет горячей воды');
  await h.press(1, 'Внезапно');
  await h.press(1, 'Позвонил');
  await h.text(1, '4600');
  await h.press(1, 'Только что');
  await h.advance(5 * H);
  await h.press(1, 'Воду дали');
  await h.press(1, 'Только что');
  const [second, first] = h.db.listUserParticipants(1);
  assert.equal(calcFor(h.db, h.bot.norms, loadCase(h.db, first.id)!, h.now()).months[0].percent, 6.9);
  const m = calcFor(h.db, h.bot.norms, loadCase(h.db, second.id)!, h.now()).months[0];
  // Вместе: 59 ч 50 мин, превышение 51 ч → 7,65%; из них 6,9% уже положены по первому → 0,75%.
  assert.equal(m.percent, 0.75);
  const text = m.lines.join(' ');
  assert.match(text, /Допустимая продолжительность 8 ч установлена на месяц, поэтому учтён также предыдущий перерыв/);
  assert.match(text, /Из них 6,9% приходится на предыдущий перерыв \(заявлено отдельно\); по данному перерыву — 0,75%/);
  h.close();
});

test('соседи: карточка со ссылкой в тексте → присоединение → общее окончание', async () => {
  const h = new Harness({ start: START });
  await reportHotWater(h, 1);
  await h.press(1, 'Позвать соседей');
  const card = h.out.log.flatMap((r) => (r.msg.buttons ?? []).flat()).find((b) => b.type === 'link' && b.url.includes('?start=j_'));
  assert.ok(card && card.type === 'link');
  assert.match(card.url, /^https:\/\/max\.ru\/vernem_demo_bot\?start=j_/);
  // При пересылке кнопки пропадают — ссылка должна быть и в тексте карточки.
  assert.ok(textOf(h, 1).includes(card.url), 'ссылка продублирована в тексте');
  const payload = new URL(card.url).searchParams.get('start')!;
  assert.ok(payload.length <= 128);

  await h.start(2, payload);
  assert.match(textOf(h, 2), /у вас то же самое/);
  await h.press(2, 'Да, у меня тоже');
  assert.match(textOf(h, 2), /Есть свой номер заявки/);
  assert.match(textOf(h, 1), /Присоединился сосед\. Вас уже 2/);
  assert.equal(h.db.getUser(2)!.house_id, h.db.getUser(1)!.house_id);
  assert.equal(h.db.listUserHouses(2).length, 1, 'дом соседа попал в его адреса');

  await h.press(2, 'Ввести свой номер');
  await h.text(2, '4513');

  await h.advance(1 * H);
  await h.press(1, 'Воду дали');
  await h.press(1, 'Только что');
  assert.match(textOf(h, 2), /Сосед отметил/);
  await h.press(2, 'Да');
  assert.match(textOf(h, 2), /Сколько начислено/);
  const p2 = h.db.listUserParticipants(2)[0];
  assert.equal(p2.own_ads_number, '4513');
  assert.equal(p2.ended_at, h.db.listUserParticipants(1)[0].ended_at);
  h.close();
});

test('адрес выбирается из списка: сосед, написавший иначе, попадает в тот же дом', async () => {
  const h = new Harness({ start: START });
  await reportHotWater(h, 1, 'ул. Примерная, д. 5');
  await h.start(3);
  await h.press(3, 'Что-то сломалось');
  await h.press(3, 'Нет горячей воды');
  await h.press(3, 'Москва');
  await h.text(3, '5 примерная');
  assert.match(h.last(3).text, /Выберите свой дом/);
  await h.press(3, '🏠 Москва, ул. Примерная, д. 5');
  await h.press(3, 'Пропустить');
  assert.match(textOf(h, 3), /Соседи уже сообщили/);
  await h.press(3, 'Да, присоединиться');
  assert.equal(h.db.listUserParticipants(3)[0].role, 'neighbour');
  assert.equal(h.db.db.prepare('SELECT COUNT(*) AS n FROM houses WHERE demo = 0').get()!.n, 1, 'дубля дома нет');
  h.close();
});

test('несколько адресов: бот спрашивает «Где?», подъезд — у каждого адреса свой', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Мои адреса');
  await h.press(1, 'Добавить адрес');
  await typeAddress(h, 1, 'Ленина 3', '4');
  await h.press(1, 'Мои адреса');
  await h.press(1, 'Добавить адрес');
  await typeAddress(h, 1, 'Садовая 10', '1');
  assert.deepEqual(
    h.db.listUserHouses(1).map((x) => [x.address, x.entrance]),
    [
      ['Москва, Ленина 3', '4'],
      ['Москва, Садовая 10', '1'],
    ],
  );
  await h.press(1, 'Меню');
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет газа');
  assert.match(h.last(1).text, /Где случилось/);
  await h.press(1, '📍 Москва, Садовая 10');
  await h.press(1, 'Позвонил');
  await h.text(1, '7');
  await h.press(1, 'Только что');
  const inc = h.db.getIncident(h.db.listUserParticipants(1)[0].incident_id)!;
  assert.equal(h.db.getHouse(inc.house_id)!.address, 'Москва, Садовая 10');
  assert.equal(inc.entrance, '1');
  h.close();
});

test('город: одна и та же улица в разных городах — разные дома, часовой пояс по городу', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Мои адреса');
  await h.press(1, 'Добавить адрес');
  await typeAddress(h, 1, 'Садовая 10');
  await h.start(2);
  await h.press(2, 'Мои адреса');
  await h.press(2, 'Добавить адрес');
  assert.match(h.last(2).text, /В каком городе/);
  await h.press(2, '✏️ Другой город');
  await h.text(2, 'г. екатеринбург');
  assert.match(h.last(2).text, /Екатеринбург/);
  await h.text(2, 'Садовая 10');
  assert.doesNotMatch(h.last(2).text, /Выберите свой дом/, 'московский дом в Екатеринбурге не предлагается');
  await h.press(2, 'Моего дома нет');
  const ekb = h.db.listUserHouses(2)[0];
  assert.equal(ekb.address, 'Екатеринбург, Садовая 10');
  assert.equal(ekb.tz, 'Asia/Yekaterinburg');
  assert.notEqual(ekb.id, h.db.listUserHouses(1)[0].id);
  // Второй раз свой город предлагается кнопкой.
  await h.press(2, 'Пропустить');
  await h.press(2, 'Мои адреса');
  await h.press(2, 'Добавить адрес');
  assert.ok(lastButtons(h, 2).some((b) => b.text === 'Екатеринбург'));
  h.close();
});

test('карточка дома: данные из квитанции, телефон аварийки в подсказке, получатель в заявлении', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Мои адреса');
  await h.press(1, 'Добавить адрес');
  await typeAddress(h, 1, 'ул. Примерная, д. 5');
  await h.press(1, 'Данные дома');
  await h.text(1, 'ООО "УК Пример"');
  await h.text(1, '7700000009');
  await h.text(1, '+7 495 000-00-00');
  await h.text(1, 'УК');
  const card = h.last(1).text;
  assert.match(card, /УК \/ ТСЖ: ООО "УК Пример", ИНН 7700000009/);
  assert.match(card, /Аварийная служба: \+7 495 000-00-00/);
  assert.match(card, /Данные внесли жители/);

  await h.press(1, 'Меню');
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет горячей воды');
  await h.press(1, 'Внезапно');
  assert.match(h.last(1).text, /Позвоните в аварийную службу\*\*: \+7 495 000-00-00/);
  await h.press(1, 'Позвонил');
  await h.text(1, '1');
  await h.press(1, 'Ввести время');
  await h.text(1, '20.09 08:10');
  await h.press(1, 'Воду дали');
  await h.press(1, 'Только что');
  await h.text(1, '1000');
  assert.match(h.last(1).text, /Заявление — в «ООО "УК Пример"» \(из карточки дома\)/);
  await h.press(1, 'Да');
  await h.text(1, 'Иванов Иван Иванович');
  await h.text(1, '5');
  await h.press(1, 'Пропустить'); // лицевой счёт; получателя уже не спрашиваем
  await h.press(1, 'Не сохранять');
  const doc = claimText(h, 1);
  assert.match(doc, /Руководителю ООО "УК Пример"/);
  assert.match(doc, /ИНН 7700000009/);
  h.close();
});

test('получатель из карточки дома: за мусор, газ и свет без поставщика УК не подставляется', async () => {
  const { executorFromHouse } = await import('../src/bot/house.ts');
  const info = { ukName: 'ООО «УК Пример»', ukInn: '7700000009' };
  for (const s of ['waste_off', 'gas_off', 'electricity_off'] as const) assert.equal(executorFromHouse(info, s), null, s);
  assert.deepEqual(executorFromHouse(info, 'hot_water_off'), { name: 'ООО «УК Пример»', type: 'uk' });
  assert.deepEqual(executorFromHouse({ ...info, rsoPower: 'УК' }, 'electricity_off'), { name: 'ООО «УК Пример»', type: 'uk' });
  assert.deepEqual(executorFromHouse({ ...info, rop: 'ООО «Экоцентр»' }, 'waste_off'), { name: 'ООО «Экоцентр»', type: 'rop' });
});

test('отопление: угловая комната, +15 °C, новый замер, расчёт', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Холодно в квартире');
  await typeAddress(h, 1, 'пр-т Мира, 12');
  await h.press(1, 'Угловая');
  await h.text(1, '15');
  await h.press(1, 'Позвонил');
  await h.text(1, 'А-77');
  await h.press(1, 'Только что');
  await h.advance(5 * H);
  await h.press(1, 'Новый замер');
  await h.text(1, '17,5');
  assert.match(textOf(h, 1), /Последний замер: \+17,5 °C/);
  await h.advance(5 * H);
  await h.press(1, 'Стало тепло');
  await h.press(1, 'Только что');
  await h.press(1, 'Не знаю — посчитать в процентах');
  // 12:00–17:00 при +15 (норма +20): 5 × 5 = 25; 17:00–22:00 при +17,5: 5 × 2,5 = 12,5 → 37,5 × 0,15% = 5,63%
  assert.match(textOf(h, 1), /5,63%/);
  h.close();
});

test('отопление: сосед с угловой комнатой присоединяется при +19 °C (норма для него +20 °C)', async () => {
  const h = new Harness({ start: START });
  await h.start(2);
  await h.press(2, 'Мои адреса');
  await h.press(2, 'Добавить адрес');
  await typeAddress(h, 2, 'пр-т Мира, 12');
  await h.start(1);
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Холодно в квартире');
  await typeAddress(h, 1, 'пр-т Мира, 12');
  await h.press(1, 'Обычная');
  await h.text(1, '16');
  await h.press(1, 'Позвонил');
  await h.text(1, 'Б-1');
  await h.press(1, 'Только что');
  await h.press(2, 'У меня тоже');
  assert.match(h.last(2).text, /Ваша комната угловая/);
  await h.press(2, 'Угловая');
  await h.text(2, '19');
  const p2 = h.db.listUserParticipants(2)[0];
  assert.ok(p2, 'сосед присоединился: для угловой комнаты +19 °C ниже нормы');
  assert.equal(p2.corner, 1);
  h.close();
});

test('температура в норме: бот не обрывает сценарий, можно ввести новый замер', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Холодно в квартире');
  await typeAddress(h, 1, 'Ленина 3');
  await h.press(1, 'Обычная');
  await h.text(1, '19');
  assert.match(h.last(1).text, /это норма/);
  assert.equal(h.db.listUserParticipants(1).length, 0);
  await h.text(1, '16'); // замер в другой комнате
  assert.match(h.last(1).text, /Позвоните в аварийную службу/);
  h.close();
});

test('плановое отключение горячей воды: в срок — денег нет, не дали в срок — перерыв со срока окончания работ', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет горячей воды');
  await typeAddress(h, 1, 'Ленина 3');
  await h.press(1, 'По плану');
  assert.match(h.last(1).text, /До какого времени объявили отключение/);
  // Срок ещё не прошёл — дела нет.
  await h.text(1, '30.09 18:00');
  assert.match(h.last(1).text, /Пока он не прошёл, снижения платы нет/);
  assert.equal(h.db.listUserParticipants(1).length, 0);

  // Срок прошёл, воду не дали: перерыв считается с 21.09 18:00, раньше — нельзя.
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет горячей воды');
  await h.press(1, 'По плану');
  await h.text(1, '21.09 18:00');
  await h.press(1, 'Не дозвонился');
  await h.press(1, 'Записать время → акт');
  assert.match(h.last(1).text, /Работы объявили до 21\.09 18:00/);
  await h.press(1, 'Ввести время');
  await h.text(1, '21.09 10:00');
  assert.match(h.last(1).text, /шли объявленные работы/);
  await h.press(1, 'когда обещали дать воду');
  const p = h.db.listUserParticipants(1)[0];
  const inc = h.db.getIncident(p.incident_id)!;
  assert.equal(new Date(inc.started_at).getTime(), fromLocal(2026, 9, 21, 18, 0, TZ).getTime());
  assert.ok(inc.planned_until);
  await h.press(1, 'Воду дали');
  await h.press(1, 'Только что');
  assert.match(claimText(h, 1), /Плановое отключение горячего водоснабжения было объявлено до 21\.09\.2026 18:00; в объявленный срок горячее водоснабжение не возобновлено/);
  h.close();
});

test('короткое отключение света — снижения платы не положено', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет света');
  await typeAddress(h, 1, 'Ленина 3');
  await h.press(1, 'Один / не знаю');
  await h.press(1, 'Не дозвонился');
  assert.match(h.last(1).text, /5 минут или перезвонить за 10 \(п\. 13 ПП № 416\)/);
  await h.press(1, 'Записать время → акт');
  await h.press(1, '1 ч назад');
  assert.match(textOf(h, 1), /без номера заявки/);
  await h.press(1, 'Свет дали');
  await h.press(1, 'Только что');
  assert.match(textOf(h, 1), /Снижения платы не положено/);
  assert.doesNotMatch(textOf(h, 1), /Скажите об этом аварийной службе/, 'не дозвонился — в аварийку не отправляем');
  assert.equal(h.db.listUserParticipants(1)[0].status, 'closed');
  h.close();
});

test('ошибки ввода не ломают сценарий', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет холодной воды');
  await h.text(1, '123');
  assert.match(textOf(h, 1), /Название города буквами/);
  await h.text(1, 'москва');
  await h.text(1, 'дом');
  assert.match(textOf(h, 1), /Нужны улица и номер дома/);
  await typeAddress(h, 1, 'Садовая 10');
  await h.press(1, 'Позвонил');
  // «не назвали» — не номер: бот просит цифры и сразу даёт кнопку «Номера нет».
  await h.text(1, 'не назвали');
  assert.match(h.last(1).text, /В номере должны быть цифры/);
  assert.ok(lastButtons(h, 1).some((b) => b.text === 'Номера нет'));
  await h.text(1, '99');
  await h.press(1, 'Ввести время');
  await h.text(1, '25:99');
  assert.match(textOf(h, 1), /Такого времени не бывает/);
  await h.text(1, 'завтра');
  assert.match(textOf(h, 1), /Не понял время/);
  await h.text(1, 'сегодня 10:00');
  assert.match(textOf(h, 1), /Записал\./);
  await h.press(1, 'Воду дали');
  await h.press(1, 'Ввести время');
  await h.text(1, 'сегодня 9:00');
  assert.match(textOf(h, 1), /должно быть позже начала/);
  await h.bot.handle({ kind: 'button', userId: 1, payload: 'cs:99999' });
  assert.match(h.last(1).text, /кнопка уже неактуальна/);
  await h.bot.handle({ kind: 'button', userId: 2, payload: `rest:${h.db.listUserParticipants(1)[0].id}:y` });
  assert.match(h.last(2).text, /кнопка уже неактуальна/, 'чужой случай недоступен');
  h.close();
});

test('демо-режим: сценарий до заявления, настоящий адрес не меняется', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Мои адреса');
  await h.press(1, 'Добавить адрес');
  await typeAddress(h, 1, 'Ленина 3');
  const houseBefore = h.db.getUser(1)!.house_id;
  await h.press(1, 'Меню');
  await h.press(1, 'Демо');
  assert.match(h.last(1).text, /Какой случай показать/);
  await h.press(1, 'Есть номер заявки');
  assert.match(textOf(h, 1), /Демо 1: есть номер заявки/);
  await h.press(1, 'Воду дали');
  await h.press(1, 'Только что');
  await h.text(1, '1200');
  const t = textOf(h, 1);
  assert.match(t, /64 × 0,15% = 9,6%/);
  assert.match(t, /115,20 ₽/);
  await h.press(1, 'Не знаю');
  await h.text(1, 'Петров Пётр Петрович');
  await h.text(1, '7');
  await h.press(1, 'Пропустить');
  await h.press(1, 'Пропустить');
  await h.press(1, 'Запомнить');
  assert.match(claimText(h, 1), /ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ/);
  assert.equal(h.db.getUser(1)!.fio, 'Петров Пётр Петрович');
  assert.equal(h.db.getUser(1)!.house_id, houseBefore, 'демо не перезаписывает адрес');
  assert.deepEqual(
    h.db.listUserHouses(1).map((x) => x.address),
    ['Москва, Ленина 3'],
  );
  h.close();
});

test('домовой чат: /dom привязывает чат, карточка публикуется туда', async () => {
  const h = new Harness({ start: START });
  await h.bot.handle({ kind: 'group_added', chatId: -500, title: 'Дом 5' });
  assert.equal(h.out.log.at(-1)!.to, 'chat');
  await h.bot.handle({ kind: 'group_text', chatId: -500, userId: 1, text: '/dom' });
  assert.match(h.out.log.at(-1)!.msg.text, /Сначала напишите боту/);
  await reportHotWater(h, 1);
  await h.bot.handle({ kind: 'group_text', chatId: -500, userId: 1, text: '/dom@vernem_demo_bot' });
  assert.match(h.out.log.at(-1)!.msg.text, /Чат привязан к дому/);
  await h.press(1, 'Позвать соседей');
  await h.press(1, 'Опубликовать в чате дома');
  const posted = h.out.log.filter((r) => r.to === 'chat' && r.id === -500).at(-1)!;
  assert.match(posted.msg.text, /нет горячей воды/);
  h.out.failChats.add(-500);
  await h.press(1, 'Опубликовать в чате дома');
  assert.match(h.last(1).text, /Не получилось опубликовать/);
  h.close();
});

test('ночью бот не беспокоит: напоминание переносится на 08:00', async () => {
  const late = fromLocal(2026, 9, 22, 21, 30, TZ);
  const h = new Harness({ start: late });
  await h.start(1);
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет газа');
  await typeAddress(h, 1, 'Садовая 10');
  await h.press(1, 'Позвонил');
  await h.text(1, '1');
  await h.press(1, 'Только что');
  const r = h.db.db.prepare('SELECT due_at FROM reminders').get() as { due_at: string };
  assert.equal(new Date(r.due_at).getTime(), fromLocal(2026, 9, 23, 8, 0, TZ).getTime());
  h.close();
});

test('удаление данных по запросу', async () => {
  const h = new Harness({ start: START });
  await reportHotWater(h, 1);
  await h.text(1, '/delete_me');
  await h.press(1, 'Да, удалить всё');
  assert.equal(h.db.getUser(1), undefined);
  assert.equal(h.db.listUserParticipants(1).length, 0);
  assert.equal(h.db.listUserHouses(1).length, 0);
  assert.equal(h.db.db.prepare('SELECT COUNT(*) AS n FROM incidents').get()!.n, 0);
  h.close();
});

// =====================================================================
// Бот действует сам: сеть дома, акт с соседями, фото, эскалация
// =====================================================================

/** Житель добавляет адрес в «Мои адреса» (без сообщения о поломке). */
async function joinHouse(h: Harness, user: number, address = 'ул. Примерная, д. 5', entrance = '2') {
  await h.start(user);
  await h.press(user, 'Мои адреса');
  await h.press(user, 'Добавить адрес');
  await typeAddress(h, user, address, entrance);
}

/** Житель отмечает, что подал заявление сегодня, без входящего номера. */
async function submitClaim(h: Harness, user: number) {
  await h.press(user, 'Я подал(а) заявление');
  await h.press(user, 'Сегодня');
  await h.press(user, 'Номера нет');
}

async function finishWithClaim(h: Harness, user: number, opts: { executor?: string } = {}) {
  await h.press(user, 'Воду дали');
  await h.press(user, 'Только что');
  await h.text(user, '1200');
  await h.press(user, 'УК / ТСЖ');
  // Житель уже в акте — ФИО и квартиру бот берёт оттуда.
  if (/Заявление от:/.test(h.last(user).text)) await h.press(user, '✅ Да');
  else {
    await h.text(user, 'Иванов Иван Иванович');
    await h.text(user, '42');
  }
  await h.press(user, 'Пропустить'); // лицевой счёт
  if (opts.executor) await h.text(user, opts.executor);
  else await h.press(user, 'Пропустить');
  await h.press(user, 'Не сохранять');
}

test('сеть дома: сосед получает «у вас тоже?» и присоединяется одной кнопкой', async () => {
  const h = new Harness({ start: START });
  await joinHouse(h, 2);
  assert.match(textOf(h, 2), /В сети дома — 1 житель/);
  assert.match(h.last(2).text, /ул\. Примерная, д\. 5\*\*, подъезд 2/);

  await reportHotWater(h, 1, 'Примерная 5');
  assert.match(textOf(h, 2), /ул\. Примерная, д\. 5: нет горячей воды/);
  assert.match(textOf(h, 2), /заявка № 4512/);
  assert.match(textOf(h, 1), /Сообщил 1 соседу/);

  await h.press(2, 'У меня тоже');
  const p2 = h.db.listUserParticipants(2)[0];
  assert.equal(p2.role, 'neighbour');
  assert.equal(p2.started_at, h.db.listUserParticipants(1)[0].started_at, 'время начала — как у соседа');
  const f = h.db.funnel();
  assert.equal(f.alert_sent, 1);
  assert.equal(f.alert_yes, 1);
  h.close();
});

test('ночью уведомление соседу уходит в 08:00; отписка работает по дому', async () => {
  const h = new Harness({ start: fromLocal(2026, 9, 22, 23, 30, TZ) });
  await joinHouse(h, 2);
  await reportHotWater(h, 1, 'Примерная 5');
  assert.doesNotMatch(textOf(h, 2), /нет горячей воды/);
  assert.match(textOf(h, 1), /утром в 08:00/);

  const mark = h.out.log.length;
  await h.advance(9 * H); // 08:30
  assert.match(textOf(h, 2, mark), /нет горячей воды/);
  await h.press(2, 'Не присылать');
  const houseId = h.db.getUser(1)!.house_id!;
  assert.equal(h.db.getUserHouse(2, houseId)!.notify, 0);

  const mark2 = h.out.log.length;
  await h.start(3);
  await h.press(3, 'Что-то сломалось');
  await h.press(3, 'Нет газа');
  await typeAddress(h, 3, 'Примерная 5');
  await h.press(3, 'Позвонил');
  await h.text(3, '77');
  await h.press(3, 'Только что');
  assert.equal(h.sentTo(2, mark2).length, 0, 'отписанный житель уведомлений не получает');
  h.close();
});

test('приглашение в сеть дома по ссылке показывает открытые отключения', async () => {
  const h = new Harness({ start: START });
  await reportHotWater(h, 1);
  await h.press(1, 'Меню');
  await h.press(1, 'Мои адреса');
  await h.press(1, '🏠 Москва, ул. Примерная, д. 5');
  await h.press(1, 'Позвать соседей');
  const url = h.lastLink(1, '?start=h_');
  assert.ok(textOf(h, 1).includes(url), 'ссылка-приглашение продублирована в тексте');
  await h.start(4, new URL(url).searchParams.get('start')!);
  assert.match(textOf(h, 4), /Вы в сети дома \*\*Москва, ул\. Примерная, д\. 5\*\*/);
  assert.equal(h.db.getUser(4)!.house_id, h.db.getUser(1)!.house_id);
  await h.press(4, 'у меня тоже');
  assert.equal(h.db.listUserParticipants(4).length, 1);
  h.close();
});

test('акт без исполнителя: бот сам собирает соседей, PDF, отметка о подписи председателя, акт в заявлении', async () => {
  const h = new Harness({ start: START });
  await joinHouse(h, 2);
  await joinHouse(h, 3);
  // Житель 1 не дозвонился в аварийную службу.
  await h.start(1);
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет горячей воды');
  await typeAddress(h, 1, 'Примерная 5', '3');
  await h.press(1, 'Внезапно');
  await h.press(1, 'Не дозвонился');
  await h.press(1, 'Записать время → акт');
  await h.press(1, 'Ввести время');
  await h.text(1, '20.09 08:10');
  assert.match(textOf(h, 1), /нужен акт с соседями/);
  await h.press(2, 'У меня тоже');
  await h.press(3, 'У меня тоже');

  await h.press(1, 'Акт с соседями');
  const mark0 = h.out.log.length;
  await h.text(1, 'Иванов Иван Иванович');
  await h.text(1, '5');
  // PDF для подписи — сразу, не дожидаясь соседей в боте.
  assert.ok(h.files(1, mark0).some((f) => f.name.startsWith('Акт_')), 'акт сразу в PDF');
  assert.match(textOf(h, 1), /Акт готов к подписи/);
  assert.match(textOf(h, 1), /Ещё отправил его 2 соседям/);
  assert.match(textOf(h, 2), /Соседи составляют акт/);

  const mark = h.out.log.length;
  await h.press(2, 'Подтверждаю');
  await h.text(2, 'Петров Пётр Петрович');
  await h.text(2, '7');
  assert.match(textOf(h, 1), /Петров П\. П\. подтвердил\(а\) акт/);
  const act = h.db.getActByIncident(h.db.listUserParticipants(1)[0].incident_id)!;
  assert.equal(h.db.getAct(act.id)!.status, 'ready', 'двух жителей достаточно — председатель подписывает на бумаге');
  for (const u of [1, 2]) {
    const pdf = h.files(u, mark).find((f) => f.name.startsWith('Акт_'));
    assert.ok(pdf && readFileSync(pdf.path).subarray(0, 4).toString() === '%PDF', `акт получил житель ${u}`);
  }

  await h.press(1, 'Акт подписан');
  assert.match(h.last(1).text, /подписали вы и хотя бы один сосед/);
  await h.press(1, 'Да, и председатель');
  assert.equal(h.db.getAct(act.id)!.status, 'signed');
  assert.equal(h.db.getAct(act.id)!.chair_signed, 1);
  assert.match(textOf(h, 2), /Акт подписан ✅/);

  await h.advance(1 * H);
  await finishWithClaim(h, 1);
  const doc = claimText(h, 1);
  assert.match(doc, /подтверждено актом от 22\.09\.2026, составленным и подписанным потребителями и председателем совета многоквартирного дома без участия исполнителя \(п\. 110\(1\) Правил\)/);
  assert.match(textOf(h, 1), /Акт указан в приложениях/);

  // Удаление данных стирает ФИО жителя из акта.
  await h.text(2, '/delete_me');
  await h.press(2, 'Да, удалить всё');
  assert.equal(h.db.listSigners(act.id).filter((s) => s.user_id === 2).length, 0);
  h.close();
});

test('акт в одиночку: заявление без доказательства предупреждает, PDF акта сразу с пустыми строками', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет горячей воды');
  await typeAddress(h, 1, 'Садовая 10');
  await h.press(1, 'Внезапно');
  await h.press(1, 'Не дозвонился');
  await h.press(1, 'Записать время → акт');
  await h.press(1, 'Ввести время');
  await h.text(1, '20.09 08:10');
  await h.advance(1 * H);
  await finishWithClaim(h, 1);
  assert.match(textOf(h, 1), /В заявлении нет доказательства/);

  // Соседей в боте нет — акт всё равно приходит сразу, с пустыми строками для подписей на бумаге.
  await h.press(1, 'Акт с соседями');
  const mark = h.out.log.length;
  await h.text(1, 'Иванов Иван Иванович');
  await h.text(1, '5');
  assert.ok(h.files(1, mark).some((f) => f.name.startsWith('Акт_')));
  const incident = h.db.getIncident(h.db.listUserParticipants(1)[0].incident_id)!;
  const act = h.db.getActByIncident(incident.id)!;
  const actDoc = buildActDoc({ norms: h.bot.norms, incident, house: h.db.getHouse(incident.house_id)!, act, signers: h.db.listSigners(act.id), readings: [], now: h.now() });
  assert.equal(actDoc.calc.filter((l) => l.includes('______, кв.')).length, 3, 'три пустые строки для соседей');
  assert.ok(actDoc.calc.some((l) => l.includes('Председатель совета')));

  const pid = h.db.listUserParticipants(1)[0].id;
  assert.equal(summarize(h.db, h.bot.norms, loadCase(h.db, pid)!, h.now()).claimOutdated, false);
  await h.press(1, 'Акт подписан');
  await h.press(1, 'Да, без председателя');
  assert.equal(h.db.getAct(act.id)!.status, 'signed');
  const doc = claimText(h, 1);
  assert.match(doc, /подписанным потребителями без участия исполнителя/);
  assert.match(doc, /Сообщение в аварийно-диспетчерскую службу исполнителя не удалось зарегистрировать: на звонок не ответили или не назвали регистрационный номер, хотя номер и время регистрации сообщения обязаны сообщить потребителю \(п\. 106 Правил\), а на звонок — ответить не позднее чем через 5 минут \(п\. 13 .*№ 416\)\. Время начала нарушения указано в акте\./);
  // Заявление выдали до подписи акта — в нём акта нет: его надо скачать заново.
  assert.equal(summarize(h.db, h.bot.norms, loadCase(h.db, pid)!, h.now()).claimOutdated, true, 'подписанный акт делает выданное заявление устаревшим');
  h.close();
});

test('демо 2: не дозвонились — акт с двумя демо-соседями попадает в заявление', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Демо');
  await h.press(1, 'Не дозвонились');
  assert.match(textOf(h, 1), /Демо 2: номера заявки нет/);
  assert.match(textOf(h, 1), /без номера заявки/);
  await h.press(1, 'Акт с соседями');
  await h.text(1, 'Петров Пётр Петрович');
  await h.text(1, '7');
  assert.match(textOf(h, 1), /Соседи \(демо\) Петрова А\. С\. и Сидоров О\. И\. подтвердили/);
  const incident = h.db.getIncident(h.db.listUserParticipants(1)[0].incident_id)!;
  assert.equal(incident.service_key, 'cold_water_off', 'другая услуга, чем в демо 1: расчёты не складываются');
  const act = h.db.getActByIncident(incident.id)!;
  assert.equal(h.db.getAct(act.id)!.status, 'ready');
  assert.deepEqual(h.db.listSigners(act.id).map((s) => s.flat), ['7', '43', '45']);

  await h.press(1, 'Акт подписан');
  await h.press(1, 'Да, и председатель');
  // Демо-соседи — не жители бота: им ничего не отправляется.
  assert.ok(!h.out.log.some((r) => r.to === 'user' && r.id < 0));
  await h.press(1, 'К делу');
  await h.advance(2 * H); // воду дали через 2 часа после того, как составили акт
  await h.press(1, 'Воду дали');
  await h.press(1, 'Только что');
  await h.text(1, '600');
  await h.press(1, 'УК / ТСЖ');
  // ФИО и квартира — как в акте: заново не спрашиваем.
  assert.match(h.last(1).text, /Заявление от: Петров Пётр Петрович, кв\. 7\?/);
  await h.press(1, '✅ Да');
  await h.press(1, 'Пропустить');
  await h.press(1, 'Пропустить');
  await h.press(1, 'Не сохранять');
  const doc = claimText(h, 1);
  assert.match(doc, /ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ/);
  assert.match(doc, /Сообщение в аварийно-диспетчерскую службу исполнителя не удалось зарегистрировать/);
  assert.match(doc, /подтверждено актом от .* и председателем совета многоквартирного дома без участия исполнителя \(п\. 110\(1\) Правил\)/);
  assert.match(doc, /Копия акта о нарушении качества/);
  // Акт составили до «Воду дали»: скачанная позже копия совпадает с подписанной бумагой.
  const actText = actDocFor(h.db, h.bot.norms, act.id, h.now())!.facts.join(' ');
  assert.match(actText, /на момент составления акта не устранено/);
  assert.doesNotMatch(actText, / по \d{2}\.\d{2}\.\d{4}/);
  // Заявление с актом в приложениях — на одном листе: отметка о принятии не уезжает на второй.
  const pdf = await claimToPdf(claimDocFor(h.db, h.bot.norms, loadCase(h.db, h.db.listUserParticipants(1)[0].id)!, h.now()));
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length, 1, 'одна страница');
  h.close();
});

test('проверка через 2 часа: никто не пришёл → акт с причиной «не пришли на замер»', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Холодно в квартире');
  await typeAddress(h, 1, 'пр-т Мира, 12');
  await h.press(1, 'Обычная');
  await h.text(1, '15');
  await h.press(1, 'Позвонил');
  await h.text(1, 'А-1');
  await h.press(1, 'Только что');
  const mark = h.out.log.length;
  await h.advance(2 * H);
  assert.match(textOf(h, 1, mark), /Приходили из УК замерить/);
  await h.press(1, 'Никто');
  const p = h.db.listUserParticipants(1)[0];
  assert.equal(p.inspection, 'no_show');
  await h.press(1, 'Акт с соседями');
  assert.equal(h.db.getActByIncident(p.incident_id)!.reason, 'no_inspection');
  h.close();
});

test('фото прикрепляется к открытому случаю и попадает в приложения заявления', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.photo(1, 'early');
  assert.match(h.last(1).text, /случая, к которому его приложить, пока нет/);

  await reportHotWater(h, 1);
  await h.photo(1, 'tok-1');
  assert.match(h.last(1).text, /Сохранил фото к случаю «Горячее водоснабжение»/);
  const p = h.db.listUserParticipants(1)[0];
  assert.equal(h.db.listPhotos(p.id).length, 1);
  assert.equal(h.db.listPhotos(p.id)[0].token, 'tok-1');

  await finishWithClaim(h, 1);
  assert.match(claimText(h, 1), /Фотографии \(1 шт\.\)\. Время получения сервисом «Вернём»/);
  h.close();
});

test('перерасчёт не пришёл: штраф 50%, жалоба в ГЖИ с другими домами, общество потребителей', async () => {
  const h = new Harness({ start: START, config: { partnerName: 'Общество защиты прав потребителей «Пример»', partnerUrl: 'https://example.invalid/ozpp' } });
  await reportHotWater(h, 1);
  await finishWithClaim(h, 1, { executor: 'ООО "УК Пример"' });
  // Тот же исполнитель в другом доме.
  await reportHotWater(h, 5, 'ул. Садовая, 10');
  await finishWithClaim(h, 5, { executor: 'УК Пример' });
  await submitClaim(h, 1);

  await h.advance(31 * 24 * H);
  await h.press(1, '❌ Нет');
  const menu = h.last(1).text;
  assert.match(menu, /Перерасчёт не сделали/);
  assert.match(menu, /Штраф ≈ 38,70 ₽/); // 43 ч × 0,15% = 6,45% от 1 200 ₽ = 77,40 ₽ → 50%
  assert.match(menu, /нарушения в 2 домах/);

  let mark = h.out.log.length;
  await h.press(1, 'Требование о штрафе 50%');
  assert.match(textOf(h, 1, mark), /Штраф 50% ≈ 38,70 ₽/);
  assert.ok(h.files(1, mark).some((f) => f.name.startsWith('Требование_')));

  await h.press(1, 'Другие варианты');
  mark = h.out.log.length;
  await h.press(1, 'Жалоба в ГЖИ');
  assert.match(textOf(h, 1, mark), /нарушения этого исполнителя в 2 домах/);
  assert.ok(h.files(1, mark).some((f) => f.name.startsWith('Жалоба_в_ГЖИ_')));

  await h.press(1, 'Другие варианты');
  mark = h.out.log.length;
  await h.press(1, 'Общество защиты прав потребителей');
  assert.match(textOf(h, 1, mark), /Заявление в «Общество защиты прав потребителей «Пример»» готово/);
  assert.equal(h.lastLink(1, 'example.invalid/ozpp'), 'https://example.invalid/ozpp');

  const f = h.db.funnel();
  for (const k of ['escalation_fine', 'escalation_gji', 'escalation_ozpp']) assert.equal(f[k], 1, k);
  h.close();
});

test('перерасчёт меньше положенного — бот предлагает потребовать остальное', async () => {
  const h = new Harness({ start: START });
  await reportHotWater(h, 1);
  await finishWithClaim(h, 1);
  await submitClaim(h, 1);
  await h.advance(31 * 24 * H);
  await h.press(1, 'Да, вернули');
  await h.text(1, '40');
  assert.match(h.last(1).text, /положено ≈ 77,40 ₽, а вернули 40 ₽/);
  await h.press(1, 'Потребовать остальное');
  assert.match(h.last(1).text, /Перерасчёт сделали не полностью/);
  assert.match(h.last(1).text, /Штраф ≈ 18,70 ₽/); // (77,40 − 40) × 50%
  h.close();
});

test('главное меню: «Открыть приложение» — первой кнопкой; «Ещё нет», а не «Нет ещё»', async () => {
  const { mainMenu } = await import('../src/bot/ui.ts');
  assert.equal(mainMenu({ demo: false, app: true })[0][0].text, '📱 Открыть приложение');
  assert.equal(mainMenu({ demo: false, app: false })[0][0].text, '🚨 Что-то сломалось');
  const src = readFileSync(new URL('../src/bot/core.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /'Нет ещё'/);
});

// ---------------------------------------------------------------------
// УК в боте: заявка уходит сотруднику УК, номер приходит жителю
// ---------------------------------------------------------------------

/** Дом с жителем и подключённым сотрудником УК (user 50). */
async function houseWithUk(h: Harness) {
  const house = h.db.upsertHouse('ул. Лесная, 7', TZ, 0, 'Москва');
  h.db.addUserHouse(1, house.id);
  h.db.addUserHouse(2, house.id);
  await h.start(1);
  await h.bot.handle({ kind: 'button', userId: 1, payload: `hs:uk:${house.id}` });
  const url = h.lastLink(1, 'start=d_');
  const code = url.split('start=d_')[1];
  await h.start(50, `d_${code}`);
  await h.text(50, 'Иванова А. П., диспетчер ООО «УК Лесная»');
  return { house, code };
}

async function reportViaUk(h: Harness, user: number) {
  await h.press(user, 'Что-то сломалось');
  await h.press(user, 'Нет горячей воды');
  await h.press(user, 'Внезапно');
  await h.press(user, 'Отправить заявку в УК');
}

test('УК в боте: подключение, заявка, «Принять» → номер у жителей, «Устранено» → житель подтверждает', async () => {
  const h = new Harness({ start: START });
  const { code } = await houseWithUk(h);
  assert.match(textOf(h, 50), /Заявки жителей дома .*Лесная.* будут приходить сюда/);
  assert.match(textOf(h, 1), /подключилась УК: Иванова А\. П\./);

  // Житель того же дома не может принимать заявки как УК.
  await h.start(2, `d_${code}`);
  assert.match(h.last(2).text, /Вы житель этого дома/);

  let mark = h.out.log.length;
  await reportViaUk(h, 1);
  assert.match(textOf(h, 1, mark), /Отправил заявку в УК/);
  assert.match(textOf(h, 50, mark), /Заявка жителей.*Нет горячей воды|Заявка жителей/);
  assert.doesNotMatch(textOf(h, 1, mark), /нужен акт с соседями/);

  // Сосед присоединяется к тому же отключению — заявка общая.
  await h.press(2, 'Что-то сломалось');
  await h.press(2, 'Нет горячей воды');
  await h.press(2, 'Да, присоединиться');

  mark = h.out.log.length;
  await h.press(50, '✅ Принять');
  const num = `2209-1`;
  assert.match(textOf(h, 1, mark), new RegExp(`УК приняла заявку.*№ ${num}`));
  assert.match(textOf(h, 2, mark), new RegExp(`№ ${num}`));
  const inc = h.db.getIncident(h.db.listUserParticipants(1)[0].incident_id)!;
  assert.equal(inc.evidence, 'ads');
  assert.equal(inc.ads_number, num);

  // Второе нажатие — не дублирует.
  await h.press(50, '✅ Принять');
  assert.match(h.last(50).text, /уже приняли/);

  await h.advance(H);
  await h.press(50, 'Выехали');
  assert.match(textOf(h, 1, mark), /выехали на место/);
  await h.advance(H);
  mark = h.out.log.length;
  await h.press(50, 'Устранено');
  assert.match(textOf(h, 1, mark), /устранено в 22\.09 14:00/);
  await h.press(1, 'Да, с 14:00');
  assert.match(textOf(h, 1, mark), /Записал: починили в 22\.09 14:00\. УК об этом знает/);

  const p1 = h.db.listUserParticipants(1)[0];
  const text = claimTextFor(h.db, h.bot.norms, loadCase(h.db, p1.id)!, h.now());
  assert.match(text, /через канал приёма заявок в мессенджере MAX \(сервис «Вернём»\)/);
  assert.match(text, new RegExp(`зарегистрировано под № ${num}`));
  assert.match(text, /принял\(а\) сотрудник, указавший себя как «Иванова А\. П\./);
  assert.match(text, /С этого времени исчисляется период нарушения/);
  const p2 = h.db.listUserParticipants(2)[0];
  assert.match(claimTextFor(h.db, h.bot.norms, loadCase(h.db, p2.id)!, h.now()), /другой житель дома сообщил исполнителю через канал приёма заявок/);
  h.close();
});

test('УК в боте: свой номер диспетчера; молчание УК записывается; «Не наш дом»', async () => {
  const h = new Harness({ start: START });
  await houseWithUk(h);

  // Свой номер из журнала.
  await reportViaUk(h, 1);
  await h.press(50, 'Принять со своим номером');
  await h.text(50, 'нет');
  assert.match(h.last(50).text, /должны быть цифры/);
  await h.text(50, 'АДС-778');
  assert.match(textOf(h, 1), /№ АДС-778/);
  await h.bot.handle({ kind: 'button', userId: 1, payload: `rest:${h.db.listUserParticipants(1)[0].id}:y` });
  await h.press(1, 'Только что');

  // Молчание: через 30 минут бот предупреждает, это попадает в заявление.
  const mark = h.out.log.length;
  await h.start(2);
  await h.press(2, 'Что-то сломалось');
  await h.press(2, 'Нет холодной воды');
  await h.press(2, 'Отправить заявку в УК');
  await h.advance(31 * 60_000);
  assert.match(textOf(h, 2, mark), /УК не ответила на заявку за 31 мин/);
  const p2 = h.db.listUserParticipants(2)[0];
  await h.bot.handle({ kind: 'button', userId: 2, payload: `rest:${p2.id}:y` });
  await h.press(2, 'Только что');
  assert.match(claimTextFor(h.db, h.bot.norms, loadCase(h.db, p2.id)!, h.now()), /однако зарегистрировано не было/);

  // «Не наш дом»: жители получают совет позвонить, кнопка «Отправить в УК» возвращается.
  await h.advance(H);
  const m2 = h.out.log.length;
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет света');
  if (lastButtons(h, 1).some((b) => b.text.startsWith('Два'))) await h.press(1, 'Два');
  await h.press(1, 'Отправить заявку в УК');
  await h.press(50, 'Не наш дом');
  assert.match(textOf(h, 1, m2), /УК ответила, что дом .* не обслуживает/);
  h.close();
});

// ---------------------------------------------------------------------
// Заявление на почту УК
// ---------------------------------------------------------------------

/** Почтовый сервер на localhost: принимает письмо и запоминает его (без шифрования — только для тестов). */
async function fakeSmtp(opts: { failAuth?: boolean } = {}) {
  const { createServer } = await import('node:net');
  const mails: { from: string; rcpt: string[]; data: string }[] = [];
  const server = createServer((s) => {
    let buf = '';
    let inData = false;
    let cur = { from: '', rcpt: [] as string[], data: '' };
    s.write('220 test ESMTP\r\n');
    // Клиент рвёт соединение после ошибки — на Windows это ECONNRESET у сервера.
    s.on('error', () => undefined);
    s.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            mails.push(cur);
            cur = { from: '', rcpt: [], data: '' };
            s.write('250 queued\r\n');
          } else cur.data += line.replace(/^\.\./, '.') + '\n';
          continue;
        }
        if (/^EHLO/.test(line)) s.write('250-test\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) s.write(opts.failAuth ? '535 bad\r\n' : '235 ok\r\n');
        else if (/^MAIL FROM/.test(line)) (cur.from = line), s.write('250 ok\r\n');
        else if (/^RCPT TO/.test(line)) (cur.rcpt.push(line), s.write('250 ok\r\n'));
        else if (line === 'DATA') (inData = true), s.write('354 go\r\n');
        else if (line === 'QUIT') s.end('221 bye\r\n');
        else s.write('500 ?\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  // Упавший тест не должен держать процесс: сервер не мешает завершению.
  server.unref();
  const port = (server.address() as { port: number }).port;
  return { port, mails, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('заявление на почту УК: бот отправляет PDF, житель в копии, дата отправки — дата подачи', async () => {
  const smtp = await fakeSmtp();
  const mail = { host: '127.0.0.1', port: smtp.port, user: 'bot@vernem.test', pass: 'secret', from: 'bot@vernem.test', fromName: 'Вернём' };
  const h = new Harness({ start: START, config: { mail } });
  await reportHotWater(h, 1);
  const house = h.db.listUserHouses(1)[0];
  h.db.setHouseInfo(house.id, { ukEmail: 'uk@example.ru' });
  await finishWithClaim(h, 1);
  await h.press(1, 'Отправить в УК на почту');
  assert.match(h.last(1).text, /на почту УК \*\*uk@example\.ru\*\*/);
  await h.text(1, 'не почта');
  assert.match(h.last(1).text, /name@example\.ru/);
  await h.text(1, 'Ivanov@Mail.ru');
  assert.match(h.last(1).text, /Отправил заявление на uk@example\.ru в 22\.09 12:00, копия — на ivanov@mail\.ru/);

  assert.equal(smtp.mails.length, 1);
  const m = smtp.mails[0];
  assert.deepEqual(m.rcpt, ['RCPT TO:<uk@example.ru>', 'RCPT TO:<ivanov@mail.ru>']);
  assert.match(m.data, /^Reply-To: <ivanov@mail\.ru>$/m);
  assert.match(m.data, /Subject: =\?UTF-8\?B\?/);
  assert.match(m.data, /Content-Type: application\/pdf/);
  // Вложение — настоящий PDF (base64 от «%PDF»), с ФИО, хотя данные не сохраняли.
  assert.match(m.data, /^JVBERi/m);
  const body = Buffer.from(m.data.split('Content-Transfer-Encoding: base64\n\n')[1].split('\n--')[0].replace(/\n/g, ''), 'base64').toString('utf8');
  assert.match(body, /Прошу зарегистрировать обращение и сообщить входящий номер/);
  assert.match(body, /Ответ прошу направить на ivanov@mail\.ru/);

  const p = h.db.listUserParticipants(1)[0];
  const cl = JSON.parse(h.db.getParticipant(p.id)!.claim!);
  assert.equal(cl.submittedVia, 'email');
  assert.equal(cl.emailedTo, 'uk@example.ru');
  assert.ok(cl.submittedAt);
  await smtp.close();
  h.close();
});

test('заявление на почту: сервер отказал — житель получает понятную ошибку, подача не отмечается', async () => {
  const smtp = await fakeSmtp({ failAuth: true });
  const mail = { host: '127.0.0.1', port: smtp.port, user: 'bot@vernem.test', pass: 'bad', from: 'bot@vernem.test', fromName: 'Вернём' };
  const h = new Harness({ start: START, config: { mail } });
  await reportHotWater(h, 1);
  h.db.setHouseInfo(h.db.listUserHouses(1)[0].id, { ukEmail: 'uk@example.ru' });
  await finishWithClaim(h, 1);
  await h.press(1, 'Отправить в УК на почту');
  await h.press(1, 'Без моей почты');
  assert.match(h.last(1).text, /Письмо не ушло/);
  const cl = JSON.parse(h.db.getParticipant(h.db.listUserParticipants(1)[0].id)!.claim!);
  assert.equal(cl.submittedAt, undefined);
  // Без настроенной почты кнопки нет.
  const h2 = new Harness({ start: START });
  await reportHotWater(h2, 1);
  h2.db.setHouseInfo(h2.db.listUserHouses(1)[0].id, { ukEmail: 'uk@example.ru' });
  await finishWithClaim(h2, 1);
  assert.ok(!h2.buttons(1).some((b) => b.text.includes('на почту')));
  await smtp.close();
  h.close();
  h2.close();
});

test('документы: без приписки «расчёт ориентировочный» и ссылки на КонсультантПлюс, адрес УК одинаковый в заявлении и требовании', async () => {
  const h = new Harness({ start: START });
  await reportHotWater(h, 1);
  const house = h.db.listUserHouses(1)[0];
  h.db.setHouseInfo(house.id, { ukName: 'ООО «УК Пример»', ukAddress: 'г. Москва, ул. Строителей, 1' });
  await h.press(1, 'Воду дали');
  await h.press(1, 'Только что');
  await h.text(1, '1200');
  await h.press(1, '✅ Да'); // получатель из карточки дома
  await h.text(1, 'Иванов Иван Иванович');
  await h.text(1, '42');
  await h.press(1, 'Пропустить');
  await h.press(1, 'Не сохранять');
  const claim = claimText(h, 1);
  assert.doesNotMatch(claim, /ориентировочный и выполнен|КонсультантПлюс|итоговый размер снижения платы определяет исполнитель/);
  assert.match(claim, /адрес: г\. Москва, ул\. Строителей, 1/);
  assert.match(claim, /Отметка о принятии \(на втором экземпляре/);
  // Требование о штрафе — тот же адрес УК и тоже без оговорок.
  const { escalationDocFor } = await import('../src/bot/escalate.ts');
  const p = h.db.listUserParticipants(1)[0];
  h.db.updateParticipant(p.id, { status: 'refused' });
  const fine = claimToText(escalationDocFor(h.bot, loadCase(h.db, p.id)!, 'fine'));
  assert.match(fine, /адрес: г\. Москва, ул\. Строителей, 1/);
  assert.doesNotMatch(fine, /рассчитаны ориентировочно/);
  h.close();
});

test('демо-дела заново: из меню «Демо» — три новых демо, настоящие дела, ФИО и прежние демо', async () => {
  const h = new Harness({ start: START });
  await reportHotWater(h, 1);
  h.db.updateUser(1, { fio: 'Настоящий Житель', save_personal: 1 });
  await h.press(1, 'Меню');
  await h.press(1, 'Демо');
  await h.press(1, 'Есть номер заявки');
  await h.press(1, 'Меню');
  await h.press(1, 'Демо');
  await h.press(1, 'Все демо-дела заново');
  assert.match(h.last(1).text, /3 демо-дела заново/);
  const parts = h.db.listUserParticipants(1).map((p) => h.db.getIncident(p.incident_id)!.demo);
  assert.deepEqual(parts.filter((d) => d).sort(), [1, 1, 3]);
  assert.equal(parts.filter((d) => !d).length, 1, 'настоящее дело осталось');
  assert.equal(h.db.getUser(1)!.fio, 'Настоящий Житель');
  // Демо-заявление помечено, но без прочих приписок.
  const demo1 = h.db.listUserParticipants(1).find((p) => h.db.getIncident(p.incident_id)!.demo === 1 && p.status === 'claim_ready')!;
  const text = claimTextFor(h.db, h.bot.norms, loadCase(h.db, demo1.id)!, h.now());
  assert.match(text, /^ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ: не является реальным заявлением\.$/m);
  assert.doesNotMatch(text, /КонсультантПлюс/);
  h.close();
});

// ---------------------------------------------------------------------
// 1.4: сроки от подачи, доставка напоминаний, старые кнопки, роли и данные
// ---------------------------------------------------------------------

test('сроки идут от подачи: без отметки о подаче нет вопроса о квитанции и «не сделали»', async () => {
  const h = new Harness({ start: START });
  await reportHotWater(h, 1);
  await finishWithClaim(h, 1);
  const p = h.db.listUserParticipants(1)[0];
  // Через 3 дня бот спрашивает, подали ли заявление.
  let mark = h.out.log.length;
  await h.advance(3 * 24 * H + H);
  assert.match(textOf(h, 1, mark), /Вы подали заявление о перерасчёте/);
  await h.press(1, 'Ещё нет');
  // Через месяц квитанцию не проверяем: заявление не подано.
  mark = h.out.log.length;
  await h.advance(31 * 24 * H);
  assert.doesNotMatch(textOf(h, 1, mark), /Пришла новая квитанция/);
  // «Не сделали» без подачи — нельзя: сначала дата подачи.
  await h.bot.handle({ kind: 'button', userId: 1, payload: `rc:${p.id}:n` });
  assert.match(h.last(1).text, /Сначала отметьте, когда подали заявление/);
  assert.equal(h.db.getParticipant(p.id)!.status, 'claim_ready');
  // Подать раньше даты заявления нельзя; другой день — текстом.
  await h.press(1, 'Я подал(а) заявление');
  await h.press(1, 'Другой день');
  await h.text(1, '01.09');
  assert.match(h.last(1).text, /подать его раньше нельзя/);
  await h.press(1, 'Другой день');
  await h.text(1, '23.09');
  await h.text(1, 'вх. № 77');
  const cl = JSON.parse(h.db.getParticipant(p.id)!.claim!);
  assert.equal(cl.incomingNumber, '77');
  assert.equal(new Date(cl.submittedAt).getTime(), fromLocal(2026, 9, 23, 12, 0, TZ).getTime());
  h.close();
});

test('старые кнопки не меняют закрытый сценарий: перерасчёт, получатель, требование', async () => {
  const h = new Harness({ start: START });
  await reportHotWater(h, 1);
  await finishWithClaim(h, 1);
  await submitClaim(h, 1);
  const p = h.db.listUserParticipants(1)[0];
  await h.advance(31 * 24 * H);
  await h.press(1, 'Да, вернули');
  await h.text(1, '77,40');
  assert.equal(h.db.getParticipant(p.id)!.status, 'refunded');
  // Старые кнопки из прошлых сообщений.
  for (const payload of [`rc:${p.id}:n`, `rfskip:${p.id}`, `sv:${p.id}:1`, `ex:${p.id}:rso`, `esc:${p.id}:fine`.replace('refunded', ''), `calc:${p.id}`]) {
    await h.bot.handle({ kind: 'button', userId: 1, payload });
  }
  const after = h.db.getParticipant(p.id)!;
  assert.equal(after.status, 'refunded', 'статус не сбросился');
  assert.equal(after.refund_amount, 77.4, 'сумма не стёрлась');
  assert.equal(JSON.parse(after.claim!).executorType, 'uk', 'получатель не сменился');
  // Требование до «не сделали» недоступно.
  const h2 = new Harness({ start: START });
  await reportHotWater(h2, 1);
  await finishWithClaim(h2, 1);
  const p2 = h2.db.listUserParticipants(1)[0];
  const before = h2.files(1).length;
  await h2.bot.handle({ kind: 'button', userId: 1, payload: `esc:${p2.id}:fine` });
  assert.equal(h2.files(1).length, before, 'требование не выдано, пока перерасчёт не отклонён');
  h.close();
  h2.close();
});

test('напоминание не потерялось: MAX не принял сообщение — бот повторит, уведомление соседу тоже', async () => {
  const h = new Harness({ start: START });
  await joinHouse(h, 2);
  h.out.failUsers.add(2);
  await reportHotWater(h, 1, 'Примерная 5');
  // Соседу не дошло — уведомление вернулось в очередь.
  assert.equal((h.db.db.prepare('SELECT sent_at, attempts FROM alerts').get() as any).sent_at, null);
  h.out.failUsers.add(1);
  await h.advance(3 * H);
  const r = h.db.db.prepare("SELECT sent_at, attempts FROM reminders WHERE kind = 'ask_restored'").get() as any;
  assert.equal(r.sent_at, null, 'напоминание не помечено отправленным');
  assert.equal(r.attempts, 1);
  h.out.failUsers.clear();
  const mark = h.out.log.length;
  await h.advance(11 * 60_000);
  assert.match(textOf(h, 1, mark), /Починили\?/);
  assert.match(textOf(h, 2, mark), /У вас тоже\?/);
  h.close();
});

test('webhook: повтор события MAX не обрабатывается второй раз', async () => {
  const { SeenUpdates, updateKey } = await import('../src/bot/max-adapter.ts');
  const seen = new SeenUpdates(2);
  const cb1 = { update_type: 'message_callback', timestamp: 1, callback: { callback_id: 'c1' } };
  assert.equal(seen.first(updateKey(cb1)), true);
  assert.equal(seen.first(updateKey(cb1)), false, 'тот же callback_id — повтор');
  assert.equal(seen.first(updateKey({ update_type: 'message_created', timestamp: 2, message: { body: { mid: 'm1' } } })), true);
  assert.equal(seen.first(updateKey({ update_type: 'bot_started', timestamp: 3, user: { user_id: 5 } })), true);
  // Старые ключи вытесняются — память не растёт.
  assert.equal(seen.first(updateKey(cb1)), true);
});

test('демо-дела заново не меняют текущий адрес, демо-дом не попадает в список адресов', async () => {
  const h = new Harness({ start: START });
  await reportHotWater(h, 1);
  const before = h.db.getUser(1)!.house_id;
  await h.press(1, 'Меню');
  await h.press(1, 'Демо');
  await h.press(1, 'Все демо-дела заново');
  assert.equal(h.db.getUser(1)!.house_id, before);
  assert.deepEqual(h.db.listUserHouses(1).map((x) => x.address), ['Москва, ул. Примерная, д. 5']);
  // Новое сообщение идёт на настоящий адрес, а не на демо.
  await h.press(1, 'Меню');
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет света');
  assert.doesNotMatch(h.last(1).text, /Где случилось/);
  h.close();
});

test('удаление данных: у соседей остаются дело и акт, но без ссылок на удалившегося', async () => {
  const h = new Harness({ start: START });
  await joinHouse(h, 2);
  await h.start(1);
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет холодной воды');
  await typeAddress(h, 1, 'Примерная 5');
  await h.press(1, 'Не дозвонился');
  await h.press(1, 'Записать время → акт');
  await h.press(1, '1 ч назад');
  await h.press(2, 'У меня тоже');
  const inc = h.db.getIncident(h.db.listUserParticipants(1)[0].incident_id)!;
  await h.press(1, 'Акт с соседями');
  await h.text(1, 'Иванов Иван Иванович');
  await h.text(1, '1');
  await h.press(2, 'Подтверждаю');
  await h.text(2, 'Петрова Анна Сергеевна');
  await h.text(2, '2');
  await h.text(1, '/delete_me');
  await h.press(1, 'Да, удалить всё');
  const after = h.db.getIncident(inc.id)!;
  assert.equal(after.reporter_user_id, 2, 'отключение переходит соседу');
  assert.equal(h.db.getActByIncident(inc.id)!.initiator_user_id, 2, 'акт переходит соседу, который в нём подписан');
  assert.equal(h.db.listSigners(h.db.getActByIncident(inc.id)!.id).some((s) => s.fio.startsWith('Иванов')), false);
  h.close();
});

test('домовой чат с несколькими адресами: дом выбирают в личке, карточка уходит только в чат своего дома', async () => {
  const h = new Harness({ start: START });
  await reportHotWater(h, 1); // Москва, ул. Примерная, д. 5
  await h.press(1, 'Меню');
  await h.press(1, 'Мои адреса');
  await h.press(1, 'Добавить адрес');
  await typeAddress(h, 1, 'Ленина 3');
  await h.bot.handle({ kind: 'group_added', chatId: -700, title: 'Ленина 3' });
  await h.bot.handle({ kind: 'group_text', chatId: -700, userId: 1, text: '/dom' });
  assert.match(h.out.log.at(-1)!.msg.text, /выберите дом в личных сообщениях/);
  await h.press(1, 'Ленина 3');
  assert.match(h.out.log.filter((r) => r.to === 'chat' && r.id === -700).at(-1)!.msg.text, /Чат привязан к дому: Москва, Ленина 3/);
  // Карточка горячей воды по Примерной в чат дома на Ленина не уходит.
  const p = h.db.listUserParticipants(1)[0];
  await h.bot.handle({ kind: 'button', userId: 1, payload: `nb:${p.id}` });
  assert.ok(!h.buttons(1).some((b) => b.text.includes('Опубликовать в чате дома')));
  await h.bot.handle({ kind: 'button', userId: 1, payload: `post:${p.id}` });
  assert.equal(h.out.log.filter((r) => r.to === 'chat' && r.id === -700 && /нет горячей воды/.test(r.msg.text)).length, 0);
  h.close();
});

test('УК в боте: житель не может принимать заявки; жители отключают «не нашу УК»; роль истекает', async () => {
  const h = new Harness({ start: START });
  const { house } = await houseWithUk(h);
  const d = h.db.listDispatchers(house.id)[0];
  // Сотрудник стал жителем дома — принять заявку нельзя, подключение снимается.
  await reportViaUk(h, 1);
  h.db.addUserHouse(50, house.id);
  await h.press(50, '✅ Принять');
  assert.match(h.last(50).text, /Вы житель этого дома/);
  assert.equal(h.db.listDispatchers(house.id).length, 0);
  assert.equal(h.db.getIncident(h.db.listUserParticipants(1)[0].incident_id)!.ads_number, null);
  h.db.removeUserHouse(50, house.id);

  // Подключаем другого сотрудника, житель отключает его кнопкой из уведомления.
  const code = h.db.dispatchCodeFor(house.id);
  await h.start(60, `d_${code}`);
  await h.text(60, 'Сидоров П. П., ООО «Чужая УК»');
  const d60 = h.db.getDispatcher(house.id, 60)!;
  assert.notEqual(d60.id, d.id);
  await h.press(1, 'Это не наша УК');
  await h.press(1, 'Да, отключить');
  assert.equal(h.db.getDispatcher(house.id, 60), undefined);
  assert.match(h.last(60).text, /отключили вас от приёма заявок/);

  // Без действий 90 дней подключение заканчивается само.
  await h.start(61, `d_${code}`);
  await h.text(61, 'Петрова А. А., ООО «УК Лесная»');
  await h.advance(91 * 24 * H);
  assert.equal(h.db.getDispatcher(house.id, 61), undefined);
  assert.match(h.last(61).text, /Подключение к дому .* закончилось/);
  h.close();
});

test('карточка дома общая: изменение заполненного поля видно соседям, в заявление — текущее', async () => {
  const h = new Harness({ start: START });
  await joinHouse(h, 2);
  await joinHouse(h, 3);
  const house = h.db.listUserHouses(2)[0];
  await h.bot.handle({ kind: 'button', userId: 2, payload: `hs:info:${house.id}` });
  await h.text(2, 'ООО «УК Примерная»');
  const mark = h.out.log.length;
  await h.bot.handle({ kind: 'button', userId: 3, payload: `hs:info:${house.id}` });
  await h.text(3, 'ООО «Другая УК»');
  assert.match(textOf(h, 2, mark), /Сосед изменил данные дома.*\n.*УК \/ ТСЖ: было «ООО «УК Примерная»», стало «ООО «Другая УК»»/);
  const info = h.db.houseInfo(h.db.getHouse(house.id)!);
  assert.equal(info.fieldsBy!.ukName!.by, 3);
  assert.equal(info.fieldsBy!.ukName!.prev, 'ООО «УК Примерная»');
  h.close();
});

test('заявление на почту уходит один раз; приложения, которых нет в письме, названы', async () => {
  const smtp = await fakeSmtp();
  const mail = { host: '127.0.0.1', port: smtp.port, user: 'bot@vernem.test', pass: 'secret', from: 'bot@vernem.test', fromName: 'Вернём' };
  const h = new Harness({ start: START, config: { mail } });
  await reportHotWater(h, 1);
  h.db.setHouseInfo(h.db.listUserHouses(1)[0].id, { ukEmail: 'uk@example.ru' });
  await h.photo(1, 'tok-1'); // ссылка на фото не открывается — фото пойдёт отдельно
  await finishWithClaim(h, 1);
  const p = h.db.listUserParticipants(1)[0];
  const { emailClaim } = await import('../src/bot/mail.ts');
  const [a, b] = await Promise.all([emailClaim(h.bot, 1, p.id, null), emailClaim(h.bot, 1, p.id, null)]);
  assert.equal([a, b].filter((x) => x === null).length, 1, 'одно письмо из двух одновременных нажатий');
  assert.match(String(a ?? b), /уже отправляется|уже отправлено/);
  assert.match(String(await emailClaim(h.bot, 1, p.id, null)), /уже отправлено/);
  assert.equal(smtp.mails.length, 1);
  const body = Buffer.from(smtp.mails[0].data.split('Content-Transfer-Encoding: base64\n\n')[1].split('\n--')[0].replace(/\n/g, ''), 'base64').toString('utf8');
  assert.match(body, /Во вложении: заявление \(PDF\)\./);
  assert.match(body, /Ещё 1 фото направлю отдельно/);
  // С даты отправки бот ждёт квитанцию.
  assert.ok(h.db.db.prepare("SELECT 1 FROM reminders WHERE kind = 'ask_receipt' AND sent_at IS NULL").get());
  await smtp.close();
  h.close();
});

test('температура: замер в силе сутки; ночной замер в заявлении сравнивается с ночной нормой', async () => {
  const h = new Harness({ start: fromLocal(2026, 10, 5, 2, 0, TZ) });
  const house = h.db.upsertHouse('Лесная 9', TZ, 0, 'Москва');
  h.db.addUserHouse(1, house.id);
  const inc = h.db.createIncident({ house_id: house.id, service_key: 'heating_temp', reporter_user_id: 1, started_at: h.now().toISOString(), ads_number: '1', evidence: 'ads', variant: null });
  const p = h.db.addParticipant({ incident_id: inc.id, user_id: 1, role: 'reporter', started_at: h.now().toISOString() });
  h.db.addReading(p.id, h.now().toISOString(), 15.5); // 02:00 — ночью норма +15 °C, это норма
  h.db.updateParticipant(p.id, { ended_at: fromLocal(2026, 10, 8, 2, 0, TZ).toISOString(), status: 'ended' });
  const c = loadCase(h.db, p.id)!;
  const calc = calcFor(h.db, h.bot.norms, c, h.now());
  assert.match(calc.months[0].lines.join(' '), /2 суток без свежего замера не учтено/);
  assert.equal(calc.months[0].unmeasuredHours, 48);
  assert.match(claimTextFor(h.db, h.bot.norms, c, h.now()), /02:00: \+15,5 °C \(в пределах нормы\)/);
  h.close();
});

test('акт без председателя: бот прямо говорит, что он неполный, и даёт отметить подпись позже', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Демо');
  await h.press(1, 'Не дозвонились');
  await h.press(1, 'Акт с соседями');
  await h.text(1, 'Иванов Иван Иванович');
  await h.text(1, '1');
  assert.match(textOf(h, 1), /По правилам нужна и его подпись/);
  await h.press(1, 'Акт подписан');
  await h.press(1, 'Да, без председателя');
  assert.match(h.last(1).text, /Без подписи председателя акт неполный/);
  await h.press(1, 'Председатель подписал позже');
  const act = h.db.getActByIncident(h.db.listUserParticipants(1)[0].incident_id)!;
  assert.equal(act.chair_signed, 1);
  h.close();
});

test('свет: два ввода — свойство дома, в заявлении без догадки «лифт или 9 этажей»', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет света');
  await typeAddress(h, 1, 'Ленина 3');
  assert.match(h.last(1).text, /два независимых ввода электричества\? Это записано в техпаспорте/);
  await h.press(1, 'Два независимых');
  await h.press(1, 'Позвонил');
  await h.text(1, '12');
  await h.press(1, '3 ч назад');
  await h.press(1, 'Свет дали');
  await h.press(1, 'Только что');
  const text = claimText(h, 1);
  assert.match(text, /при наличии двух независимых взаимно резервирующих источников питания\)/);
  assert.doesNotMatch(text, /лифт|9 этажей/);
  assert.equal(h.db.houseInfo(h.db.listUserHouses(1)[0]).twoPowerSources, true);
  h.close();
});

test('в текстах бота и приложения нет разделителя «·»', () => {
  for (const f of ['src/bot/core.ts', 'src/bot/house.ts', 'src/bot/dispatch.ts', 'src/bot/photos.ts', 'src/bot/acts.ts', 'src/bot/escalate.ts', 'src/bot/ui.ts', 'src/bot/mail.ts', 'public/app/app.js']) {
    assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /·/, f);
  }
});
