// Терминальный симулятор: проверка сценария без MAX и без токена.
// Запуск: npm run sim
//   цифра     — нажать кнопку с этим номером
//   текст     — отправить сообщение
//   :wait 3h  — перемотать время (m — минуты, h — часы, d — дни) и отработать напоминания
//   :user 2   — переключиться на другого жителя (сосед)
//   :link     — перейти по последней ссылке (карточка отключения, сеть дома, акт для председателя)
//   :photo    — прислать фото от лица текущего жителя
//   :quit     — выход

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Harness } from './harness.ts';
import type { Btn } from '../bot/types.ts';

const h = new Harness({ dbPath: process.env.SIM_DB ?? ':memory:' });
let user = 1;
let lastButtons: Btn[] = [];

const bold = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '\x1b[1m$1\x1b[0m');

h.out.onSend = (r) => {
  const who = r.to === 'chat' ? `чат ${r.id}` : `житель ${r.id}`;
  console.log(`\n\x1b[36m── бот → ${who} ──\x1b[0m\n${bold(r.msg.text)}`);
  if (r.msg.file) console.log(`\x1b[33m📎 файл: ${r.msg.file.path}\x1b[0m`);
  if (r.to === 'user' && r.id === user && r.msg.buttons?.length) {
    lastButtons = r.msg.buttons.flat();
    lastButtons.forEach((b, i) => {
      const extra = b.type === 'link' ? ` (ссылка: ${b.url})` : b.type === 'app' ? ' (мини-приложение)' : '';
      console.log(`  \x1b[32m[${i + 1}]\x1b[0m ${b.text}${extra}`);
    });
  }
};

const rl = createInterface({ input: stdin, output: stdout });
console.log('Симулятор «Вернём». Цифра — нажать кнопку, текст — написать, :wait 3h, :user 2, :link, :photo, :quit');
await h.start(user);

const prompt = () => stdout.write(`\n[житель ${user} · ${h.now().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}] > `);
prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (!line) {
    prompt();
    continue;
  }
  await handleLine(line);
  if (line === ':quit') break;
  prompt();
}
rl.close();
h.close();

async function handleLine(line: string): Promise<void> {
  if (line === ':quit') return;
  if (line.startsWith(':wait')) {
    const m = /^:wait\s+(\d+)([mhd])$/.exec(line);
    if (!m) {
      console.log('Формат: :wait 30m | :wait 3h | :wait 2d');
      return;
    }
    const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
    const n = await h.advance(ms);
    console.log(`(прошло ${m[1]}${m[2]}, напоминаний: ${n})`);
    return;
  }
  if (line.startsWith(':user')) {
    user = Number(line.split(/\s+/)[1]) || 1;
    lastButtons = [];
    console.log(`(теперь пишет житель ${user})`);
    return;
  }
  if (line === ':photo') {
    await h.photo(user, `sim-${Date.now()}`);
    return;
  }
  if (line === ':link') {
    const linkBtn = [...h.out.log].reverse().flatMap((r) => (r.msg.buttons ?? []).flat()).find((b) => b.type === 'link' && b.url.includes('start='));
    if (!linkBtn || linkBtn.type !== 'link') {
      console.log('Карточки со ссылкой ещё нет.');
      return;
    }
    await h.start(user, new URL(linkBtn.url).searchParams.get('start') ?? undefined);
    return;
  }
  const idx = Number(line);
  if (Number.isInteger(idx) && idx >= 1 && idx <= lastButtons.length) {
    const b = lastButtons[idx - 1];
    if (b.type === 'callback') await h.bot.handle({ kind: 'button', userId: user, payload: b.payload });
    else console.log(b.type === 'link' ? `(это ссылка: ${b.url}; для карточки соседа используйте :user 2 и :link)` : '(мини-приложение в симуляторе не открывается)');
    return;
  }
  await h.text(user, line);
}
