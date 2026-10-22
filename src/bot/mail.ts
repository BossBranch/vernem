// Заявление на почту УК: бот отправляет только загруженный жителем подписанный скан, житель — в копии.
// Дата отправки письма — дата подачи: она попадает в требование и жалобу, если перерасчёт не сделают.
// Отправляем только в УК (почта в карточке дома — почта УК), только с согласия жителя и только с ФИО в заявлении.
// Одно заявление уходит одним письмом: повторное нажатие или повтор запроса второе письмо не отправит.

import { docAddress } from '../docs/claim.ts';
import { claimDocFor, claimOf, loadCase } from '../services/cases.ts';
import type { CaseBundle } from '../services/cases.ts';
import { formatDate, formatShort } from '../calc/time.ts';
import { isEmail, sendMail } from '../mail/smtp.ts';
import type { Attachment } from '../mail/smtp.ts';
import { readSignedScan, removeSignedScan, validateSignedScan } from '../files/signed-scans.ts';
import type { Vernem } from './core.ts';
import { ukEmailChangedByOther } from './house.ts';
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
  const scan = bot.db.getSignedScan(c.p.id);
  return (c.p.status === 'claim_ready' || c.p.status === 'ended') && !!c.p.ended_at && !!claimEmailTarget(bot, c) && !!scan?.storage_name && !scan.sent_at && scan.issued_snapshot === claimOf(c.p).issuedSnapshot;
}

/** Предупреждение перед отправкой: почту УК недавно изменил другой житель. */
export function emailTargetNote(bot: Vernem, c: CaseBundle, userId: number): string | null {
  const at = ukEmailChangedByOther(bot.db.houseInfo(c.house), userId, bot.now());
  return at ? `Почту УК изменил сосед ${formatDate(new Date(at), c.house.tz)}. Сверьте её с квитанцией или сайтом УК.` : null;
}

/**
 * Последний PDF заявления, отправленный жителю в чат. Храним только час в памяти: он не используется
 * для SMTP, но удаляется вместе с делом и не остаётся на диске.
 */
const PDF_TTL_MS = 3_600_000;
const lastPdf = new Map<number, { pdf: Buffer; at: number }>();
export function rememberClaimPdf(pid: number, pdf: Buffer) {
  const now = Date.now();
  for (const [k, v] of lastPdf) if (now - v.at > PDF_TTL_MS) lastPdf.delete(k);
  lastPdf.set(pid, { pdf, at: now });
}
export function forgetClaimPdfs(pids: number[]) {
  for (const pid of pids) lastPdf.delete(pid);
}

/** Дела, по которым письмо уходит прямо сейчас: второе нажатие не отправит дубль. */
const sending = new Set<number>();

const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** Фото к делу (в том числе подписанного акта) — вложениями, если MAX ещё отдаёт их по ссылке. */
async function photoAttachments(bot: Vernem, pid: number): Promise<{ files: Attachment[]; missed: number }> {
  const photos = bot.db.listPhotos(pid);
  const files: Attachment[] = [];
  let missed = 0;
  for (const ph of photos.slice(0, MAX_PHOTOS)) {
    try {
      if (!ph.url || !ph.url.startsWith('https://')) throw new Error('нет ссылки');
      const res = await fetch(ph.url, { signal: AbortSignal.timeout(10_000) });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/')) throw new Error(`ответ ${res.status} ${type}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_PHOTO_BYTES) throw new Error('слишком большое');
      const ext = type.includes('png') ? 'png' : 'jpg';
      files.push({ filename: `Фото_${files.length + 1}_${ph.kind === 'act' ? 'акт' : ph.kind === 'receipt' ? 'квитанция' : 'нарушение'}.${ext}`, content: buf, contentType: type });
    } catch (e) {
      missed++;
      console.warn('[mail] фото не приложено', ph.id, (e as Error)?.message);
    }
  }
  return { files, missed: missed + Math.max(0, photos.length - MAX_PHOTOS) };
}

export type EmailResult = { error: string } | { ok: true; photos: number; missedPhotos: number; actCopyMissing: boolean };

/**
 * Отправляет заявление на почту УК. replyTo — почта жителя: копия письма и адрес для ответа.
 * Возвращает текст ошибки или null.
 */
export async function emailClaim(bot: Vernem, userId: number, pid: number, replyTo: string | null): Promise<string | null> {
  const r = await emailClaimFull(bot, userId, pid, replyTo);
  return 'error' in r ? r.error : null;
}

