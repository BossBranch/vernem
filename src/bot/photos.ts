// Фото к делу: термометр, пустой кран, объявление, акт, квитанция.
// Храним токен MAX (по нему фото можно переслать) и время получения ботом.
// Фото — дополнительное доказательство: главное — номер АДС или акт, и бот говорит это прямо.

import type { PhotoKind } from '../db/db.ts';
import { formatShort } from '../calc/time.ts';
import { loadCase } from '../services/cases.ts';
import type { CaseBundle } from '../services/cases.ts';
import type { Btn, InPhoto } from './types.ts';
import type { Vernem } from './core.ts';
import { ICON, backRow, cb } from './ui.ts';

const PROMPT: Record<PhotoKind, string> = {
  evidence: 'Пришлите фото — например, термометр рядом с экраном телефона, где видно время, пустой кран или объявление об отключении на подъезде. Можно несколько.',
  receipt: 'Сфотографируйте квитанцию целиком, чтобы были видны строки начислений и перерасчётов. Сохраню её к делу.',
  act: 'Пришлите фото подписанного акта — все страницы.',
};

const KIND_TITLE: Record<PhotoKind, string> = { evidence: 'фото', receipt: 'фото квитанции', act: 'фото акта' };

const OPEN = new Set(['tracking', 'ended', 'claim_ready', 'refused']);

export function askPhoto(bot: Vernem, userId: number, pid: number, kind: PhotoKind) {
  if (!bot.ownCase(userId, pid)) return bot.stale(userId);
  bot.db.setState(userId, 'await_photo', { pid, kind });
  return bot.send(userId, { text: PROMPT[kind], buttons: [[cb('⬅️ К случаю', `cs:${pid}`)]] });
}

export async function onPhoto(bot: Vernem, userId: number, photos: InPhoto[]) {
  const { state, data } = bot.db.getState<{ pid?: number; kind?: PhotoKind; photos?: InPhoto[] }>(userId);
  if (state === 'await_photo' && data.pid) {
    const c = bot.ownCase(userId, data.pid);
    if (c) return save(bot, userId, c, data.kind ?? 'evidence', photos, true);
  }
  const open = bot.db.listUserParticipants(userId).filter((p) => OPEN.has(p.status));
  if (!open.length) {
    return bot.send(userId, {
      text: 'Фото получил, но случая, к которому его приложить, пока нет. Нажмите «Что-то сломалось», а потом пришлите фото снова.',
      buttons: bot.menu(),
    });
  }
  if (open.length === 1) return save(bot, userId, loadCase(bot.db, open[0].id)!, 'evidence', photos, false);
  // Несколько открытых случаев — спрашиваем, к какому приложить.
  bot.db.setState(userId, 'photo_pick', { photos });
  const rows: Btn[][] = open.slice(0, 5).map((p) => {
    const c = loadCase(bot.db, p.id)!;
    return [cb(`${ICON[c.incident.service_key]} ${bot.norms.services[c.incident.service_key].button} · ${formatShort(new Date(p.started_at), c.house.tz)}`.slice(0, 64), `ph:${p.id}`)];
  });
  return bot.send(userId, { text: 'К какому случаю приложить фото?', buttons: [...rows, backRow()] });
}

export async function onPhotoPick(bot: Vernem, userId: number, pid: number) {
  const { state, data } = bot.db.getState<{ photos?: InPhoto[] }>(userId);
  const c = bot.ownCase(userId, pid);
  if (state !== 'photo_pick' || !data.photos?.length || !c) return bot.stale(userId);
  bot.db.setState(userId, 'idle');
  return save(bot, userId, c, 'evidence', data.photos, false);
}

async function save(bot: Vernem, userId: number, c: CaseBundle, kind: PhotoKind, photos: InPhoto[], keepWaiting: boolean) {
  const before = bot.db.listPhotos(c.p.id).length;
  const now = bot.now();
  for (const ph of photos) bot.db.addPhoto(c.p.id, kind, ph.token, ph.url, now);
  bot.db.track(userId, 'photo_added', { kind, n: photos.length });
  if (!keepWaiting) bot.db.setState(userId, 'idle');
  const norm = bot.norms.services[c.incident.service_key];
  const lines = [`📷 Сохранил ${photos.length > 1 ? `${photos.length} ${KIND_TITLE[kind]}` : KIND_TITLE[kind]} к случаю «${norm.title}» · получено ${formatShort(now, c.house.tz)}.`];
  if (before === 0) {
    lines.push('', 'Фото — дополнительное доказательство: главное — номер из аварийной службы или акт. В заявлении я перечислю фото в приложениях со временем получения.');
  }
  if (keepWaiting) lines.push('', 'Можно прислать ещё.');
  return bot.send(userId, { text: lines.join('\n'), buttons: [[cb('⬅️ К случаю', `cs:${c.p.id}`)]] });
}
