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
import { actFromApp, markActSigned, unmarkActSigned } from '../bot/acts.ts';
import { escalationDocFor } from '../bot/escalate.ts';
import type { EscalationKind } from '../docs/escalation.ts';
import { executorFromHouse } from '../bot/house.ts';
import { claimToText } from '../docs/claim.ts';
import { claimToPdf } from '../docs/pdf.ts';
import { parseReceiptQr } from '../receipt/qr.ts';
import { signLink, validateInitData, verifyLink } from './auth.ts';
import { SERVICE_ORDER } from '../calc/norms.ts';
import { CITIES, resolveCity, suggestCity } from '../calc/cities.ts';
import { flatFromAddress, tidyStreet } from '../db/db.ts';
import { fmtTemp, innProblem, parseRubles } from '../calc/format.ts';

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
  /** Ошибки по полям формы: мини-приложение подсвечивает поле и пишет текст под ним. */
  fields?: Record<string, string>;
  constructor(status: number, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

/** Ошибка одного поля. */
const fieldError = (field: string, message: string) => new HttpError(400, message, { [field]: message });

/** Проверка сразу всех полей формы: житель видит все ошибки разом, а не по одной. */
function checkAll(errors: Record<string, string>) {
  const keys = Object.keys(errors);
  if (keys.length) throw new HttpError(400, keys.length === 1 ? errors[keys[0]] : 'Проверьте отмеченные поля', errors);
}

// Неразрывные пробелы и дефисы: номер в подсказке не рвётся на две строки.
const PHONE_ERROR = 'Телефон — цифрами, например +7\u00a0495\u00a0123\u201145\u201167 или 112';
const TEMP_ERROR = 'Температура — число, например 16 или 15,5';
/** Разумные пределы: в комнате 0…+40 °C, горячая вода 0…+99 °C. */
const TEMP_LIMITS: Record<string, [number, number, string]> = {
  heating_temp: [0, 40, 'Температура в комнате — от 0 до +40 °C. Проверьте число'],
  hot_water_temp: [0, 99, 'Температура воды — от 0 до +99 °C. Проверьте число'],
};
/** Температура из поля формы: null — поле пустое; иначе число или ошибка у поля. */
function tempOf(v: unknown, field: string, service = 'heating_temp'): number | null {
  if (v === undefined || v === null || v === '') return null;
  const t = Number(String(v).replace(',', '.').replace(/[°cс\s+]/gi, '').replace('−', '-'));
  if (!Number.isFinite(t)) throw fieldError(field, TEMP_ERROR);
  const [min, max, msg] = TEMP_LIMITS[service] ?? [-30, 99, 'Проверьте число'];
  if (t < min || t > max) throw fieldError(field, msg);
  return t;
}

const innError = innProblem;

/** Сумма из квитанции: число больше нуля и разумного размера. */
function billError(raw: string): { amount: number } | { error: string } {
  const amount = parseRubles(raw);
  // parseRubles отсекает всё больше миллиона — это не «не число», а слишком большая сумма.
  if (amount === null && /^\s*[1-9][\d\s\u00a0]*([.,]\d+)?\s*(₽|руб\.?|р\.?)?\s*$/i.test(raw)) {
    return { error: 'Проверьте сумму: плата за одну услугу за месяц обычно меньше 100 000 ₽' };
  }
  if (amount === null) return { error: 'Сумма — число больше нуля, например 1200 или 1 250,50' };
  if (amount > 100_000) return { error: 'Проверьте сумму: плата за одну услугу за месяц обычно меньше 100 000 ₽' };
  return { amount };
}

/** ФИО для документа: хотя бы фамилия и имя, без цифр. */
function fioError(fio: string): string | null {
  return fio.split(' ').length < 2 || /\d/.test(fio) ? 'Фамилия и имя полностью, например «Иванова Анна Петровна»' : null;
}
const isPhone = (v: string) => !/[^\d\s+()\-.]/.test(v) && v.replace(/\D/g, '').length >= 3;
const ENTRANCE_ERROR = 'Номер подъезда — цифрами, например 2 или 2А';
const entranceOf = (v: unknown): string | null | undefined => {
  if (v === null) return null;
  const s = str(v, 4);
  if (s === undefined) return undefined;
  if (!/^\d{1,2}[А-ЯЁA-Z]?$/i.test(s)) throw fieldError('entrance', ENTRANCE_ERROR);
  return s.toUpperCase();
};

const str = (v: unknown, max: number): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, 'Поля должны быть строками');
  const s = v.replace(/[*_`[\]~<>]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new HttpError(400, `Слишком длинное значение (максимум ${max} символов)`);
  return s || undefined;
};

const ESC_FILES: Record<string, string> = { fine: 'Требование_о_штрафе.pdf', gji: 'Жалоба_в_ГЖИ.pdf', ozpp: 'Заявление_в_общество_потребителей.pdf' };

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
    if (!c || c.p.user_id !== req.userId) throw new HttpError(404, 'Дело не найдено');
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
      flat: h.flat,
      account: h.account,
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

  /** Проверка города: из справочника, похож на город из справочника («Масква» → Москва) или новый. */
  api.get('/cities/check', (req: AuthedRequest, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : '';
    const known = resolveCity(q, cfg.defaultTz);
    const inList = !!known && CITIES.some((c) => c.name === known.name);
    const suggestion = inList ? null : suggestCity(q);
    res.json({ name: known?.name ?? null, inList, suggestion: suggestion?.name ?? null, latin: /[a-z]/i.test(q) });
  });

  api.get('/houses/search', (req: AuthedRequest, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
    const city = typeof req.query.city === 'string' ? resolveCity(req.query.city, cfg.defaultTz) : null;
    if (!city) throw new HttpError(400, 'Укажите город');
    // Точное совпадение с домом из списка — тогда «Моего дома нет — добавить» не предлагаем.
    const exact = q.trim().length >= 3 ? db.findHouse(q, city.name) : undefined;
    res.json({
      houses: db.searchHouses(q, 8, city.name).filter((h) => !h.demo).map((h) => ({ id: h.id, address: h.address, members: db.countHouseMembers(h.id) })),
      exactId: exact && !exact.demo ? exact.id : null,
    });
  });

  api.post('/me/houses', (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    const entrance = entranceOf(b.entrance);
    let houseId: number;
    if (Number.isInteger(b.houseId)) {
      const h = db.getHouse(b.houseId);
      if (!h || h.demo) throw new HttpError(404, 'Дом не найден');
      houseId = h.id;
    } else {
      const address = str(b.address, 200);
      // Проверяем улицу без квартиры: «кв 5» — не дом (раньше создавался дом с пустой улицей).
      const street = address ? tidyStreet(address) : '';
      if (!address || street.length < 3 || !/\d/.test(street) || !/[\p{L}]{2}/u.test(street)) throw fieldError('q', 'Нужны улица и номер дома, например «Садовая 10»');
      const city = resolveCity(str(b.city, 60) ?? '', cfg.defaultTz);
      if (!city) throw new HttpError(400, 'Укажите город');
      houseId = db.upsertHouse(address, city.tz, 0, city.name).id;
    }
    // Квартира — не часть дома: из «Садовая 10 кв 15» дом «Садовая 10», квартира 15.
    const flat = str(b.flat, 10) ?? (typeof b.address === 'string' ? flatFromAddress(b.address) : null);
    const before = db.getUserHouse(req.userId!, houseId);
    db.addUserHouse(req.userId!, houseId);
    const entranceChanged = !!before && !!entrance && before.entrance !== entrance;
    if (entrance) db.setUserHouse(req.userId!, houseId, { entrance });
    if (flat) db.setUserHouse(req.userId!, houseId, { flat });
    db.track(req.userId!, 'house_set', { house: houseId, via: 'app' });
    res.json({ house: houseJson(req.userId!, houseId), already: !!before, entranceChanged });
  });

  api.patch('/me/houses/:id', (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    houseJson(req.userId!, id);
    const b = req.body ?? {};
    const entrance = entranceOf(b.entrance);
    if (entrance !== undefined) db.setUserHouse(req.userId!, id, { entrance });
    if (b.flat !== undefined) db.setUserHouse(req.userId!, id, { flat: b.flat === null ? null : (str(b.flat, 10) ?? null) });
    if (b.account !== undefined) db.setUserHouse(req.userId!, id, { account: b.account === null ? null : (str(b.account, 40) ?? null) });
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
    const errors: Record<string, string> = {};
    const ukInn = str(b.ukInn, 20);
    const ukInnErr = ukInn ? innError(ukInn) : null;
    if (ukInnErr) errors.ukInn = ukInnErr;
    const ukEmail = str(b.ukEmail, 100);
    if (ukEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ukEmail)) errors.ukEmail = 'Почта в виде name@example.ru';
    const adsPhone = str(b.adsPhone, 40);
    if (adsPhone && !isPhone(adsPhone)) errors.adsPhone = PHONE_ERROR;
    // Поле с ошибкой не сохраняем (остаётся прежнее значение), а верные — сохраняем: опечатка в ИНН
    // не должна стоить жителю уже вписанного телефона аварийной службы.
    const prev = db.houseInfo(db.getHouse(id)!);
    const info = {
      ukName: str(b.ukName, 150),
      ukInn: errors.ukInn ? prev.ukInn : ukInn,
      ukAddress: str(b.ukAddress, 200),
      ukEmail: errors.ukEmail ? prev.ukEmail : ukEmail,
      adsPhone: errors.adsPhone ? prev.adsPhone : adsPhone,
      rsoHeat: str(b.rsoHeat, 150),
      rsoWater: str(b.rsoWater, 150),
      rsoPower: str(b.rsoPower, 150),
      rsoGas: str(b.rsoGas, 150),
      rop: str(b.rop, 150),
      gji: str(b.gji, 200),
      // Лифт / больше 9 этажей: не передан — оставляем прежний ответ.
      twoPowerSources: typeof b.twoPowerSources === 'boolean' ? b.twoPowerSources : b.twoPowerSources === null ? undefined : db.houseInfo(db.getHouse(id)!).twoPowerSources,
      updatedAt: new Date().toISOString(),
      updatedBy: req.userId,
    };
    const powerChanged = db.houseInfo(db.getHouse(id)!).twoPowerSources !== info.twoPowerSources;
    db.setHouseInfo(id, info);
    if (powerChanged) deps.bot()?.recheckPowerCases(id);
    db.track(req.userId!, 'house_info', { house: id, via: 'app' });
    if (Object.keys(errors).length) throw new HttpError(400, 'Остальное сохранено. Исправьте поле с ошибкой', errors);
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
      if (Number.isNaN(startedAt.getTime())) throw fieldError('started', 'Укажите дату и время');
      if (startedAt.getTime() > Date.now() + 5 * 60_000) throw fieldError('started', 'Это время ещё не наступило');
      if (Date.now() - startedAt.getTime() > 366 * 24 * 3_600_000) throw fieldError('started', 'Это было больше года назад — такое проще решать через жилищную инспекцию');
      const temp = tempOf(b.temp, 'temp', b.service) ?? undefined;
      const numberRaw = typeof b.number === 'string' ? b.number.trim() : '';
      if (evidence !== 'self' && numberRaw.length > 60) throw fieldError('number', 'Номер слишком длинный — до 60 знаков');
      if (evidence !== 'self' && !str(b.number, 60)) {
        throw fieldError('number', evidence === 'written' ? 'Впишите номер обращения — он есть в «Госуслугах Дом» или ГИС ЖКХ' : 'Впишите номер заявки или выберите «Номера нет»');
      }
      // В номере всегда есть цифры: «не назвали» или «нет» — это не номер, для них есть вариант «Номера нет».
      if (evidence !== 'self' && !/\d/.test(numberRaw)) {
        throw fieldError('number', 'В номере должны быть цифры, например 4512 или А-17. Номера не дали — выберите «Номера нет»');
      }
      const r = await bot.reportFromApp(req.userId!, {
        houseId: b.houseId,
        service: b.service,
        evidence,
        number: evidence === 'self' ? null : (str(b.number, 60) ?? null),
        startedAt,
        temp,
        corner: !!b.corner,
        variant: b.variant === 'two_sources' || b.variant === 'one_source' ? b.variant : undefined,
        planned: !!b.planned,
      });
      if ('error' in r) throw new HttpError(422, r.error, /°C/.test(r.error) ? { temp: r.error } : undefined);
      res.json({ caseId: r.pid, outcome: r.outcome, numberSaved: !!r.numberSaved, readingSaved: !!r.readingSaved, since: r.since ?? null, neighbours: r.neighbours ?? 0, botConnected: !!cfg.token });
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
    const u = db.getUser(c.p.user_id);
    const person = db.personFor(c.p.user_id, c.house.id);
    const saved = person.fio || person.flat ? person : null;
    const personHint = signer ? { fio: signer.fio, flat: signer.flat ?? saved?.flat ?? null, account: saved?.account ?? null } : saved;
    const houseContacts = { ukName: info.ukName ?? null, ukEmail: info.ukEmail ?? null, ukAddress: info.ukAddress ?? null, adsPhone: info.adsPhone ?? null, twoPowerSources: info.twoPowerSources ?? null };
    // Подписант акта — чтобы мини-приложение предупредило, если ФИО в заявлении не совпадают с актом.
    const actSigner = signer ? { fio: signer.fio, flat: signer.flat, signed: act?.status === 'signed' } : null;
    res.json({ case: s, claimText, executorHint, personHint, houseContacts, actSigner, savedPersonal: !!u?.save_personal, botConnected: !!cfg.token });
  });

  api.put('/cases/:id/claim', (req: AuthedRequest, res) => {
    const c = ownCase(req);
    const b = req.body ?? {};
    const types: ExecutorType[] = ['uk', 'rso', 'rop', 'unknown'];
    if (b.executorType !== undefined && !types.includes(b.executorType)) throw new HttpError(400, 'Неизвестный тип исполнителя');
    const errors: Record<string, string> = {};
    const inn = str(b.executorInn, 20);
    const innErr = inn ? innError(inn) : null;
    if (innErr) errors.inn = innErr;
    const fioIn = str(b.fio, 150);
    const fioErr = fioIn ? fioError(fioIn) : null;
    if (fioErr) errors.fio = fioErr;
    const billsIn: Record<string, number | null> = {};
    if (b.bills && typeof b.bills === 'object') {
      for (const [month, raw] of Object.entries(b.bills as Record<string, unknown>)) {
        if (!/^\d{4}-\d{2}$/.test(month)) continue;
        if (raw === '' || raw === null) {
          billsIn[month] = null;
          continue;
        }
        const r = billError(String(raw));
        if ('error' in r) errors[`bill_${month}`] = r.error;
        else billsIn[month] = r.amount;
      }
    }
    // Объём горячей воды за месяц и тарифы — для суммы за часы ниже +40 °C.
    const coldIn: Record<string, { volume: number; hot: number; cold: number } | null> = {};
    if (b.coldTariff && typeof b.coldTariff === 'object') {
      const num = (v: unknown) => {
        const t = String(v ?? '').replace(/\s/g, '').replace(',', '.');
        return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
      };
      for (const [month, raw] of Object.entries(b.coldTariff as Record<string, any>)) {
        if (!/^\d{4}-\d{2}$/.test(month) || !raw || typeof raw !== 'object') continue;
        if (!raw.volume && !raw.hot && !raw.cold) {
          coldIn[month] = null;
          continue;
        }
        const volume = num(raw.volume);
        const hot = num(raw.hot);
        const cold = num(raw.cold);
        if (!(volume > 0 && volume <= 100)) errors[`ct_vol_${month}`] = 'Объём горячей воды за месяц в м³, например 3,5';
        if (!(hot > 0 && hot <= 2000)) errors[`ct_hot_${month}`] = 'Тариф горячей воды, ₽ за м³, например 250';
        if (!(cold > 0 && cold <= 2000)) errors[`ct_cold_${month}`] = 'Тариф холодной воды, ₽ за м³, например 55';
        if (hot > 0 && cold > 0 && cold >= hot) errors[`ct_cold_${month}`] = 'Холодная вода должна стоить меньше горячей — проверьте тарифы';
        coldIn[month] = { volume, hot, cold };
      }
    }
    checkAll(errors);
    const coldTariff = { ...(claimOf(c.p).coldTariff ?? {}) };
    for (const [month, v] of Object.entries(coldIn)) {
      if (v) coldTariff[month] = v;
      else delete coldTariff[month];
    }
    const claim = {
      ...claimOf(c.p),
      fio: str(b.fio, 150),
      flat: str(b.flat, 10),
      account: str(b.account, 40),
      executor: str(b.executor, 200),
      executorInn: inn,
      executorType: b.executorType ?? claimOf(c.p).executorType,
      // Кто принял заявку (п. 106 Правил) — необязательно; диспетчер мог назвать и табельный номер.
      adsOperator: b.adsOperator !== undefined ? str(b.adsOperator, 80) : claimOf(c.p).adsOperator,
      coldTariff: Object.keys(coldTariff).length ? coldTariff : undefined,
    };
    db.updateParticipant(c.p.id, { claim: JSON.stringify(claim) });
    // Суммы из квитанции по месяцам: { "2026-09": "1200" } — для расчёта в рублях.
    if (Object.keys(billsIn).length) {
      const bills = { ...billsOf(c.p) };
      for (const [month, amount] of Object.entries(billsIn)) {
        if (amount === null) delete bills[month];
        else bills[month] = amount;
      }
      db.updateParticipant(c.p.id, { bills: JSON.stringify(bills) });
    }
    // «Запомнить мои данные» — ФИО, квартира и лицевой счёт подставятся в следующие заявления.
    if (b.remember === true) {
      // Пустое поле в этом заявлении не стирает сохранённое для следующих.
      const prev = db.personFor(req.userId!, c.house.id);
      db.savePerson(req.userId!, c.house.id, { fio: claim.fio || prev.fio, flat: claim.flat || prev.flat, account: claim.account || prev.account });
    }
    if (b.remember === false && db.getUser(req.userId!)?.save_personal) db.forgetPerson(req.userId!);
    // Акт ещё не подписан — житель в нём должен называться так же, как в заявлении.
    const act = db.getActByIncident(c.incident.id);
    if (act && act.status !== 'signed' && claim.fio && claim.fio.split(' ').length >= 2 && db.listSigners(act.id).some((x) => x.user_id === req.userId)) {
      db.updateSigner(act.id, req.userId!, claim.fio, claim.flat ?? null);
    }
    const fresh = loadCase(db, c.p.id)!;
    res.json({ case: summarize(db, norms, fresh, new Date()), claimText: fresh.p.ended_at ? claimToText(claimDocFor(db, norms, fresh, new Date())) : null });
  });

  /** Другие квартиры жителя в этом доме: по каждой — отдельное заявление со своей платой. */
  api.put('/cases/:id/extra-flats', (req: AuthedRequest, res) => {
    const c = ownCase(req);
    const list = Array.isArray(req.body?.flats) ? req.body.flats.slice(0, 5) : null;
    if (!list) throw new HttpError(400, 'Нужен список квартир');
    const errors: Record<string, string> = {};
    const flats = list.map((f: any, i: number) => {
      const flat = str(f?.flat, 10);
      if (!flat) errors[`xf_flat_${i}`] = 'Номер квартиры';
      const bills: Record<string, number> = {};
      for (const [month, raw] of Object.entries((f?.bills ?? {}) as Record<string, unknown>)) {
        if (!/^\d{4}-\d{2}$/.test(month) || raw === '' || raw === null || raw === undefined) continue;
        const r = billError(String(raw));
        if ('error' in r) errors[`xf_bill_${i}_${month}`] = r.error;
        else bills[month] = r.amount;
      }
      return { flat: flat ?? '', account: str(f?.account, 40), bills };
    });
    const own = claimOf(c.p).flat ?? db.getUserHouse(c.p.user_id, c.house.id)?.flat;
    flats.forEach((f: { flat: string }, i: number) => {
      if (own && f.flat && f.flat.toUpperCase() === own.toUpperCase()) errors[`xf_flat_${i}`] = 'Это ваша основная квартира — её заявление выше';
    });
    checkAll(errors);
    db.updateParticipant(c.p.id, { claim: JSON.stringify({ ...claimOf(c.p), extraFlats: flats.length ? flats : undefined }) });
    res.json({ case: summarize(db, norms, loadCase(db, c.p.id)!, new Date()) });
  });

  /** Житель подал заявление: дата и входящий номер попадут в требование и жалобы. */
  api.post('/cases/:id/submitted', (req: AuthedRequest, res) => {
    const c = ownCase(req);
    const raw = str(req.body?.date, 20);
    const date = raw ? new Date(raw) : null;
    if (!date || Number.isNaN(date.getTime())) throw fieldError('submittedAt', 'Укажите дату подачи');
    // «Сегодня» — по часовому поясу дома: подать заявление завтрашним днём нельзя.
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: c.house.tz });
    if (/^\d{4}-\d{2}-\d{2}/.test(raw!) ? raw!.slice(0, 10) > today : date.getTime() > Date.now()) throw fieldError('submittedAt', 'Эта дата ещё не наступила');
    if (date.getTime() < new Date(c.p.started_at).getTime() - 24 * 3_600_000) throw fieldError('submittedAt', 'Заявление не могли подать раньше отключения');
    const created = claimOf(c.p).createdAt;
    if (created && raw!.slice(0, 10) < new Date(created).toLocaleDateString('sv-SE', { timeZone: c.house.tz })) {
      throw fieldError('submittedAt', `Заявление датировано ${new Date(created).toLocaleDateString('ru-RU', { timeZone: c.house.tz })} — подать его раньше нельзя`);
    }
    const numRaw = typeof req.body?.number === 'string' ? req.body.number.replace(/^\s*(вх\.?\s*)?№\s*/i, '').trim() : '';
    if (numRaw.length > 40) throw fieldError('incoming', 'Входящий номер — до 40 знаков');
    const claim = { ...claimOf(c.p), submittedAt: date.toISOString(), incomingNumber: str(numRaw, 40) };
    db.updateParticipant(c.p.id, { claim: JSON.stringify(claim) });
    res.json({ case: summarize(db, norms, loadCase(db, c.p.id)!, new Date()) });
  });

  api.post('/cases/:id/pdf-link', (req: AuthedRequest, res) => {
    const c = ownCase(req);
    if (!c.p.ended_at) throw new HttpError(409, 'Заявление появится, когда услугу восстановят');
    deps.bot()?.markClaimIssued(c.p.id);
    deps.bot()?.refreshClaimIssue(c.p.id);
    const extra = Number.isInteger(req.body?.extra) ? Number(req.body.extra) : undefined;
    if (extra !== undefined && !claimOf(loadCase(db, c.p.id)!.p).extraFlats?.[extra]) throw new HttpError(404, 'Квартира не найдена');
    const path = extra !== undefined ? `/files/claim/${c.p.id}-${extra}.pdf` : `/files/claim/${c.p.id}.pdf`;
    const rel = signLink(path, cfg.linkSecret, 600);
    res.json({ url: `${cfg.publicUrl ?? ''}${rel}`, fileName: claimDocFor(db, norms, loadCase(db, c.p.id)!, new Date(), extra).fileName });
  });

  // ---------- акт с соседями (п. 110(1)) ----------
  api.post('/cases/:id/act', async (req: AuthedRequest, res, next) => {
    try {
      const c = ownCase(req);
      const bot = deps.bot();
      if (!bot) throw new HttpError(503, 'Бот сейчас недоступен');
      const fio = str(req.body?.fio, 150);
      if (!fio || /\d/.test(fio) || fio.split(' ').length < 2 || fio.length < 5) {
        throw fieldError('fio', 'Фамилия и имя, например «Иванова Анна Петровна»: без них подпись в акте не засчитают');
      }
      const flat = str(req.body?.flat, 10) ?? null;
      const actId = await actFromApp(bot, req.userId!, c.p.id, fio, flat);
      if (!actId) throw new HttpError(404, 'Дело не найдено');
      res.json({ url: `${cfg.publicUrl ?? ''}${signLink(`/files/act/${actId}.pdf`, cfg.linkSecret, 600)}`, fileName: actDocFor(db, norms, actId, new Date())?.fileName ?? 'Акт.pdf' });
    } catch (e) {
      next(e);
    }
  });

  api.post('/cases/:id/act/unsigned', (req: AuthedRequest, res) => {
    const c = ownCase(req);
    const bot = deps.bot();
    const act = db.getActByIncident(c.incident.id);
    if (!bot || !act || !unmarkActSigned(bot, req.userId!, act.id)) throw new HttpError(403, 'Отменить отметку может тот, кто начал акт');
    res.json({ ok: true });
  });

  /** Исправить время начала или окончания. */
  api.patch('/cases/:id/times', (req: AuthedRequest, res) => {
    const c = ownCase(req);
    const bot = deps.bot();
    if (!bot) throw new HttpError(503, 'Бот сейчас недоступен');
    const parse = (v: unknown, field: string) => {
      if (v === undefined || v === null || v === '') return null;
      const d = new Date(String(v));
      if (Number.isNaN(d.getTime())) throw fieldError(field, 'Укажите дату и время');
      return d;
    };
    const startedAt = parse(req.body?.startedAt, 'editStart');
    const endedAt = parse(req.body?.endedAt, 'editEnd');
    const err = bot.editTimesFromApp(req.userId!, c.p.id, startedAt, endedAt);
    if (err) throw new HttpError(422, err, { [/окончан/i.test(err) ? 'editEnd' : 'editStart']: err });
    res.json({ case: summarize(db, norms, loadCase(db, c.p.id)!, new Date()) });
  });

  api.post('/cases/:id/reopen', (req: AuthedRequest, res) => {
    const c = ownCase(req);
    const bot = deps.bot();
    if (!bot) throw new HttpError(503, 'Бот сейчас недоступен');
    const err = bot.reopenFromApp(req.userId!, c.p.id);
    if (err) throw new HttpError(422, err);
    res.json({ ok: true });
  });

  api.delete('/cases/:id', (req: AuthedRequest, res) => {
    const c = ownCase(req);
    const bot = deps.bot();
    if (!bot) throw new HttpError(503, 'Бот сейчас недоступен');
    const err = bot.deleteFromApp(req.userId!, c.p.id);
    if (err) throw new HttpError(422, err);
    res.json({ ok: true });
  });

  api.post('/cases/:id/readings', (req: AuthedRequest, res) => {
    const c = ownCase(req);
    const bot = deps.bot();
    if (!bot) throw new HttpError(503, 'Бот сейчас недоступен');
    const temp = tempOf(req.body?.temp, 'newTemp', c.incident.service_key);
    if (temp === null) throw fieldError('newTemp', 'Впишите, сколько градусов показал термометр');
    const at = req.body?.at ? new Date(req.body.at) : new Date();
    if (Number.isNaN(at.getTime())) throw fieldError('newTempAt', 'Укажите дату и время');
    const err = bot.addReadingFromApp(req.userId!, c.p.id, temp, at);
    if (err) throw new HttpError(422, err, { newTempAt: err });
    const threshold = bot.normThreshold(c.incident.service_key, !!c.p.corner);
    const note = threshold !== null && temp >= threshold ? `${fmtTemp(temp)} — это уже норма. Если так и осталось, отметьте «${c.incident.service_key === 'heating_temp' ? 'Стало тепло' : 'Вода горячая'}».` : null;
    res.json({ case: summarize(db, norms, loadCase(db, c.p.id)!, new Date()), note });
  });

  api.delete('/cases/:id/readings/:rid', (req: AuthedRequest, res) => {
    const c = ownCase(req);
    if (c.p.status === 'refunded' || c.p.status === 'refused' || c.p.status === 'claim_ready') throw new HttpError(422, 'Заявление уже готово — замеры в нём не меняем');
    if (!db.deleteReading(c.p.id, Number(req.params.rid))) throw new HttpError(404, 'Замер не найден');
    res.json({ case: summarize(db, norms, loadCase(db, c.p.id)!, new Date()) });
  });

  /** Перерасчёт пришёл (сумма) или нет. */
  api.post('/cases/:id/receipt', async (req: AuthedRequest, res, next) => {
    try {
      const c = ownCase(req);
      const bot = deps.bot();
      if (!bot) throw new HttpError(503, 'Бот сейчас недоступен');
      const action = req.body?.action === 'undo' ? 'undo' : req.body?.refunded === true || req.body?.action === 'yes' ? 'yes' : 'no';
      let amount: number | null = null;
      if (action === 'yes' && req.body?.amount !== undefined && req.body.amount !== '') {
        if (/^\s*0+([.,]0+)?\s*(₽|руб\.?)?\s*$/i.test(String(req.body.amount))) {
          throw fieldError('refundAmount', c.p.status === 'refunded' ? 'Если не вернули ничего — нажмите «Снять отметку «вернули»», потом «Не сделали»' : 'Если не вернули ничего — нажмите «Не сделали»');
        }
        const rawAmount = String(req.body.amount);
        amount = parseRubles(rawAmount);
        // parseRubles отсекает всё больше миллиона: «2000000» — не «не число», а слишком большая сумма.
        const tooBig = (amount !== null && amount > 100_000) || (amount === null && /^\s*[1-9][\d\s\u00a0]*([.,]\d+)?\s*(₽|руб\.?|р\.?)?\s*$/i.test(rawAmount));
        if (tooBig) throw fieldError('refundAmount', 'Проверьте сумму: перерасчёт по одной услуге обычно меньше 100 000 ₽');
        if (amount === null) throw fieldError('refundAmount', 'Сумма — число, например 115 или 115,20');
      }
      const err = await bot.receiptFromApp(req.userId!, c.p.id, action, amount);
      if (err) throw new HttpError(422, err);
      res.json({ case: summarize(db, norms, loadCase(db, c.p.id)!, new Date()) });
    } catch (e) {
      next(e);
    }
  });

  /** Документы, если перерасчёт не сделали: требование о штрафе, жалоба в ГЖИ, заявление в общество потребителей. */
  api.post('/cases/:id/escalation-link', (req: AuthedRequest, res) => {
    const c = ownCase(req);
    const kind = String(req.body?.kind ?? '');
    if (!ESC_FILES[kind]) throw new HttpError(400, 'Неизвестный документ');
    if (!c.p.ended_at) throw new HttpError(409, 'Сначала отметьте, что починили');
    if (c.p.status !== 'refused' && c.p.status !== 'refunded') throw new HttpError(409, 'Эти документы нужны, если перерасчёт не сделали — отметьте это, когда придёт квитанция');
    const path = `/files/esc/${c.p.id}-${kind}.pdf`;
    res.json({ url: `${cfg.publicUrl ?? ''}${signLink(path, cfg.linkSecret, 600)}`, fileName: ESC_FILES[kind] });
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
  app.get('/files/esc/:file', async (req, res, next) => {
    try {
      const m = /^(\d+)-(fine|gji|ozpp)\.pdf$/.exec(String(req.params.file));
      const path = `/files/esc/${req.params.file}`;
      if (!m || !verifyLink(path, req.query.exp as string, req.query.sig as string, cfg.linkSecret)) {
        throw new HttpError(403, 'Ссылка устарела. Нажмите кнопку документа ещё раз.');
      }
      const c = loadCase(db, Number(m[1]));
      const bot = deps.bot();
      if (!c || !c.p.ended_at || !bot) throw new HttpError(404, 'Документ не найден');
      const doc = escalationDocFor(bot, c, m[2] as EscalationKind);
      const pdf = await claimToPdf(doc);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.fileName ?? ESC_FILES[m[2]])}`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(pdf);
    } catch (e) {
      next(e);
    }
  });

  app.get('/files/act/:file', async (req, res, next) => {
    try {
      const m = /^(\d+)\.pdf$/.exec(String(req.params.file));
      const path = `/files/act/${req.params.file}`;
      if (!m || !verifyLink(path, req.query.exp as string, req.query.sig as string, cfg.linkSecret)) {
        throw new HttpError(403, 'Ссылка устарела. Нажмите кнопку скачивания акта ещё раз.');
      }
      const doc = actDocFor(db, norms, Number(m[1]), new Date());
      if (!doc) throw new HttpError(404, 'Акт не найден');
      const pdf = await claimToPdf(doc);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.fileName ?? 'Акт.pdf')}`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(pdf);
    } catch (e) {
      next(e);
    }
  });

  app.get('/files/claim/:file', async (req, res, next) => {
    try {
      const m = /^(\d+)(?:-(\d+))?\.pdf$/.exec(String(req.params.file));
      const path = `/files/claim/${req.params.file}`;
      if (!m || !verifyLink(path, req.query.exp as string, req.query.sig as string, cfg.linkSecret)) {
        throw new HttpError(403, 'Ссылка устарела. Нажмите кнопку скачивания ещё раз.');
      }
      const c = loadCase(db, Number(m[1]));
      if (!c || !c.p.ended_at) throw new HttpError(404, 'Заявление не найдено');
      const doc = claimDocFor(db, norms, c, new Date(), m[2] !== undefined ? Number(m[2]) : undefined);
      const pdf = await claimToPdf(doc);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.fileName ?? 'Заявление.pdf')}`);
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
    res.status(status).json({ error: status >= 500 ? 'Внутренняя ошибка сервера. Попробуйте ещё раз.' : err.message, ...(err instanceof HttpError && err.fields ? { fields: err.fields } : {}) });
  });

  return app;
}
