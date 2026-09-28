/**
 * Подписанная initData для проверки REST без MAX (заголовок X-Max-Init-Data):
 *   npm run init-data               — тестовый житель 900000002
 *   npm run init-data -- 900000003  — другой тестовый житель
 * Подпись — токеном бота из MAX_BOT_TOKEN (.env), как у MAX. Сам токен не печатается. Строка действует 24 часа.
 */
import { signInitData } from '../web/auth.ts';

const token = process.env.MAX_BOT_TOKEN;
if (!token) {
  console.error('Нужен MAX_BOT_TOKEN в .env — тот же токен, что у сервера (npm run setup создаст .env)');
  process.exit(1);
}
const id = Number(process.argv[2] ?? 900000002);
if (!Number.isSafeInteger(id) || id <= 0) {
  console.error('ID жителя — положительное число, например 900000002');
  process.exit(1);
}
console.log(
  signInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: 'api-check',
      user: JSON.stringify({ id, first_name: 'Проверка API', last_name: '', username: null, language_code: 'ru', photo_url: null }),
      chat: JSON.stringify({ id, type: 'DIALOG' }),
    },
    token,
  ),
);
