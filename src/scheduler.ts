import type { Db } from './db/db.ts';
import type { Vernem } from './bot/core.ts';

/** Через сколько повторяем напоминание, которое MAX не принял (сеть, перегрузка). */
const RETRY_MIN = 10;

/**
 * Раз в N секунд забирает наступившие напоминания и уведомления соседей из БД и отправляет их.
 * Всё хранится в SQLite, поэтому переживает перезапуск контейнера. Если сообщение не ушло,
 * напоминание возвращается в очередь и повторяется (не больше MAX_SEND_ATTEMPTS раз).
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly db: Db;
  private readonly bot: Vernem;
  private readonly intervalSec: number;
  private lastHousekeeping = 0;

  constructor(db: Db, bot: Vernem, intervalSec: number) {
    this.db = db;
    this.bot = bot;
    this.intervalSec = intervalSec;
  }

  start() {
    this.timer = setInterval(() => void this.tick(), this.intervalSec * 1000);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = this.bot.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let done = 0;
    try {
      for (const r of this.db.takeDueReminders(now)) {
        try {
          await this.bot.remind(r.kind, r.participant_id);
          done++;
        } catch (e) {
          const again = this.db.retryReminder(r.id, new Date(now.getTime() + RETRY_MIN * 60_000));
          console.error(`[scheduler] напоминание ${r.id} не доставлено${again ? `, повторю через ${RETRY_MIN} мин` : ', попытки кончились'}`, e);
        }
      }
      done += await this.bot.flushAlerts();
      // Раз в час: отключаем сотрудников УК, которые давно ничего не делали.
      if (now.getTime() - this.lastHousekeeping >= 3_600_000) {
        this.lastHousekeeping = now.getTime();
        await this.bot.expireDispatchers();
      }
    } finally {
      this.running = false;
    }
    return done;
  }
}
