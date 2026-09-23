import type { Db } from './db/db.ts';
import type { Vernem } from './bot/core.ts';

/**
 * Раз в N секунд забирает наступившие напоминания и уведомления соседей из БД и отправляет их.
 * Всё хранится в SQLite, поэтому переживает перезапуск контейнера.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly db: Db;
  private readonly bot: Vernem;
  private readonly intervalSec: number;

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
          console.error('[scheduler] напоминание', r.id, e);
        }
      }
      done += await this.bot.flushAlerts();
    } finally {
      this.running = false;
    }
    return done;
  }
}
