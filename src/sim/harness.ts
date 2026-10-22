// Стенд без MAX: ядро бота + SQLite + «часы», которые можно перематывать.
// Используется терминальным симулятором (npm run sim) и сквозными тестами сценария.

import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../db/db.ts';
import { loadNorms } from '../calc/norms.ts';
import { Vernem } from '../bot/core.ts';
import type { BotConfig, Btn, OutMessage, Outbox, Sent } from '../bot/types.ts';
import { Scheduler } from '../scheduler.ts';

export type Record_ = { to: 'user' | 'chat'; id: number; msg: OutMessage; mid: string };

export class RecordingOutbox implements Outbox {
  log: Record_[] = [];
  private n = 0;
  onSend?: (r: Record_) => void;
  failChats = new Set<number>();
  /** Эти жители «недоступны»: MAX не принимает им сообщения. */
  failUsers = new Set<number>();
  /** Бот удаляет PDF сразу после отправки — стенд оставляет себе копию, чтобы её можно было проверить. */
  private keepDir: string | null = null;

  async toUser(userId: number, msg: OutMessage): Promise<Sent> {
    if (this.failUsers.has(userId)) throw new Error('user.unavailable');
    if (msg.file) {
      this.keepDir ??= mkdtempSync(join(tmpdir(), 'vernem-sent-'));
      const copy = join(this.keepDir, `${this.n + 1}-${msg.file.name}`);
      copyFileSync(msg.file.path, copy);
      msg = { ...msg, file: { ...msg.file, path: copy } };
    }
    const r = { to: 'user' as const, id: userId, msg, mid: `mid.${++this.n}` };
    this.log.push(r);
    this.onSend?.(r);
    return { mid: r.mid };
  }

  async toChat(chatId: number, msg: OutMessage): Promise<Sent> {
    if (this.failChats.has(chatId)) throw new Error('chat.denied');
    const r = { to: 'chat' as const, id: chatId, msg, mid: `mid.${++this.n}` };
    this.log.push(r);
    this.onSend?.(r);
    return { mid: r.mid };
  }
}

/**
 * db — работать поверх уже открытой базы (демо-дела настоящему жителю): тогда стенд её не закрывает.
 * quiet — не подменять имя жителя и не запускать планировщик при перемотке часов:
 * иначе напоминания других жителей из той же базы ушли бы в никуда.
 */
export type HarnessOptions = { dbPath?: string; db?: Db; quiet?: boolean; start?: Date; config?: Partial<BotConfig> };

export class Harness {
  readonly db: Db;
  readonly out = new RecordingOutbox();
  readonly bot: Vernem;
  readonly scheduler: Scheduler;
  private clock: number;
  private readonly ownDb: boolean;
  private readonly quiet: boolean;

  constructor(opts: HarnessOptions = {}) {
    this.ownDb = !opts.db;
    this.quiet = !!opts.quiet;
    this.db = opts.db ?? new Db(opts.dbPath ?? ':memory:');
    this.clock = (opts.start ?? new Date()).getTime();
    this.bot = new Vernem(
      this.db,
      loadNorms(),
      this.out,
      {
        botUsername: 'vernem_demo_bot',
        publicUrl: null,
        miniAppEnabled: false,
        demoMode: true,
        fastReminders: false,
        restoreCheckHours: 3,
        receiptCheckDays: 30,
        defaultTz: 'Europe/Moscow',
        adminIds: [1],
        tmpDir: mkdtempSync(join(tmpdir(), 'vernem-')),
        signedScanDir: mkdtempSync(join(tmpdir(), 'vernem-scans-')),
        ...opts.config,
      },
      () => new Date(this.clock),
    );
    this.scheduler = new Scheduler(this.db, this.bot, 30);
  }

  now() {
    return new Date(this.clock);
  }

  /** Перематывает часы и отрабатывает наступившие напоминания. */
  async advance(ms: number) {
    this.clock += ms;
    return this.quiet ? 0 : this.scheduler.tick(this.now());
  }

  private name(userId: number) {
    return this.quiet ? undefined : `User${userId}`;
  }

  last(userId: number): OutMessage {
    const r = [...this.out.log].reverse().find((x) => x.to === 'user' && x.id === userId);
    if (!r) throw new Error(`Пользователю ${userId} ничего не отправлено`);
    return r.msg;
  }

  sentTo(userId: number, since = 0): OutMessage[] {
    return this.out.log.slice(since).filter((x) => x.to === 'user' && x.id === userId).map((x) => x.msg);
  }

  /** Все кнопки, отправленные пользователю, начиная с позиции since (последние — в конце). */
  buttons(userId: number, since = 0): Btn[] {
    return this.sentTo(userId, since).flatMap((m) => (m.buttons ?? []).flat());
  }

  start(userId: number, payload?: string) {
    return this.bot.handle({ kind: 'start', userId, name: this.name(userId), payload });
  }

  text(userId: number, text: string) {
    return this.bot.handle({ kind: 'text', userId, name: this.name(userId), text });
  }

  /** Житель присылает фото (в MAX — вложение image с токеном). */
  photo(userId: number, token = 'photo-token') {
    return this.bot.handle({ kind: 'photo', userId, name: this.name(userId), photos: [{ token, url: `https://example.invalid/${token}.jpg` }] });
  }

  /** Файлы, отправленные пользователю, начиная с позиции since. */
  files(userId: number, since = 0) {
    return this.sentTo(userId, since).flatMap((m) => (m.file ? [m.file] : []));
  }

  /** Последняя отправленная пользователю ссылка, содержащая needle. */
  lastLink(userId: number, needle: string): string {
    const b = [...this.buttons(userId)].reverse().find((x) => x.type === 'link' && x.url.includes(needle));
    if (!b || b.type !== 'link') throw new Error(`Ссылка с «${needle}» не найдена`);
    return b.url;
  }

  /** Нажимает последнюю отправленную кнопку, текст которой содержит needle. */
  async press(userId: number, needle: string) {
    const btn = [...this.buttons(userId)].reverse().find((b) => b.text.includes(needle));
    if (!btn) {
      const avail = this.buttons(userId).slice(-12).map((b) => b.text).join(' | ');
      throw new Error(`Кнопка «${needle}» не найдена. Последние кнопки: ${avail}`);
    }
    if (btn.type !== 'callback') throw new Error(`«${needle}» — не callback-кнопка (${btn.type})`);
    return this.bot.handle({ kind: 'button', userId, name: this.name(userId), payload: btn.payload });
  }

  close() {
    if (this.ownDb) this.db.close();
  }
}
