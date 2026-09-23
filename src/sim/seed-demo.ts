// Наполняет БД демонстрационными случаями для одного жителя, чтобы показать мини-приложение.
// Запуск: DB_PATH=data/vernem.db DEMO_USER_ID=900000001 npm run seed:demo
// Все случаи создаются через обычный сценарий бота и помечаются как демо.

import { Harness } from './harness.ts';

const userId = Number(process.env.DEMO_USER_ID ?? 900000001);
const dbPath = process.env.DB_PATH ?? 'data/vernem.db';
const H = 3_600_000;

const h = new Harness({ dbPath, start: new Date(Date.now() - 40 * 24 * H) });
h.out.onSend = () => {};

// 1. Горячая вода 40 дней назад: заявление подано, перерасчёт пришёл.
await h.start(userId);
await h.press(userId, 'Демо');
await h.press(userId, 'Воду дали');
await h.press(userId, 'Только что');
await h.text(userId, '1200');
await h.press(userId, 'УК / ТСЖ');
await h.text(userId, 'Демо Иван Иванович');
await h.text(userId, '42');
await h.press(userId, 'Пропустить');
await h.text(userId, 'ООО «УК Пример» (демо)');
await h.press(userId, 'Запомнить');
await h.advance(31 * 24 * H);
await h.press(userId, 'Да, вернули');
await h.text(userId, '115,20');

// 2. Снова горячая вода 5 дней назад: заявление готово, ждём квитанцию.
await h.advance(4 * 24 * H);
await h.press(userId, 'Демо');
await h.press(userId, 'Воду дали');
await h.press(userId, 'Только что');
await h.text(userId, '1250');
await h.press(userId, 'УК / ТСЖ');
await h.press(userId, 'Да');
await h.press(userId, 'Пропустить');

// 3. Сейчас: демо-отключение, за которым бот ещё следит.
await h.advance(5 * 24 * H - 2 * H);
await h.press(userId, 'Демо');

// 4. Демо-адрес в «Мои адреса» с заполненной карточкой дома (все названия помечены как демо).
const demoHouse = h.db.upsertHouse('ДЕМО: ул. Примерная, 5', 'Europe/Moscow', 1);
h.db.addUserHouse(userId, demoHouse.id);
h.db.setUserHouse(userId, demoHouse.id, { entrance: '2' });
h.db.setHouseInfo(demoHouse.id, {
  ukName: 'ООО «УК Пример» (демо)',
  ukInn: '7700000000',
  adsPhone: '+7 000 000-00-00 (демо)',
  rsoHeat: 'АО «Теплосеть» (демо)',
  rsoWater: 'УК',
  updatedAt: h.now().toISOString(),
  updatedBy: userId,
});

h.close();
console.log(`Демо-данные для жителя ${userId} записаны в ${dbPath}`);
