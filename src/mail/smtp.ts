// Отправка письма по SMTP без сторонних библиотек: TLS (порт 465) или STARTTLS, вход AUTH PLAIN,
// письмо в UTF-8 с вложениями (PDF заявления). Без шифрования вход разрешён только на localhost (тесты).

import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';

export type MailConfig = { host: string; port: number; user: string; pass: string; from: string; fromName: string };
export type Attachment = { filename: string; content: Buffer; contentType: string };
export type Mail = { to: string; cc?: string | null; replyTo?: string | null; subject: string; text: string; attachments?: Attachment[] };

const EMAIL_RE = /^[^@\s<>,;"']+@[^@\s<>,;"']+\.[^@\s<>,;"']+$/;
export const isEmail = (s: string | null | undefined): s is string => !!s && s.length <= 254 && EMAIL_RE.test(s);

/** Настройки из окружения: без SMTP_HOST, SMTP_USER и SMTP_PASS отправка выключена. */
export function mailConfigFrom(env: NodeJS.ProcessEnv): MailConfig | null {
  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS ?? '';
  if (!host || !user || !pass) return null;
  const from = env.SMTP_FROM?.trim() || user;
  if (!isEmail(from)) throw new Error('SMTP_FROM: нужен адрес почты, например vernem@example.ru');
  const port = Number(env.SMTP_PORT || 465);
  if (!Number.isInteger(port) || port <= 0) throw new Error('SMTP_PORT: номер порта, обычно 465');
  return { host, port, user, pass, from, fromName: env.SMTP_FROM_NAME?.trim() || 'Вернём' };
}

const b64 = (s: string | Buffer) => (typeof s === 'string' ? Buffer.from(s, 'utf8') : s).toString('base64');
const wrap76 = (s: string) => s.replace(/.{1,76}/g, (m) => m + '\r\n');
/** Заголовок с кириллицей: =?UTF-8?B?…?= */
const word = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export function buildMessage(cfg: MailConfig, mail: Mail, now = new Date()): { data: string; messageId: string } {
  for (const a of [mail.to, mail.cc, mail.replyTo]) if (a && !isEmail(a)) throw new Error(`Неверный адрес почты: ${a}`);
  const domain = cfg.from.split('@')[1];
  const messageId = `<${randomBytes(12).toString('hex')}@${domain}>`;
  const boundary = `vernem-${randomBytes(9).toString('hex')}`;
  const headers = [
    `From: ${word(cfg.fromName)} <${cfg.from}>`,
    `To: <${mail.to}>`,
    mail.cc ? `Cc: <${mail.cc}>` : '',
    mail.replyTo ? `Reply-To: <${mail.replyTo}>` : '',
    `Subject: ${word(mail.subject.replace(/[\r\n]+/g, ' '))}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean);
  const parts = [
    [`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(mail.text))].join('\r\n'),
    ...(mail.attachments ?? []).map((a) =>
      [
        `--${boundary}`,
        `Content-Type: ${a.contentType}; name="${word(a.filename)}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${word(a.filename)}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
        '',
        wrap76(b64(a.content)),
      ].join('\r\n'),
    ),
  ];
  return { data: `${headers.join('\r\n')}\r\n\r\n${parts.join('')}--${boundary}--\r\n`, messageId };
}

/** Читает ответы SMTP-сервера: многострочный ответ заканчивается строкой «250 …» (код и пробел). */
class Conversation {
  private buf = '';
  private waiters: ((line: string) => void)[] = [];
  private lines: string[] = [];
  private failure: Error | null = null;
  socket: Socket | TLSSocket;

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.attach(socket);
  }

  attach(socket: Socket | TLSSocket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setTimeout(20_000, () => this.fail(new Error('SMTP: сервер не отвечает')));
    socket.on('data', (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(line);
        else this.lines.push(line);
      }
    });
    socket.on('error', (e) => this.fail(e));
  }

  /** Новое соединение поверх старого (STARTTLS): старый сокет больше не читаем. */
  detach() {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.setTimeout(0);
  }

  private fail(e: Error) {
    this.failure = e;
    this.socket.destroy();
    for (const w of this.waiters.splice(0)) w(`__error__`);
  }

  private line(): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    const ready = this.lines.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve, reject) => this.waiters.push((l) => (l === '__error__' ? reject(this.failure) : resolve(l))));
  }

  async reply(): Promise<{ code: number; text: string[] }> {
    const text: string[] = [];
    for (;;) {
      const l = await this.line();
      text.push(l.slice(4));
      if (/^\d{3} /.test(l) || /^\d{3}$/.test(l)) return { code: Number(l.slice(0, 3)), text };
    }
  }

  async cmd(line: string, expect: number[], what = line.split(' ')[0]): Promise<string[]> {
    this.socket.write(line + '\r\n');
    const r = await this.reply();
    if (!expect.includes(r.code)) throw new Error(`SMTP ${what}: ${r.code} ${r.text.join(' ')}`.slice(0, 300));
    return r.text;
  }
}

function open(host: string, port: number, tls: boolean): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tls ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
    s.once(tls ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', reject);
  });
}

function upgrade(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ socket, servername: host });
    s.once('secureConnect', () => resolve(s));
    s.once('error', reject);
  });
}

export async function sendMail(cfg: MailConfig, mail: Mail): Promise<{ messageId: string }> {
  const { data, messageId } = buildMessage(cfg, mail);
  const implicitTls = cfg.port === 465;
  const local = cfg.host === 'localhost' || cfg.host === '127.0.0.1';
  const conv = new Conversation(await open(cfg.host, cfg.port, implicitTls));
  try {
    const hello = await conv.reply();
    if (hello.code !== 220) throw new Error(`SMTP: ${hello.code} ${hello.text.join(' ')}`);
    let ext = await conv.cmd('EHLO vernem', [250]);
    if (!implicitTls) {
      if (ext.some((e) => /^STARTTLS/i.test(e))) {
        await conv.cmd('STARTTLS', [220]);
        conv.detach();
        conv.attach(await upgrade(conv.socket as Socket, cfg.host));
        ext = await conv.cmd('EHLO vernem', [250]);
      } else if (!local) {
        throw new Error('SMTP: сервер не поддерживает шифрование (STARTTLS) — пароль не отправляю');
      }
    }
    await conv.cmd(`AUTH PLAIN ${b64(`\u0000${cfg.user}\u0000${cfg.pass}`)}`, [235], 'AUTH');
    await conv.cmd(`MAIL FROM:<${cfg.from}>`, [250]);
    for (const rcpt of [mail.to, mail.cc].filter(Boolean)) await conv.cmd(`RCPT TO:<${rcpt}>`, [250, 251], 'RCPT');
    await conv.cmd('DATA', [354]);
    // Точка в начале строки удваивается — иначе сервер примет её за конец письма.
    await conv.cmd(data.replace(/\r\n\./g, '\r\n..') + '.', [250], 'DATA');
    await conv.cmd('QUIT', [221]).catch(() => undefined);
    return { messageId };
  } finally {
    conv.socket.destroy();
  }
}
