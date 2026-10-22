// Ядро бота не знает про SDK MAX: оно получает события Input и отправляет OutMessage.
// Адаптер MAX (max-adapter.ts) и терминальный симулятор (sim/cli.ts) реализуют Outbox.

import type { MailConfig } from '../mail/smtp.ts';

export type Btn =
  | { type: 'callback'; text: string; payload: string }
  | { type: 'link'; text: string; url: string }
  | { type: 'app'; text: string; payload?: string };

export type OutMessage = {
  text: string;
  buttons?: Btn[][];
  file?: { path: string; name: string };
};

export type Sent = { mid?: string };

export interface Outbox {
  toUser(userId: number, msg: OutMessage): Promise<Sent>;
  toChat(chatId: number, msg: OutMessage): Promise<Sent>;
}

/** Фото из сообщения MAX: token позволяет переслать его повторно, url — временная ссылка. */
export type InPhoto = { token: string; url: string | null };
/** PDF, присланный жителем в личный чат MAX. Содержимое скачивает только ядро после проверки состояния дела. */
export type InFile = { url: string | null; filename: string | null; size: number | null };

export type Input =
  | { kind: 'start'; userId: number; name?: string; payload?: string | null }
  | { kind: 'text'; userId: number; name?: string; text: string }
  | { kind: 'photo'; userId: number; name?: string; photos: InPhoto[] }
  | { kind: 'file'; userId: number; name?: string; file: InFile }
  | { kind: 'button'; userId: number; name?: string; payload: string }
  | { kind: 'group_added'; chatId: number; title?: string | null }
  | { kind: 'group_removed'; chatId: number }
  | { kind: 'group_text'; chatId: number; userId: number; name?: string; text: string };

export type BotConfig = {
  botUsername: string;
  publicUrl: string | null;
  miniAppEnabled: boolean;
  demoMode: boolean;
  fastReminders: boolean;
  restoreCheckHours: number;
  receiptCheckDays: number;
  defaultTz: string;
  adminIds: number[];
  tmpDir: string;
  signedScanDir: string;
  /**
   * Общественное объединение потребителей, которому житель может передать дело
   * (ст. 45–46 Закона «О защите прав потребителей»). Не задано — партнёр не подключён,
   * бот готовит заявление для любого общества защиты прав потребителей.
   */
  partnerName?: string | null;
  partnerUrl?: string | null;
  /** SMTP для отправки заявления на почту УК; null — отправка выключена. */
  mail?: MailConfig | null;
};
