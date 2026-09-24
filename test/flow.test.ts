import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Harness } from '../src/sim/harness.ts';
import { fromLocal } from '../src/calc/time.ts';
import { calcFor, claimTextFor, loadCase } from '../src/services/cases.ts';
import { buildActDoc } from '../src/docs/act.ts';

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
  assert.match(doc, /п\. 4 Приложения № 1/);
  assert.match(doc, /телефон, e-mail/);
  assert.match(doc, /Заявитель: /);
  assert.match(doc, /адрес: г\. Москва, ул\. Примерная, д\. 5/);
  assert.match(doc, /Руководителю управляющей организации/);
  assert.match(doc, /Отметка о принятии/);

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

test('плановое отключение горячей воды — денег не обещаем', async () => {
  const h = new Harness({ start: START });
  await h.start(1);
  await h.press(1, 'Что-то сломалось');
  await h.press(1, 'Нет горячей воды');
  await typeAddress(h, 1, 'Ленина 3');
  await h.press(1, 'По плану');
  assert.match(textOf(h, 1), /не обещаю/);
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

async function finishWithClaim(h: Harness, user: number, opts: { executor?: string } = {}) {
  await h.press(user, 'Воду дали');
  await h.press(user, 'Только что');
  await h.text(user, '1200');
  await h.press(user, 'УК / ТСЖ');
  await h.text(user, 'Иванов Иван Иванович');
  await h.text(user, '42');
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
  assert.match(h.last(1).text, /подписали хотя бы 2 жителя/);
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

  await h.press(1, 'Акт подписан');
  await h.press(1, 'Да, без председателя');
  assert.equal(h.db.getAct(act.id)!.status, 'signed');
  assert.match(claimText(h, 1), /подписанным потребителями без участия исполнителя/);
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
  await h.advance(31 * 24 * H);
  await h.press(1, 'Да, вернули');
  await h.text(1, '40');
  assert.match(h.last(1).text, /положено ≈ 77,40 ₽, а вернули 40 ₽/);
  await h.press(1, 'Потребовать остальное');
  assert.match(h.last(1).text, /Перерасчёт сделали не полностью/);
  assert.match(h.last(1).text, /Штраф ≈ 18,70 ₽/); // (77,40 − 40) × 50%
  h.close();
});
