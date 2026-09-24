// Наполняет БД демонстрационными случаями для одного жителя, чтобы показать мини-приложение.
// Запуск: DB_PATH=data/vernem.db DEMO_USER_ID=900000001 npm run seed:demo
// Все случаи создаются через обычный сценарий бота и помечаются как демо.
//
// Два главных демо — два пути доказательства:
//   Демо 1 — дозвонились, есть номер заявки: заявление готово;
//   Демо 2 — не дозвонились, номера нет: акт с соседями собран, осталось отметить «подписан» и «Воду дали».
// Плюс архив: прошлое отключение, по которому перерасчёт уже пришёл.

import { Harness } from './harness.ts';

const userId = Number(process.env.DEMO_USER_ID ?? 900000001);
const dbPath = process.env.DB_PATH ?? 'data/vernem.db';
const H = 3_600_000;

const h = new Harness({ dbPath, start: new Date(Date.now() - 40 * 24 * H) });
h.out.onSend = () => {};

// 0. Демо-адрес в «Мои адреса» с квартирой и заполненной карточкой дома (все названия помечены как демо).
// Карточка — до дел: из неё бот сам подставляет получателя в заявление.
const demoHouse = h.db.upsertHouse('ДЕМО: ул. Примерная, 5', 'Europe/Moscow', 1);
h.db.addUserHouse(userId, demoHouse.id);
h.db.setUserHouse(userId, demoHouse.id, { entrance: '2', flat: '42' });
h.db.setHouseInfo(demoHouse.id, {
  ukName: 'ООО «УК Пример» (демо)',
  ukInn: '7700000009',
  adsPhone: '+7 000 000-00-00 (демо)',
  rsoHeat: 'УК',
  rsoWater: 'УК',
  updatedAt: h.now().toISOString(),
  updatedBy: userId,
});

// 1. Архив: горячая вода 40 дней назад — заявление подано, перерасчёт пришёл.
await h.start(userId);
await h.press(userId, 'Демо');
await h.press(userId, 'Есть номер заявки');
await h.press(userId, 'Воду дали');
await h.press(userId, 'Только что');
await h.text(userId, '1200');
await h.press(userId, '✅ Да'); // получатель — из карточки дома
await h.text(userId, 'Демо Иван Иванович');
await h.text(userId, '42');
await h.press(userId, 'Пропустить');
await h.press(userId, 'Запомнить');
await h.advance(31 * 24 * H);
await h.press(userId, 'Да, вернули');
await h.text(userId, '115,20');

// 2. Демо 1 — есть номер заявки: горячая вода 5 дней назад, заявление готово
// (другой месяц, чем архив, — расчёты не складываются).
await h.advance(4 * 24 * H);
await h.press(userId, 'Демо');
await h.press(userId, 'Есть номер заявки');
await h.press(userId, 'Воду дали');
await h.press(userId, 'Только что');
await h.text(userId, '1250');
await h.press(userId, '✅ Да');
await h.press(userId, '✅ Да'); // ФИО и квартира — сохранённые

// 3. Демо 2 — не дозвонились: холодная вода с позавчера, номера нет. Акт с соседями собран —
// осталось отметить «подписан» и «Воду дали», тогда акт попадёт в заявление.
await h.advance(5 * 24 * H - 2 * H);
await h.press(userId, 'Демо');
await h.press(userId, 'Не дозвонились');
await h.press(userId, 'Акт с соседями');
await h.press(userId, '✅ Да'); // вписать в акт сохранённые ФИО и квартиру

h.close();
console.log(`Демо-данные для жителя ${userId} записаны в ${dbPath}`);
