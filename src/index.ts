import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Bot } from '@maxhub/max-bot-api';
import { loadConfig } from './config.ts';
import { loadNorms } from './calc/norms.ts';
import { Db } from './db/db.ts';
import { Vernem } from './bot/core.ts';
import { MaxOutbox, wireBot } from './bot/max-adapter.ts';
import type { Outbox } from './bot/types.ts';
import { Scheduler } from './scheduler.ts';
import { createApp } from './web/server.ts';
import { trustRussianRootCa } from './tls.ts';

const WEBHOOK_PATH = '/webhook/max';

async function main() {
  // До первого запроса к MAX: сервер Bot API подписан российским корневым сертификатом.
  console.log(`[vernem] TLS: ${trustRussianRootCa()}`);
  const cfg = loadConfig();
  const norms = loadNorms(cfg.normsPath);
  const db = new Db(cfg.dbPath);
  console.log(`[vernem] нормы: ${norms.source.title}, проверены ${norms.source.checked_at}; БД: ${cfg.dbPath}`);

  let botStatus = cfg.token ? 'starting' : 'disabled (нет MAX_BOT_TOKEN)';
  let maxBot: Bot | null = null;
  let webhookHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;

  const outbox: Outbox = cfg.token
    ? new MaxOutbox((maxBot = new Bot(cfg.token)).api, () => cfg.botUsername)
    : {
        async toUser(userId, msg) {
          console.log(`[offline → user ${userId}] ${msg.text.slice(0, 120)}`);
          return {};
        },
        async toChat(chatId, msg) {
          console.log(`[offline → chat ${chatId}] ${msg.text.slice(0, 120)}`);
          return {};
        },
      };

  const vernem = new Vernem(db, norms, outbox, {
    botUsername: cfg.botUsername,
    publicUrl: cfg.publicUrl,
    miniAppEnabled: cfg.miniAppEnabled,
    demoMode: cfg.demoMode,
    fastReminders: cfg.fastReminders,
    restoreCheckHours: cfg.restoreCheckHours,
    receiptCheckDays: cfg.receiptCheckDays,
    defaultTz: cfg.defaultTz,
    adminIds: cfg.adminIds,
    tmpDir: cfg.tmpDir,
    partnerName: cfg.partnerName,
    partnerUrl: cfg.partnerUrl,
  });

  // ---------- HTTP ----------
  // Без токена сценарий работает офлайн (сообщения бота пишутся в лог) — для проверки мини-приложения локально.
  const app = createApp({ db, norms, cfg, bot: () => (!cfg.token || botStatus.startsWith('running') ? vernem : null), botStatus: () => botStatus });
  const server = createServer((req, res) => {
    if (req.url === WEBHOOK_PATH && webhookHandler) return webhookHandler(req, res);
    app(req, res);
  });
  await new Promise<void>((ok) => server.listen(cfg.port, ok));
  console.log(`[vernem] HTTP на порту ${cfg.port}${cfg.publicUrl ? `, публичный адрес ${cfg.publicUrl}` : ''}`);

  // ---------- бот ----------
  async function startBot(): Promise<void> {
    if (!maxBot) return;
    const bot = maxBot;
    try {
      bot.botInfo = await bot.api.getMyInfo();
      if (!cfg.botUsername) cfg.botUsername = bot.botInfo.username ?? '';
      (vernem.cfg as { botUsername: string }).botUsername = cfg.botUsername;
      console.log(`[vernem] бот @${cfg.botUsername} (id ${bot.botInfo.user_id})`);
      wireBot(bot, (input) => vernem.handle(input));
      await bot.api
        .setMyCommands([
          { name: 'start', description: 'Начать / главное меню' },
          { name: 'cases', description: 'Мои случаи' },
          { name: 'house', description: 'Мой дом: соседи и уведомления' },
          { name: 'help', description: 'Как это работает' },
          { name: 'delete_me', description: 'Удалить мои данные' },
        ])
        .catch((e) => console.warn('[vernem] команды не установлены', e?.message));

      if (cfg.botMode === 'webhook') {
        webhookHandler = await bot.createWebhook({ domain: cfg.publicUrl!, path: WEBHOOK_PATH, secret: cfg.webhookSecret });
        botStatus = 'running (webhook)';
      } else {
        botStatus = 'running (polling)';
        void bot.start({ mode: 'polling' });
      }
      console.log(`[vernem] бот запущен: ${botStatus}`);
    } catch (e) {
      botStatus = `error: ${(e as Error)?.message ?? e}; повтор через 30 с`;
      console.error('[vernem] бот не запустился, повторю через 30 с', e);
      setTimeout(() => void startBot(), 30_000);
    }
  }
  await startBot();

  const scheduler = new Scheduler(db, vernem, cfg.schedulerIntervalSec);
  scheduler.start();

  // ---------- остановка ----------
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[vernem] ${signal}: останавливаюсь`);
    scheduler.stop();
    try {
      if (maxBot && cfg.botMode === 'polling') maxBot.stopPolling();
    } catch {
      /* уже остановлен */
    }
    server.close();
    db.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => console.error('[vernem] unhandledRejection', e));
}

main().catch((e) => {
  console.error('[vernem] не удалось запуститься:', e?.message ?? e);
  process.exit(1);
});