export async function emailClaimFull(bot: Vernem, userId: number, pid: number, replyTo: string | null): Promise<EmailResult> {
  const c = bot.ownCase(userId, pid);
  if (!c || !c.p.ended_at) return { error: 'Заявление появится, когда услугу восстановят' };
  const to = claimEmailTarget(bot, c);
  if (!bot.cfg.mail) return { error: 'Отправка на почту сейчас не настроена' };
  if (!to) return { error: 'Почты УК нет в карточке дома — впишите её в «Данные дома»' };
  if (replyTo && !isEmail(replyTo)) return { error: 'Почта в виде name@example.ru' };
  if (sending.has(pid)) return { error: 'Письмо уже отправляется — подождите минуту' };
  sending.add(pid);
  try {
    bot.markClaimIssued(pid);
    bot.refreshClaimIssue(pid);
    const fresh = loadCase(bot.db, pid)!;
    const cl = claimOf(fresh.p);
    // Это заявление уже ушло письмом. Изменилось — refreshClaimIssue сбросил отметку, и новое уйдёт.
    if (cl.emailedAt) return { error: `Это заявление уже отправлено на ${cl.emailedTo ?? 'почту УК'} ${formatShort(new Date(cl.emailedAt), fresh.house.tz)}` };
    const doc = claimDocFor(bot.db, bot.norms, fresh, bot.now());
    const scan = bot.db.getSignedScan(pid);
    if (!scan?.storage_name || scan.sent_at || scan.issued_snapshot !== cl.issuedSnapshot) {
      return { error: 'Сначала загрузите актуальный скан заполненного и подписанного заявления' };
    }
    const pdf = readSignedScan(bot.cfg.signedScanDir, scan.storage_name);
    if (!pdf) return { error: 'Скан не найден. Загрузите подписанный PDF ещё раз' };
    try {
      validateSignedScan(pdf);
    } catch {
      return { error: 'Скан повреждён. Загрузите подписанный PDF ещё раз' };
    }
    const photos = await photoAttachments(bot, pid);
    const act = bot.db.getActByIncident(fresh.incident.id);
    const actPhoto = photos.files.some((f) => f.filename.includes('акт'));
    const actCopyMissing = act?.status === 'signed' && !actPhoto;
    const flat = cl.flat ? `, кв. ${cl.flat}` : '';
    const attached = ['заполненное и подписанное заявление (скан PDF)', photos.files.length ? `фотографии (${photos.files.length} шт.)` : ''].filter(Boolean).join(', ');
    const text = [
      'Здравствуйте!',
      '',
      `Направляю заявление о перерасчёте платы за коммунальную услугу по адресу: ${docAddress(fresh.house)}${flat}.`,
      `Во вложении: ${attached}.`,
      // Приложения, перечисленные в заявлении, которых нет в письме, — честно пишем, что будут отдельно.
      actCopyMissing ? 'Копию подписанного акта о нарушении направлю отдельно.' : '',
      photos.missed ? `Ещё ${photos.missed} фото направлю отдельно.` : '',
      'Прошу зарегистрировать обращение и сообщить входящий номер.',
      replyTo ? `Ответ прошу направить на ${replyTo}.` : 'Ответ прошу направить по адресу, указанному в заявлении.',
      '',
      cl.fio ? `С уважением, ${cl.fio}` : 'С уважением, заявитель (данные — в заявлении)',
      '',
      '—',
      'Письмо отправлено через сервис «Вернём» по поручению заявителя.',
    ]
      .filter((l, i, all) => l !== '' || all[i - 1] !== '')
      .join('\n');
    try {
      await sendMail(bot.cfg.mail, {
        to,
        cc: replyTo,
        replyTo,
        subject: `Заявление о перерасчёте платы — ${docAddress(fresh.house)}${flat}`,
        text,
        attachments: [{ filename: scan.filename, content: pdf, contentType: scan.mime }, ...photos.files],
      });
    } catch (e) {
      console.error('[mail] не отправлено', e);
      return { error: 'Письмо не ушло: почтовый сервер не ответил. Попробуйте ещё раз чуть позже или отнесите заявление лично' };
    }
    const now = bot.now().toISOString();
    const latest = claimOf(loadCase(bot.db, pid)!.p);
    bot.db.updateParticipant(pid, { claim: JSON.stringify({ ...latest, submittedAt: now, submittedVia: 'email', emailedTo: to, emailedAt: now }) });
    bot.db.markSignedScanSent(pid, new Date(now));
    removeSignedScan(bot.cfg.signedScanDir, scan.storage_name);
    bot.afterSubmitted(pid);
    bot.db.track(userId, 'claim_emailed', { pid });
    return { ok: true, photos: photos.files.length, missedPhotos: photos.missed, actCopyMissing };
  } finally {
    sending.delete(pid);
  }
}

// ---------------------------------------------------------------------
// В чате
// ---------------------------------------------------------------------

export async function askEmailClaim(bot: Vernem, userId: number, pid: number) {
  const c = bot.ownCase(userId, pid);
  if (!c || !canEmailClaim(bot, c)) return bot.stale(userId);
  const cl = claimOf(c.p);
  if (cl.emailedAt && c.p.status === 'claim_ready') return bot.showCase(userId, pid);
  const to = claimEmailTarget(bot, c)!;
  const note = emailTargetNote(bot, c, userId);
  bot.db.setState(userId, 'await_mail_reply', { pid });
  return bot.send(userId, {
    text: [
      `📧 Отправлю подписанный вами скан заявления на почту УК **${clean(to)}** и попрошу сообщить входящий номер. Дата отправки станет датой подачи.`,
      note ? `⚠️ ${note}` : '',
      'Куда УК прислать ответ? Напишите вашу почту — поставлю её в копию. Или нажмите «Без моей почты».',
    ]
      .filter(Boolean)
      .join('\n'),
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
  const r = await emailClaimFull(bot, userId, pid, replyTo);
  if ('error' in r) return bot.send(userId, { text: `⚠️ ${r.error}.`, buttons: [[cb('📋 К делу', `cs:${pid}`)]] });
  const c = loadCase(bot.db, pid)!;
  const cl = claimOf(c.p);
  return bot.send(userId, {
    text: [
      `✅ Отправил заявление на ${clean(cl.emailedTo)} в ${formatShort(new Date(cl.emailedAt!), c.house.tz)}${replyTo ? `, копия — на ${replyTo}` : ''}.`,
      r.photos ? `Фото к делу приложил: ${r.photos} шт.` : '',
      r.actCopyMissing ? '📎 Копии подписанного акта в письме нет — пришлите УК фото акта ответным письмом или приложите при визите.' : '',
      'Это и есть подача: дата отправки записана в деле. Через месяц спрошу про квитанцию.',
    ]
      .filter(Boolean)
      .join('\n'),
    buttons: [[cb('📋 К делу', `cs:${pid}`), cb('⬅️ Меню', 'menu')]],
  });
}
