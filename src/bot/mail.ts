// Заявление на почту УК: бот сам отправляет PDF на почту из карточки дома, житель — в копии.
// Дата отправки письма — дата подачи: она попадает в требование и жалобу, если перерасчёт не сделают.
// Отправляем только в УК (почта в карточке дома — почта УК), только с согласия жителя и только с ФИО в заявлении.

import { existsSync, readFileSync } from 'node:fs';
import { claimToPdf } from '../docs/pdf.ts';
import { docAddress } from '../docs/claim.ts';
import { claimDocFor, claimOf, loadCase } from '../services/cases.ts';
import type { CaseBundle } from '../services/cases.ts';
import { formatShort } from '../calc/time.ts';
import { isEmail, sendMail } from '../mail/smtp.ts';
import type { Vernem } from './core.ts';
import { backRow, cb, clean } from './ui.ts';

/** Почта УК, на которую можно отправить заявление, или null. */
export function claimEmailTarget(bot: Vernem, c: CaseBundle): string | null {
  if (!bot.cfg.mail || c.incident.demo) return null;
  const cl = claimOf(c.p);
  // Почта в карточке дома — почта УК; заявление поставщику на неё не отправляем.
  if (cl.executorType && cl.executorType !== 'uk') return null;
  const email = bot.db.houseInfo(c.house).ukEmail?.trim();
  return isEmail(email) ? email : null;
}

export function canEmailClaim(bot: Vernem, c: CaseBundle): boolean {
  return (c.p.status === 'claim_ready' || c.p.status === 'ended') && !!c.p.ended_at && !!claimEmailTarget(bot, c);
}

/** Последний PDF заявления, отправленный жителю в чат: нужен, если ФИО не сохраняли в базе. */
const lastPdf = new Map<number, string>();
export function rememberClaimPdf(pid: number, path: string) {
  lastPdf.set(pid, path);
}

/**
 * Отправляет заявление на почту УК. replyTo — почта жителя: копия письма и адрес для ответа.
 * Возвращает текст ошибки или null.
 */
export async function emailClaim(bot: Vernem, userId: number, pid: number, replyTo: string | null): Promise<string | null> {
  const c = bot.ownCase(userId, pid);
  if (!c || !c.p.ended_at) return 'Заявление появится, когда услугу восстановят';
  const to = claimEmailTarget(bot, c);
  if (!bot.cfg.mail) return 'Отправка на почту сейчас не настроена';
  if (!to) return 'Почты УК нет в карточке дома — впишите её в «Данные дома»';
  if (replyTo && !isEmail(replyTo)) return 'Почта в виде name@example.ru';
  bot.markClaimIssued(pid);
  bot.refreshClaimIssue(pid);
  const fresh = loadCase(bot.db, pid)!;
  const cl = claimOf(fresh.p);
  const doc = claimDocFor(bot.db, bot.norms, fresh, bot.now());
  let pdf: Buffer;
  if (cl.fio) pdf = await claimToPdf(doc);
  else {
    // ФИО не сохраняли: берём PDF, который житель только что получил в чате.
    const path = lastPdf.get(pid);
    if (!path || !existsSync(path)) return 'В заявлении нет ФИО: скачайте его ещё раз — «Прислать заявление ещё раз» — и сразу отправьте';
    pdf = readFileSync(path);
  }
  const flat = cl.flat ? `, кв. ${cl.flat}` : '';
  const text = [
    'Здравствуйте!',
    '',
    `Направляю заявление о перерасчёте платы за коммунальную услугу по адресу: ${docAddress(fresh.house)}${flat}. Заявление — во вложении (PDF).`,
    'Прошу зарегистрировать обращение и сообщить входящий номер.',
    replyTo ? `Ответ прошу направить на ${replyTo}.` : 'Ответ прошу направить по адресу, указанному в заявлении.',
    '',
    cl.fio ? `С уважением, ${cl.fio}` : 'С уважением, заявитель (данные — в заявлении)',
    '',
    '—',
    'Письмо отправлено через сервис «Вернём» по поручению заявителя.',
  ].join('\n');
  try {
    await sendMail(bot.cfg.mail, {
      to,
      cc: replyTo,
      replyTo,
      subject: `Заявление о перерасчёте платы — ${docAddress(fresh.house)}${flat}`,
      text,
      attachments: [{ filename: doc.fileName ?? 'Заявление.pdf', content: pdf, contentType: 'application/pdf' }],
    });
  } catch (e) {
    console.error('[mail] не отправлено', e);
    return 'Письмо не ушло: почтовый сервер не ответил. Попробуйте ещё раз чуть позже или отнесите заявление лично';
  }
  const now = bot.now().toISOString();
  const latest = claimOf(loadCase(bot.db, pid)!.p);
  bot.db.updateParticipant(pid, { claim: JSON.stringify({ ...latest, submittedAt: now, submittedVia: 'email', emailedTo: to, emailedAt: now }) });
  bot.db.track(userId, 'claim_emailed', { pid });
  return null;
}

// ---------------------------------------------------------------------
// В чате
// ---------------------------------------------------------------------

export async function askEmailClaim(bot: Vernem, userId: number, pid: number) {
  const c = bot.ownCase(userId, pid);
  if (!c || !canEmailClaim(bot, c)) return bot.stale(userId);
  const to = claimEmailTarget(bot, c)!;
  bot.db.setState(userId, 'await_mail_reply', { pid });
  return bot.send(userId, {
    text: [
      `📧 Отправлю заявление на почту УК **${clean(to)}** — PDF во вложении и просьба сообщить входящий номер. Дата отправки станет датой подачи.`,
      'Куда УК прислать ответ? Напишите вашу почту — поставлю её в копию. Или нажмите «Без моей почты».',
    ].join('\n'),
    buttons: [[cb('📧 Без моей почты', `mailgo:${pid}`)], [cb('Отмена', `cs:${pid}`)]],
  });
}

export async function onEmailReply(bot: Vernem, userId: number, text: string, data: { pid: number }) {
  const email = text.trim().toLowerCase();
  if (!isEmail(email)) return bot.send(userId, { text: 'Почта в виде name@example.ru. Или нажмите «Без моей почты».', buttons: [[cb('📧 Без моей почты', `mailgo:${data.pid}`)], backRow()] });
  return finishEmail(bot, userId, data.pid, email);
}

export async function finishEmail(bot: Vernem, userId: number, pid: number, replyTo: string | null) {
  bot.db.setState(userId, 'idle');
  const err = await emailClaim(bot, userId, pid, replyTo);
  if (err) return bot.send(userId, { text: `⚠️ ${err}.`, buttons: [[cb('📋 К делу', `cs:${pid}`)]] });
  const c = loadCase(bot.db, pid)!;
  const cl = claimOf(c.p);
  return bot.send(userId, {
    text: [
      `✅ Отправил заявление на ${clean(cl.emailedTo)} в ${formatShort(new Date(cl.emailedAt!), c.house.tz)}${replyTo ? `, копия — на ${replyTo}` : ''}.`,
      'Это и есть подача: дата отправки записана в деле. Через месяц спрошу про квитанцию.',
    ].join('\n'),
    buttons: [[cb('📋 К делу', `cs:${pid}`), cb('⬅️ Меню', 'menu')]],
  });
}
