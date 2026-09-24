import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db, ExecutorType } from '../db/db.ts';
import type { Norms } from '../calc/norms.ts';
import type { AppConfig } from '../config.ts';
import type { Vernem } from '../bot/core.ts';
import { actDocFor, billsOf, claimDocFor, claimOf, loadCase, summarize } from '../services/cases.ts';
import { actFromApp, markActSigned } from '../bot/acts.ts';
import { executorFromHouse } from '../bot/house.ts';
import { claimToText } from '../docs/claim.ts';
import { claimToPdf } from '../docs/pdf.ts';
import { parseReceiptQr } from '../receipt/qr.ts';
import { signLink, validateInitData, verifyLink } from './auth.ts';
import { SERVICE_ORDER } from '../calc/norms.ts';
import { CITIES, resolveCity } from '../calc/cities.ts';
import { parseRubles } from '../calc/format.ts';

export type WebDeps = {
  db: Db;
  norms: Norms;
  cfg: AppConfig;
  bot: () => Vernem | null;
  botStatus: () => string;
};

type AuthedRequest = Request & { userId?: number };

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const str = (v: unknown, max: number): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, 'Поля должны быть строками');
  const s = v.replace(/[*_`[\]~<>]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new HttpError(400, `Слишком длинное значение (максимум ${max} символов)`);
  return s || undefined;
};

const VERSION: string = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;

export function createApp(deps: WebDeps) {
  const { db, norms, cfg } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', (_req, res) => {
    let dbOk = true;
    try {
      db.db.prepare('SELECT 1').get();
    } catch {
      dbOk = false;
    }
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, db: dbOk ? 'ok' : 'error', bot: deps.botStatus(), version: VERSION });
  });

  app.get('/', (_req, res) => res.redirect('/app/'));
  // В index.html к app.js и app.css дописывается хеш содержимого: после обновления телефон
  // гарантированно берёт новые файлы, даже если старые лежат в кэше WebView.
  const assetVersion = createHash('sha1')
    .update(readFileSync(resolve('public/app/app.js')))
    .update(readFileSync(resolve('public/app/app.css')))
    .digest('hex')
    .slice(0, 10);
  const indexHtml = readFileSync(resolve('public/app/index.html'), 'utf8').replace(/"(app\.(?:js|css))"/g, `"$1?v=${assetVersion}"`);
  app.get(['/app/', '/app/index.html'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(indexHtml);
  });
  app.use(
    '/app',
    express.static(resolve('public/app'), {
      index: 'index.html',
      // no-cache = браузер каждый раз сверяет ETag (ответ 304, без повторной загрузки).
      // С max-age WebView MAX сутки показывал бы старый app.js после обновления.
      setHeaders: (res, path) => {
        if (path.endsWith('.html') || path.endsWith('.js') || path.endsWith('.css')) res.setHeader('Cache-Control', 'no-cache');
        else res.setHeader('Cache-Control', 'public, max-age=86400');
      },
    }),
  );

  // ---------- авторизация мини-приложения ----------
  const auth = (req: AuthedRequest, _res: Response, next: NextFunction) => {
    const initData = req.header('x-max-init-data') ?? '';
    if (initData) {
      const check = validateInitData(initData, cfg.token, cfg.initDataTtlHours * 3600);
      if (!check.ok) return next(new HttpError(401, `Не удалось проверить вход: ${check.reason}`));
      db.ensureUser(check.user.id, check.user.first_name ?? null);
      req.userId = check.user.id;
      return next();
    }
    const demo = req.header('x-demo-user');
    if (cfg.allowDemoAuth && demo && /^\d{1,12}$/.test(demo)) {
      db.ensureUser(Number(demo), 'Демо');
      req.userId = Number(demo);
      return next();
    }
    next(new HttpError(401, 'Откройте приложение из бота в MAX'));
  };

  const ownCase = (req: AuthedRequest) => {
    const id = Number(req.params.id);
    const c = Number.isInteger(id) ? loadCase(db, id) : null;
    if (!c || c.p.user_id !== req.userId) throw new HttpError(404, 'Случай не найден');
    return c;
  };

  const api = express.Router();
  api.use(auth);

  const houseJson = (userId: number, houseId: number) => {
    const h = db.getUserHouse(userId, houseId);
    if (!h) throw new HttpError(404, 'Адрес не найден в вашем списке');
    return {
      id: h.id,
      address: h.address,
      city: h.city,
      entrance: h.entrance,
      notify: !!h.notify,
      info: db.houseInfo(h),
      members: db.countHouseMembers(h.id),
      inviteLink: cfg.botUsername ? `https://max.ru/${cfg.botUsername}?start=h_${h.code}` : null,
    };
  };

  api.get('/me', (req: AuthedRequest, res) => {
    const u = db.getUser(req.userId!)!;
    const house = u.house_id ? db.getHouse(u.house_id) : undefined;
    const cases = db.listUserParticipants(u.id);
    const refunded = cases.reduce((s, p) => s + (p.status === 'refunded' && p.refund_amount ? p.refund_amount : 0), 0);
    res.json({
      firstName: u.first_name,
      address: house?.address ?? null,
      houses: db.listUserHouses(u.id).map((h) => houseJson(u.id, h.id)),
      // Город для формы адреса: сначала города жителя, потом справочник.
      myCities: db.userCities(u.id),
      cities: [...new Set([...db.userCities(u.id), ...CITIES.map((c) => c.name)])],
      services: SERVICE_ORDER.map((k) => ({ key: k, title: norms.services[k].title, button: norms.services[k].button, kind: norms.services[k].kind })),
      savedPersonal: !!u.save_personal,
      refunded: Math.round(refunded * 100) / 100,
      botUsername: cfg.botUsername,
      normsCheckedAt: norms.source.checked_at,
    });
  });

  // ---------- мои адреса и дома ----------

  api.get('/houses/search', (req: AuthedRequest, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
    const city = typeof req.query.city === 'string' ? resolveCity(req.query.city, cfg.defaultTz) : null;
    if (!city) throw new HttpError(400, 'Укажите город');
    res.json({ houses: db.searchHouses(q, 8, city.name).filter((h) => !h.demo).map((h) => ({ id: h.id, address: h.address, members: db.countHouseMembers(h.id) })) });
  });

  api.post('/me/houses', (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    let houseId: number;
    if (Number.isInteger(b.houseId)) {
      const h = db.getHouse(b.houseId);
      if (!h || h.demo) throw new HttpError(404, 'Дом не найден');
      houseId = h.id;
    } else {
      const address = str(b.address, 200);
      if (!address || address.length < 3 || !/\d/.test(address)) throw new HttpError(400, 'Нужны улица и номер дома');
      const city = resolveCity(str(b.city, 60) ?? '', cfg.defaultTz);
      if (!city) throw new HttpError(400, 'Укажите город');
      houseId = db.upsertHouse(address, city.tz, 0, city.name).id;
    }
    db.addUserHouse(req.userId!, houseId);
    const entrance = str(b.entrance, 4);
    if (entrance) db.setUserHouse(req.userId!, houseId, { entrance });
    db.track(req.userId!, 'house_set', { house: houseId, via: 'app' });
    res.json({ house: houseJson(req.userId!, houseId) });
  });

  api.patch('/me/houses/:id', (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    houseJson(req.userId!, id);
    const b = req.body ?? {};
    const entrance = b.entrance === null ? null : str(b.entrance, 4);
    if (entrance !== undefined) db.setUserHouse(req.userId!, id, { entrance });
    if (typeof b.notify === 'boolean') db.setUserHouse(req.userId!, id, { notify: b.notify ? 1 : 0 });
    res.json({ house: houseJson(req.userId!, id) });
  });

  api.delete('/me/houses/:id', (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    houseJson(req.userId!, id);
    db.removeUserHouse(req.userId!, id);
    res.json({ ok: true });
  });

  api.get('/houses/:id', (req: AuthedRequest, res) => {
    res.json({ house: houseJson(req.userId!, Number(req.params.id)) });
  });

  api.put('/houses/:id/info', (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    houseJson(req.userId!, id);
    const b = req.body ?? {};
    const ukInn = str(b.ukInn, 12);
    if (ukInn && !/^\d{10}(\d{2})?$/.test(ukInn)) throw new HttpError(400, 'ИНН — 10 или 12 цифр');
    const ukEmail = str(b.ukEmail, 100);
    if (ukEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ukEmail)) throw new HttpError(400, 'Проверьте адрес почты');
    const info = {
      ukName: str(b.ukName, 150),
      ukInn,
      ukAddress: str(b.ukAddress, 200),
      ukEmail,
      adsPhone: str(b.adsPhone, 40),
      rsoHeat: str(b.rsoHeat, 150),
      rsoWater: str(b.rsoWater, 150),
      rsoPower: str(b.rsoPower, 150),
      rsoGas: str(b.rsoGas, 150),
      rop: str(b.rop, 150),
      gji: str(b.gji, 200),
      updatedAt: new Date().toISOString(),
      updatedBy: req.userId,
    };
    db.setHouseInfo(id, info);
    db.track(req.userId!, 'house_info', { house: id, via: 'app' });
    res.json({ house: houseJson(req.userId!, id) });
  });

  // ---------- сообщить о проблеме и «починили» ----------

  api.post('/report', async (req: AuthedRequest, res, next) => {
    try {
      const bot = deps.bot();
      if (!bot) throw new HttpError(503, 'Бот сейчас недоступен — сообщите о проблеме в чате с ботом');
      const b = req.body ?? {};
      if (!SERVICE_ORDER.includes(b.service)) throw new HttpError(400, 'Выберите, что случилось');
      if (!Number.isInteger(b.houseId)) throw new HttpError(400, 'Выберите адрес');
      const evidence = b.evidence === 'ads' || b.evidence === 'written' ? b.evidence : 'self';
      const startedAt = b.startedAt ? new Date(b.startedAt) : new Date();
      if (Number.isNaN(startedAt.getTime())) throw new HttpError(400, 'Непонятное время начала');
      if (startedAt.getTime() > Date.now() + 5 * 60_000) throw new HttpError(400, 'Время начала ещё не наступило');
      if (Date.now() - startedAt.getTime() > 92 * 24 * 3_600_000) throw new HttpError(400, 'Это было больше трёх месяцев назад');
      const temp = b.temp === undefined || b.temp === null || b.temp === '' ? undefined : Number(String(b.temp).replace(',', '.'));
      if (temp !== undefined && (!Number.isFinite(temp) || temp < -30 || temp > 99)) throw new HttpError(400, 'Проверьте температуру');
      const r = await bot.reportFromApp(req.userId!, {
        houseId: b.houseId,
        service: b.service,
        evidence,
        number: evidence === 'self' ? null : (str(b.number, 40) ?? null),
        startedAt,
        temp,
        corner: !!b.corner,
        variant: b.variant === 'two_sources' || b.variant === 'one_source' ? b.variant : undefined,
        planned: !!b.planned,
      });
      if ('error' in r) throw new HttpError(422, r.error);
      res.json({ caseId: r.pid });
    } catch (e) {
      next(e);
    }
  });

  api.post('/cases/:id/end', async (req: AuthedRequest, res, next) => {
    try {
      const c = ownCase(req);
      const bot = deps.bot();
      if (!bot) throw new HttpError(503, 'Бот сейчас недоступен');
      const endedAt = req.body?.endedAt ? new Date(req.body.endedAt) : new Date();
      if (Number.isNaN(endedAt.getTime())) throw new HttpError(400, 'Непонятное время');
      const err = await bot.endFromApp(req.userId!, c.p.id, endedAt);
      if (err) throw new HttpError(422, err);
      res.json({ case: summarize(db, norms, loadCase(db, c.p.id)!, new Date()) });
    } catch (e) {
      next(e);
    }
  });

  api.delete('/me', (req: AuthedRequest, res) => {
    db.deleteUserData(req.userId!);
    res.json({ ok: true });
  });

  api.get('/cases', (req: AuthedRequest, res) => {
    const now = new Date();
    const list = db.listUserParticipants(req.userId!).map((p) => summarize(db, norms, loadCase(db, p.id)!, now));
    res.json({ cases: list });
  });

  api.get('/cases/:id', (req: AuthedRequest, res) => {
    const c = ownCase(req);
    const now = new Date();
    const s = summarize(db, norms, c, now);
    const claimText = c.p.ended_at ? claimToText(claimDocFor(db, norms, c, now)) : null;
    // Получатель из карточки дома — чтобы не вписывать УК руками, если соседи её уже заполнили.
    const info = db.houseInfo(c.house);
    const ex = executorFromHouse(info, c.incident.service_key);
    const executorHint = ex ? { name: ex.name, type: ex.type, inn: ex.type === 'uk' ? (info.ukInn ?? null) : null } : null;
    // ФИО и квартира, которые житель уже вписал в акт, — чтобы не спрашивать второй раз.
    const act = db.getActByIncident(c.incident.id);
    const signer = act ? db.listSigners(act.id).find((x) => x.user_id === c.p.user_id) : undefined;
    const personHint = signer ? { fio: signer.fio, flat: signer.flat } : null;
    res.json({ case: s, claimText, executorHint, personHint });
  });

  api.put('/cases/:id/claim', (req: AuthedRequest, res) => {
    const c = ownCase(req);
    const b = req.body ?? {};
    const types: ExecutorType[] = ['uk', 'rso', 'rop', 'unknown'];
    if (b.executorType !== undefined && !types.includes(b.executorType)) throw new HttpError(400, 'Неизвестный тип исполнителя');
    const inn = str(b.executorInn, 12);
    if (inn && !/^\d{10}(\d{2})?$/.test(inn)) throw new HttpError(400, 'ИНН — 10 или 12 цифр');
    const claim = {
      ...claimOf(c.p),
      fio: str(b.fio, 150),
      flat: str(b.flat, 10),
      account: str(b.account, 40),
      executor: str(b.executor, 200),
      executorInn: inn,
      executorType: b.executorType ?? claimOf(c.p).executorType,
    };
    db.updateParticipant(c.p.id, { claim: JSON.stringify(claim) });
    // Суммы из квитанции по месяцам: { "2026-09": "1200" } — для расчёта в рублях.
    if (b.bills && typeof b.bills === 'object') {
      const bills = { ...billsOf(c.p) };
      for (const [month, raw] of Object.entries(b.bills as Record<string, unknown>)) {
        if (!/^\d{4}-\d{2}$/.test(month)) continue;
        if (raw === '' || raw === null) {
          delete bills[month];
          continue;
        }
        const amount = parseRubles(String(raw));
        if (amount === null) throw new HttpError(400, 'Сумма из квитанции — число, например 1200');
        bills[month] = amount;
      }
      db.updateParticipant(c.p.id, { bills: JSON.stringify(bills) });
    }
    const fresh = loadCase(db, c.p.id)!;
    res.json({ case: summarize(db, norms, fresh, new Date()), claimText: fresh.p.ended_at ? claimToText(claimDocFor(db, norms, fresh, new Date())) : null });
  });

  api.post('/cases/:id/pdf-link', (req: AuthedRequest, res) => {
    const c = ownCase(req);
    if (!c.p.ended_at) throw new HttpError(409, 'Заявление появится, когда услугу восстановят');
    deps.bot()?.markClaimIssued(c.p.id);
    const path = `/files/claim/${c.p.id}.pdf`;
    const rel = signLink(path, cfg.linkSecret, 600);
    res.json({ url: `${cfg.publicUrl ?? ''}${rel}`, fileName: 'Заявление_на_перерасчёт.pdf' });
  });

  // ---------- акт с соседями (п. 110(1)) ----------
  api.post('/cases/:id/act', async (req: AuthedRequest, res, next) => {
    try {
      const c = ownCase(req);
      const bot = deps.bot();
      if (!bot) throw new HttpError(503, 'Бот сейчас недоступен');
      const fio = str(req.body?.fio, 150);
      if (!fio || fio.length < 5 || /\d/.test(fio)) throw new HttpError(400, 'Впишите фамилию, имя и отчество');
      const flat = str(req.body?.flat, 10) ?? null;
      const actId = await actFromApp(bot, req.userId!, c.p.id, fio, flat);
      if (!actId) throw new HttpError(404, 'Случай не найден');
      res.json({ url: `${cfg.publicUrl ?? ''}${signLink(`/files/act/${actId}.pdf`, cfg.linkSecret, 600)}`, fileName: 'Акт_о_нарушении.pdf' });
    } catch (e) {
      next(e);
    }
  });

  api.post('/cases/:id/act/signed', async (req: AuthedRequest, res, next) => {
    try {
      const c = ownCase(req);
      const bot = deps.bot();
      const act = db.getActByIncident(c.incident.id);
      if (!bot || !act) throw new HttpError(404, 'Акт не найден');
      if (!(await markActSigned(bot, req.userId!, act.id, req.body?.chair === true))) throw new HttpError(403, 'Отметить акт подписанным может тот, кто его начал');
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  api.post('/cases/:id/share', async (req: AuthedRequest, res, next) => {
    try {
      const c = ownCase(req);
      const bot = deps.bot();
      if (!bot) throw new HttpError(503, 'Бот сейчас недоступен');
      const card = bot.cardMessage(c);
      // Карточка уходит в диалог с ботом, мини-приложение пересылает её через MAX (shareMaxContent).
      // Без MAX (офлайн, браузер) — отдаём ссылку, чтобы житель переслал её сам.
      const sent = await bot.out.toUser(req.userId!, card).catch(() => ({ mid: undefined }) as { mid?: string });
      if (sent.mid) db.updateParticipant(c.p.id, { last_card_mid: sent.mid });
      db.track(req.userId!, 'card_created', { incident: c.incident.id, via: 'app' });
      res.json({ mid: sent.mid ?? null, link: bot.joinLink(c), text: card.text.replace(/\*\*/g, '') });
    } catch (e) {
      next(e);
    }
  });

  api.post('/receipt/parse', (req: AuthedRequest, res) => {
    const qr = typeof req.body?.qr === 'string' ? req.body.qr : '';
    if (qr.length > 2000) throw new HttpError(400, 'Слишком длинный QR-код');
    const r = parseReceiptQr(qr);
    if (!r.ok) throw new HttpError(422, r.error);
    const { fields: _fields, ...info } = r.info;
    res.json({ info });
  });

  api.post('/track', (req: AuthedRequest, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.slice(0, 40) : '';
    if (/^app_[a-z_]+$/.test(name)) db.track(req.userId!, name);
    res.json({ ok: true });
  });

  app.use('/api', api);

  // ---------- PDF по подписанной ссылке ----------
  app.get('/files/act/:file', async (req, res, next) => {
    try {
      const m = /^(\d+)\.pdf$/.exec(String(req.params.file));
      const path = `/files/act/${req.params.file}`;
      if (!m || !verifyLink(path, req.query.exp as string, req.query.sig as string, cfg.linkSecret)) {
        throw new HttpError(403, 'Ссылка устарела. Нажмите «Акт (PDF)» ещё раз.');
      }
      const doc = actDocFor(db, norms, Number(m[1]), new Date());
      if (!doc) throw new HttpError(404, 'Акт не найден');
      const pdf = await claimToPdf(doc);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('Акт_о_нарушении.pdf')}`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(pdf);
    } catch (e) {
      next(e);
    }
  });

  app.get('/files/claim/:file', async (req, res, next) => {
    try {
      const m = /^(\d+)\.pdf$/.exec(String(req.params.file));
      const path = `/files/claim/${req.params.file}`;
      if (!m || !verifyLink(path, req.query.exp as string, req.query.sig as string, cfg.linkSecret)) {
        throw new HttpError(403, 'Ссылка устарела. Нажмите «Скачать PDF» ещё раз.');
      }
      const c = loadCase(db, Number(m[1]));
      if (!c || !c.p.ended_at) throw new HttpError(404, 'Заявление не найдено');
      const pdf = await claimToPdf(claimDocFor(db, norms, c, new Date()));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('Заявление_на_перерасчёт.pdf')}`);
      res.setHeader('Cache-Control', 'no-store');
      res.end(pdf);
    } catch (e) {
      next(e);
    }
  });

  app.use((_req, res) => res.status(404).json({ error: 'Не найдено' }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : err?.type === 'entity.parse.failed' ? 400 : 500;
    if (status >= 500) console.error('[web]', err);
    res.status(status).json({ error: status >= 500 ? 'Внутренняя ошибка сервера. Попробуйте ещё раз.' : err.message });
  });

  return app;
}
