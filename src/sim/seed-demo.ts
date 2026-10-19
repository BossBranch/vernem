// Наполняет БД демонстрационными делами для одного жителя, чтобы показать мини-приложение.
// Запуск: DB_PATH=data/vernem.db DEMO_USER_ID=900000001 npm run seed:demo
// Сами дела создаёт resetDemoCases (src/sim/demo-cases.ts) — та же функция, что у кнопки «Демо заново».

import { Db } from '../db/db.ts';
import { resetDemoCases } from './demo-cases.ts';

const userId = Number(process.env.DEMO_USER_ID ?? 900000001);
const dbPath = process.env.DB_PATH ?? 'data/vernem.db';

const db = new Db(dbPath);
db.ensureUser(userId, 'Демо');
await resetDemoCases(db, userId);
db.close();
console.log(`Демо-данные для жителя ${userId} записаны в ${dbPath}`);
