// Локальный демо-стенд одной командой (`npm run demo`): без токена MAX, с демо-делами.
// Мини-приложение открывается в обычном браузере: http://localhost:3000/app/?demo=1
// Отдельная БД data/demo.db — рабочая data/vernem.db не трогается. Удалите demo.db, чтобы начать заново.

import { existsSync } from 'node:fs';

process.env.DB_PATH ||= 'data/demo.db';
process.env.MAX_BOT_TOKEN = '';
process.env.PUBLIC_URL = '';
process.env.ALLOW_DEMO_AUTH = 'true';

if (!existsSync(process.env.DB_PATH)) await import('./seed-demo.ts');
await import('../index.ts');
console.log(`[demo] Мини-приложение: http://localhost:${process.env.PORT || 3000}/app/?demo=1`);
