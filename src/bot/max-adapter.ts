import { Bot, Keyboard } from '@maxhub/max-bot-api';
import type { Api } from '@maxhub/max-bot-api';
import type { Btn, Input, OutMessage, Outbox, Sent } from './types.ts';

type AttachmentRequest = NonNullable<Parameters<Api['sendMessageToUser']>[2]>['attachments'];

export class MaxOutbox implements Outbox {
  private readonly api: Api;
  private readonly botUsername: () => string;

  constructor(api: Api, botUsername: () => string) {
    this.api = api;
    this.botUsername = botUsername;
  }

  private toButton(b: Btn) {
    switch (b.type) {
      case 'callback':
        return Keyboard.button.callback(b.text, b.payload);
      case 'link':
        return Keyboard.button.link(b.text, b.url);
      case 'app':
        return Keyboard.button.openApp(b.text, this.botUsername(), undefined, b.payload);
    }
  }

  private async attachments(msg: OutMessage): Promise<AttachmentRequest> {
    const list: NonNullable<AttachmentRequest> = [];
    if (msg.file) {
      const file = await this.api.uploadFile({ source: msg.file.path, timeout: 30_000 });
      list.push(file.toJson());
    }
    if (msg.buttons?.length) list.push(Keyboard.inlineKeyboard(msg.buttons.map((row) => row.map((b) => this.toButton(b)))));
    return list.length ? list : undefined;
  }

  async toUser(userId: number, msg: OutMessage): Promise<Sent> {
    const res = await this.api.sendMessageToUser(userId, msg.text, { attachments: await this.attachments(msg), format: 'markdown' });
    return { mid: res?.body?.mid };
  }

  async toChat(chatId: number, msg: OutMessage): Promise<Sent> {
    const res = await this.api.sendMessageToChat(chatId, msg.text, { attachments: await this.attachments(msg), format: 'markdown' });
    return { mid: res?.body?.mid };
  }
}

const nameOf = (u?: { first_name?: string; name?: string } | null) => u?.first_name || u?.name || undefined;

/** Подписывает бота на события MAX и переводит их во внутренние Input. */
export function wireBot(bot: Bot, handle: (input: Input) => Promise<void>) {
  bot.on('bot_started', async (ctx) => {
    const user = ctx.user;
    if (!user) return;
    await handle({ kind: 'start', userId: user.user_id, name: nameOf(user), payload: ctx.startPayload ?? null });
  });

  bot.on('message_callback', async (ctx) => {
    const cbk = ctx.callback;
    // Пустое уведомление снимает индикатор загрузки на кнопке.
    await ctx.answerOnCallback({ notification: '' } as any).catch((e: unknown) => console.warn('[max] answer callback', (e as Error)?.message));
    if (!cbk?.payload) return;
    const chatType = ctx.message?.recipient?.chat_type;
    if (chatType && chatType !== 'dialog') return;
    await handle({ kind: 'button', userId: cbk.user.user_id, name: nameOf(cbk.user), payload: cbk.payload });
  });

  bot.on('message_created', async (ctx) => {
    const m = ctx.message;
    const sender = m.sender;
    if (!sender || sender.is_bot) return;
    const text = m.body?.text ?? '';
    if (m.recipient.chat_type === 'dialog') {
      // Фото (в том числе с подписью) — доказательство к случаю: сохраняем токен, чтобы переслать позже.
      const photos = ((m.body?.attachments ?? []) as { type: string; payload?: { token?: string; url?: string } }[])
        .filter((a) => a.type === 'image' && a.payload?.token)
        .map((a) => ({ token: a.payload!.token!, url: a.payload!.url ?? null }));
      if (photos.length) {
        await handle({ kind: 'photo', userId: sender.user_id, name: nameOf(sender), photos });
        return;
      }
      if (!text) {
        await handle({ kind: 'text', userId: sender.user_id, name: nameOf(sender), text: '' });
        return;
      }
      await handle({ kind: 'text', userId: sender.user_id, name: nameOf(sender), text });
      return;
    }
    if (m.recipient.chat_type === 'chat' && m.recipient.chat_id && text.startsWith('/')) {
      await handle({ kind: 'group_text', chatId: m.recipient.chat_id, userId: sender.user_id, name: nameOf(sender), text });
    }
  });

  bot.on('bot_added', async (ctx) => {
    if ((ctx.update as any).is_channel) return;
    const chatId = ctx.chatId as number;
    let title: string | null = null;
    try {
      title = (await ctx.getChat()).title;
    } catch {
      /* название чата не обязательно */
    }
    await handle({ kind: 'group_added', chatId, title });
  });

  bot.on('bot_removed', async (ctx) => {
    await handle({ kind: 'group_removed', chatId: ctx.chatId as number });
  });

  // Ошибка в одном событии не должна останавливать бота.
  bot.catch((err, ctx) => {
    console.error('[max] ошибка обработки события', ctx?.update?.update_type, err);
  });
}
