// Три демо-дела для жителя — те же, что на стенде (npm run demo). Создаются обычным сценарием бота
// на отдельных «часах» и помечаются как демо:
//   демо 1 — дозвонились, есть номер заявки: заявление готово;
//   демо 2 — не дозвонились: акт с соседями собран, осталось отметить «подписан» и «Воду дали»;
//   демо 3 — архив: заявление подано, вернули меньше положенного (видно, как потребовать остальное).
// Прежние демо-дела жителя удаляются, настоящие дела, ФИО и состояние диалога не трогаются.

import type { Db } from '../db/db.ts';
import { Harness } from './harness.ts';

const H = 3_600_000;
export const DEMO_HOUSE = 'ДЕМО: ул. Примерная, 5';

export async function resetDemoCases(db: Db, userId: number, now = new Date()): Promise<number> {
  for (const p of db.listUserParticipants(userId)) {
    if (db.getIncident(p.incident_id)?.demo) db.deleteParticipant(p.id);
  }
  // Сценарий нажимает «Запомнить» и меняет состояние диалога — после него всё вернём как было.
  const before = db.getUser(userId);
  const state = db.getState<object>(userId);
  // Сохранённые ФИО жителя бот предложил бы вместо демо-данных — на время сценария убираем их.
  db.updateUser(userId, { fio: null, save_personal: 0 });

  const h = new Harness({ db, quiet: true, start: new Date(now.getTime() - 40 * 24 * H) });
  h.out.onSend = () => {};
  try {
    // Демо-адрес с квартирой и заполненной карточкой дома (все названия помечены как демо).
    // Карточка — до дел: из неё бот сам подставляет получателя в заявление.
    const house = db.upsertHouse(DEMO_HOUSE, 'Europe/Moscow', 1);
    db.addUserHouse(userId, house.id);
    db.setUserHouse(userId, house.id, { entrance: '2', flat: '42' });
    db.setHouseInfo(house.id, {
      ukName: 'ООО «УК Пример» (демо)',
      ukInn: '7700000009',
      // Без «(демо)»: иначе проверка телефона не даст сохранить карточку демо-дома. Демо видно по адресу и УК.
      adsPhone: '+7 000 000-00-00',
      rsoHeat: 'УК',
      rsoWater: 'УК',
      updatedAt: h.now().toISOString(),
      updatedBy: userId,
    });
    const mine = () => db.listUserParticipants(userId).filter((p) => db.getIncident(p.incident_id)?.demo);

    // Демо 3, архив: горячая вода 40 дней назад — заявление подано, перерасчёт пришёл, но меньше положенного.
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
    const archive = mine()[0];
    // Подали на следующий день — дата и входящий номер попадут в требование и жалобу (без пустых «___»).
    await h.advance(24 * H);
    db.updateParticipant(archive.id, { claim: JSON.stringify({ ...JSON.parse(db.getParticipant(archive.id)!.claim!), submittedAt: h.now().toISOString(), incomingNumber: 'ДЕМО-118' }) });
    await h.advance(30 * 24 * H);
    await h.bot.remind('ask_receipt', archive.id);
    await h.press(userId, 'Да, вернули');
    await h.text(userId, '60');
    // Метка «демо 3» — по виду демо, а не по статусу: сняли отметку «вернули» — дело всё равно «демо 3».
    db.setIncidentDemo(archive.incident_id, 3);

    // Демо 1 — есть номер заявки: горячая вода 5 дней назад, заявление готово (другой месяц — расчёты не складываются).
    await h.advance(4 * 24 * H);
    await h.press(userId, 'Демо');
    await h.press(userId, 'Есть номер заявки');
    await h.press(userId, 'Воду дали');
    await h.press(userId, 'Только что');
    await h.text(userId, '1250');
    await h.press(userId, '✅ Да');
    await h.press(userId, '✅ Да'); // ФИО и квартира — сохранённые

    // Демо 2 — не дозвонились: холодная вода с позавчера, номера нет, акт с соседями собран.
    await h.advance(5 * 24 * H - 2 * H);
    await h.press(userId, 'Демо');
    await h.press(userId, 'Не дозвонились');
    await h.press(userId, 'Акт с соседями');
    await h.press(userId, '✅ Да'); // вписать в акт сохранённые ФИО и квартиру

    // Напоминания демо-дел стоят на «демо-часах» — в настоящем времени они пришли бы все сразу.
    const demo = mine();
    for (const p of demo) db.cancelReminders(p.id);
    return demo.length;
  } finally {
    h.close();
    if (before) db.updateUser(userId, { fio: before.fio, save_personal: before.save_personal });
    db.setState(userId, state.state, state.data ?? {});
  }
}
