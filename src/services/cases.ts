import { calculate, coldTariffAmount, refundAmount } from '../calc/engine.ts';
import type { CalcInput, CalcResult, Interval, MonthCalc } from '../calc/engine.ts';
import { fmtPercent } from '../calc/format.ts';
import { allowedMonthlyHours } from '../calc/norms.ts';
import { formatShort, monthKey, monthTitle } from '../calc/time.ts';
import type { Norms } from '../calc/norms.ts';
import { buildClaim, claimTo, claimToText } from '../docs/claim.ts';
import type { ClaimDoc, ClaimInput } from '../docs/claim.ts';
import type { Act, ActSigner, Claim, Db, House, Incident, Participant, ParticipantStatus } from '../db/db.ts';
import { buildActDoc } from '../docs/act.ts';

export type CaseBundle = { p: Participant; incident: Incident; house: House };

export function loadCase(db: Db, participantId: number): CaseBundle | null {
  const p = db.getParticipant(participantId);
  if (!p) return null;
  const incident = db.getIncident(p.incident_id);
  if (!incident) return null;
  const house = db.getHouse(incident.house_id);
  if (!house) return null;
  return { p, incident, house };
}

/** Лимит перерыва света зависит от дома, а не от дела: ответ «есть лифт» хранится в карточке дома. */
function variantFor(db: Db, c: CaseBundle): string | null {
  if (c.incident.service_key !== 'electricity_off') return c.incident.variant;
  const two = db.houseInfo(c.house).twoPowerSources;
  return two === undefined ? c.incident.variant : two ? 'two_sources' : 'one_source';
}

export function calcInputFor(db: Db, norms: Norms, c: CaseBundle, now: Date): CalcInput {
  const norm = norms.services[c.incident.service_key];
  const end = c.p.ended_at ? new Date(c.p.ended_at) : now;
  if (norm.kind === 'interruption') {
    return { kind: 'interruption', intervals: [{ start: new Date(c.p.started_at), end }], variant: variantFor(db, c) };
  }
  // Замеры до начала дела не считаем (начало могли исправить позже).
  const start = new Date(c.p.started_at).getTime();
  const readings = db
    .listReadings(c.p.id)
    .map((r) => ({ at: new Date(r.at), tempC: r.temp_c }))
    .filter((r) => r.at.getTime() >= start - 60_000);
  if (norm.kind === 'heating_temperature') {
    return { kind: 'heating_temperature', readings, end, corner: !!c.p.corner };
  }
  return { kind: 'hot_water_temperature', readings, end };
}

/**
 * Прошлые отключения той же услуги у того же жителя по тому же дому. Лимит перерыва — на месяц суммарно
 * (Приложение № 1), поэтому второе отключение в месяце считается вместе с первым.
 */
function earlierOutages(db: Db, c: CaseBundle): Interval[] {
  const own = new Date(c.p.started_at).getTime();
  return db
    .listUserParticipants(c.p.user_id)
    .filter((o) => o.id !== c.p.id && o.ended_at)
    .filter((o) => {
      const t = new Date(o.started_at).getTime();
      return t < own || (t === own && o.id < c.p.id);
    })
    .filter((o) => {
      const inc = db.getIncident(o.incident_id);
      return !!inc && inc.service_key === c.incident.service_key && inc.house_id === c.incident.house_id;
    })
    .map((o) => ({ start: new Date(o.started_at), end: new Date(o.ended_at!) }));
}

export function calcFor(db: Db, norms: Norms, c: CaseBundle, now: Date): CalcResult {
  const result = calcRaw(db, norms, c, now);
  // Отопление (и «холодно», и «нет отопления») летом не подаётся — эти месяцы не считаем.
  return c.incident.service_key === 'heating_temp' || c.incident.service_key === 'heating_off' ? withoutSummer(result) : result;
}

function calcRaw(db: Db, norms: Norms, c: CaseBundle, now: Date): CalcResult {
  const norm = norms.services[c.incident.service_key];
  const input = calcInputFor(db, norms, c, now);
  const own = calculate(norm, input, c.house.tz);
  if (input.kind !== 'interruption' || !norm.interruption) return own;
  const earlier = earlierOutages(db, c);
  if (!earlier.length) return own;
  // Считаем месяц целиком (прошлые + это отключение) и вычитаем то, что положено по прошлым:
  // так деньги за один и тот же месяц не посчитаются дважды.
  const prev = calculate(norm, { ...input, intervals: earlier }, c.house.tz);
  const all = calculate(norm, { ...input, intervals: [...earlier, ...input.intervals] }, c.house.tz);
  const allowed = allowedMonthlyHours(norm.interruption, input.variant);
  const months: MonthCalc[] = own.months.map((m) => {
    const before = prev.months.find((x) => x.month === m.month);
    const total = all.months.find((x) => x.month === m.month);
    if (!before || !total) return m;
    const percent = Math.max(0, Math.round((total.percent - before.percent) * 100) / 100);
    const dates = earlier
      .filter((iv) => monthKey(iv.start, c.house.tz) <= m.month && monthKey(iv.end, c.house.tz) >= m.month)
      .map((iv) => `${formatShort(iv.start, c.house.tz)}–${formatShort(iv.end, c.house.tz)}`);
    const many = dates.length > 1;
    return {
      ...total,
      percent,
      lines: [
        `Допустимая продолжительность ${allowed} ч установлена на месяц, поэтому ${many ? 'учтены также предыдущие перерывы' : 'учтён также предыдущий перерыв'}: ${dates.join(', ')}.`,
        ...total.lines,
        before.percent > 0
          ? `Из них ${fmtPercent(before.percent)} приходится на ${many ? 'предыдущие перерывы' : 'предыдущий перерыв'} (заявлено отдельно); по данному перерыву — ${fmtPercent(percent)}.`
          : `По ${many ? 'предыдущим перерывам' : 'предыдущему перерыву'} снижение не положено; по данному перерыву — ${fmtPercent(percent)}.`,
      ],
    };
  });
  return { ...own, months };
}

export function billsOf(p: Participant): Record<string, number> {
  try {
    return JSON.parse(p.bills || '{}');
  } catch {
    return {};
  }
}

export function claimOf(p: Participant): Claim {
  try {
    return p.claim ? JSON.parse(p.claim) : {};
  } catch {
    return {};
  }
}

/** Июнь–август — отопление не подаётся: эти месяцы в расчёт холода не берём. */
function withoutSummer(calc: CalcResult): CalcResult {
  return {
    ...calc,
    months: calc.months.map((m) => {
      const month = Number(m.month.split('-')[1]);
      return month >= 6 && month <= 8 ? { ...m, percent: 0, lines: ['Летом (июнь–август) отопление не подаётся — этот месяц не считается.'] } : m;
    }),
  };
}

/** Снимок расчёта в момент выдачи заявления: изменился — значит, выданное заявление устарело. */
export function claimSnapshot(db: Db, norms: Norms, c: CaseBundle, now: Date): string {
  const calc = calcFor(db, norms, c, now);
  // v — доказательства в тексте заявления: подписанный акт, проверка исполнителя, номер заявки.
  const act = db.getActByIncident(c.incident.id);
  const v = [act?.status === 'signed' ? 1 : 0, c.p.inspection ?? '', c.p.own_ads_number ?? c.incident.ads_number ?? ''].join('|');
  // b — плата из квитанции и тарифы: от них сумма в рублях в заявлении.
  const b = JSON.stringify([Object.entries(billsOf(c.p)).sort(), Object.entries(claimOf(c.p).coldTariff ?? {}).sort()]);
  // r — кому адресовано: шапка (название, ИНН, тип получателя) и абзац про УК. Персональных данных в снимке нет:
  // «Не сохранять» стирает ФИО из дела, а снимок остаётся.
  const cl = claimOf(c.p);
  const r = JSON.stringify([claimTo(cl, norms.services[c.incident.service_key]), cl.executorType === 'uk' || !cl.executorType]);
  return JSON.stringify({ s: c.p.started_at, e: c.p.ended_at, m: calc.months.map((m) => [m.month, m.percent]), v, b, r });
}

/** Меньше часа «холодной» горячей воды — копейки; заявление ради этого не делаем. */
export const MIN_COLD_TARIFF_HOURS = 1;

export function hasMoney(calc: CalcResult): boolean {
  return calc.months.some((m) => m.percent > 0 || (m.coldTariffHours ?? 0) >= MIN_COLD_TARIFF_HOURS);
}

/** Строка квитанции для услуги: «нет горячей воды» и «еле тёплая» — одна и та же строка. */
const BILL_LINE: Record<string, string> = {
  hot_water_off: 'hot_water', hot_water_temp: 'hot_water', heating_off: 'heating', heating_temp: 'heating',
  cold_water_off: 'cold_water', electricity_off: 'electricity', gas_off: 'gas', sewerage_off: 'sewerage', waste_off: 'waste',
};

/** Интервалы других дел жителя по связанной услуге того же дома («нет горячей воды» ↔ «еле тёплая»). */
export const RELATED_SERVICE: Record<string, string> = { hot_water_off: 'hot_water_temp', hot_water_temp: 'hot_water_off', heating_off: 'heating_temp', heating_temp: 'heating_off' };

/**
 * Пересечение по времени с делом по связанной услуге: одни и те же часы нельзя оплатить дважды
 * («воды нет» и «вода еле тёплая» одновременно не бывает). Возвращает описание пересечения или null.
 */
export function relatedOverlap(db: Db, norms: Norms, userId: number, houseId: number, service: string, start: Date, end: Date | null, exceptPid?: number): string | null {
  const related = RELATED_SERVICE[service];
  if (!related) return null;
  for (const o of db.listUserParticipants(userId)) {
    if (o.id === exceptPid) continue;
    const inc = db.getIncident(o.incident_id);
    if (!inc || inc.house_id !== houseId || inc.service_key !== related) continue;
    const oStart = new Date(o.started_at).getTime();
    const oEnd = o.ended_at ? new Date(o.ended_at).getTime() : Infinity;
    const myEnd = end ? end.getTime() : Infinity;
    if (start.getTime() < oEnd && oStart < myEnd) {
      const tz = db.getHouse(houseId)?.tz ?? 'Europe/Moscow';
      return `«${norms.services[related].button}» (${formatShort(new Date(o.started_at), tz)}${o.ended_at ? `–${formatShort(new Date(o.ended_at), tz)}` : ', ещё не закончилось'})`;
    }
  }
  return null;
}

/** Плата за месяц, которую житель уже вписывал в другом деле по той же строке квитанции и дому. */
function billHints(db: Db, c: CaseBundle): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of db.listUserParticipants(c.p.user_id)) {
    if (o.id === c.p.id) continue;
    const inc = db.getIncident(o.incident_id);
    if (!inc || inc.house_id !== c.incident.house_id || BILL_LINE[inc.service_key] !== BILL_LINE[c.incident.service_key]) continue;
    for (const [month, bill] of Object.entries(billsOf(o))) if (!(month in out)) out[month] = bill;
  }
  return out;
}

export function estimate(calc: CalcResult, bills: Record<string, number>, claim?: Claim): { sum: number; complete: boolean } {
  let sum = 0;
  let complete = true;
  // Часы «по тарифу холодной воды» — если житель вписал объём и тарифы.
  for (const m of calc.months) sum += coldTariffAmount(m.month, m.coldTariffHours ?? 0, claim?.coldTariff?.[m.month]);
  for (const m of calc.months) {
    if (m.percent <= 0) continue;
    const bill = bills[m.month];
    if (bill) sum += refundAmount(bill, m.percent);
    else complete = false;
  }
  return { sum: Math.round(sum * 100) / 100, complete };
}

/** Акт по отключению вместе с подписантами (если его собирали). */
export function actOf(db: Db, incidentId: number): { act: Act; signers: ActSigner[] } | null {
  const act = db.getActByIncident(incidentId);
  return act ? { act, signers: db.listSigners(act.id) } : null;
}

export function claimInputFor(db: Db, norms: Norms, c: CaseBundle, now: Date): ClaimInput {
  return {
    norms,
    // Лимит перерыва в тексте — тот же, что в расчёте: ответ про лифт берётся из карточки дома.
    incident: { ...c.incident, variant: variantFor(db, c) },
    house: c.house,
    participant: c.p,
    readings: db.listReadings(c.p.id),
    calc: calcFor(db, norms, c, now),
    bills: billsOf(c.p),
    claim: claimOf(c.p),
    now: c.p.ended_at ? new Date(Math.max(new Date(c.p.ended_at).getTime(), now.getTime())) : now,
    photos: db.listPhotos(c.p.id),
    act: actOf(db, c.incident.id),
  };
}

export function claimDocFor(db: Db, norms: Norms, c: CaseBundle, now: Date, extra?: number): ClaimDoc {
  const input = claimInputFor(db, norms, c, now);
  // Заявление на другую квартиру: та же история, свои квартира, лицевой счёт и плата.
  const flat = extra !== undefined ? input.claim.extraFlats?.[extra] : undefined;
  if (flat) {
    input.claim = { ...input.claim, flat: flat.flat, account: flat.account, coldTariff: undefined };
    input.bills = flat.bills;
  }
  const doc = buildClaim(input);
  if (flat) doc.fileName = doc.fileName?.replace(/^Заявление_/, `Заявление_кв${flat.flat.replace(/[^\dА-Яа-яA-Za-z]/g, '')}_`);
  if (c.incident.demo) doc.note = `ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ: не является реальным заявлением. ${doc.note}`;
  // Адрес УК из карточки дома — если заявление адресовано именно ей.
  const info = db.houseInfo(c.house);
  const executor = claimOf(c.p).executor?.trim();
  if (info.ukAddress && executor && executor === info.ukName?.trim()) {
    doc.to = doc.to.map((l) => (/^адрес: _+$/.test(l) ? `адрес: ${info.ukAddress}` : l));
  }
  return doc;
}

export function claimTextFor(db: Db, norms: Norms, c: CaseBundle, now: Date): string {
  return claimToText(claimDocFor(db, norms, c, now));
}

/** Статус по-человечески: для холода и еле тёплой воды «отключения» нет — следим за температурой. */
export function statusTitle(status: ParticipantStatus, kind: string, service?: string): string {
  if (status === 'tracking' && service === 'waste_off') return 'Слежу, пока не вывезут';
  if (status === 'tracking' && kind !== 'interruption') return 'Слежу за температурой';
  if (status === 'ended' && kind !== 'interruption') return 'Стало нормально — осталось скачать заявление';
  return STATUS_TITLE[status];
}

export const STATUS_TITLE: Record<ParticipantStatus, string> = {
  tracking: 'Слежу за отключением',
  ended: 'Починили — осталось скачать заявление',
  claim_ready: 'Заявление готово — осталось подать',
  refunded: 'Перерасчёт получен',
  refused: 'Перерасчёт не сделали',
  closed: 'Закрыто',
};

export type CaseSummary = {
  id: number;
  service: string;
  kind: string;
  serviceTitle: string;
  address: string;
  tz: string;
  startedAt: string;
  endedAt: string | null;
  status: ParticipantStatus;
  statusTitle: string;
  evidence: string;
  startEvidence: string;
  ownNumber: boolean;
  adsNumber: string | null;
  role: string;
  neighbours: number;
  demo: boolean;
  months: { month: string; percent: number; lines: string[]; bill: number | null; billHint: number | null; coldTariffHours: number }[];
  serviceButton: string;
  basis: string;
  basisUrl: string;
  estimate: number;
  estimateComplete: boolean;
  refundAmount: number | null;
  claim: Claim;
  readings: { id: number; at: string; tempC: number }[];
  cardMid: string | null;
  /** mine — житель вписан в акт или начал его; initiator — может отметить «подписан». */
  act: { status: Act['status']; residents: number; chair: boolean; mine: boolean; initiator: boolean } | null;
  photos: number;
  inspection: Participant['inspection'];
  /** Заявление уже выдавали, а расчёт или время с тех пор изменились. */
  claimOutdated: boolean;
  extraFlats: { flat: string; account?: string; bills: Record<string, number>; estimate: number }[];
};

/** Снимок выданного заявления отличается от текущего. */
export function snapshotChanged(issued: string, current: string): boolean {
  const old = JSON.parse(issued);
  const cur = JSON.parse(current);
  // Старые снимки хранят меньше полей (до 1.0.5 — без доказательств, до 1.0.9 — без платы): сравниваем только то, что в них есть.
  for (const k of Object.keys(cur)) if (!(k in old)) delete cur[k];
  return JSON.stringify(old) !== JSON.stringify(cur);
}

function claimOutdated(db: Db, norms: Norms, c: CaseBundle, now: Date): boolean {
  const snap = claimOf(c.p).issuedSnapshot;
  if (!snap || !c.p.ended_at) return false;
  return snapshotChanged(snap, claimSnapshot(db, norms, c, now));
}

export function summarize(db: Db, norms: Norms, c: CaseBundle, now: Date): CaseSummary {
  const norm = norms.services[c.incident.service_key];
  const calc = calcFor(db, norms, c, now);
  const bills = billsOf(c.p);
  const claim = claimOf(c.p);
  const est = estimate(calc, bills, claim);
  const hints = billHints(db, c);
  // Заявления на другие квартиры в этом доме — со своей платой из квитанции.
  const extraFlats = (claim.extraFlats ?? []).map((f) => ({ ...f, estimate: estimate(calc, f.bills).sum }));
  return {
    id: c.p.id,
    service: c.incident.service_key,
    serviceTitle: norm.title,
    address: c.house.address,
    tz: c.house.tz,
    startedAt: c.p.started_at,
    endedAt: c.p.ended_at,
    status: c.p.status,
    // Подали — дальше ждём квитанцию за месяц подачи: там должен появиться перерасчёт.
    statusTitle:
      c.p.status === 'claim_ready' && claim.submittedAt
        ? `Подано — ждём квитанцию за ${monthTitle(monthKey(new Date(claim.submittedAt), c.house.tz))}`
        : c.p.status === 'closed' && c.p.ended_at && !hasMoney(calc)
          ? norm.kind === 'interruption'
            ? 'Денег не положено — отключение было коротким'
            : 'Денег не положено — отклонение было недолгим'
          : statusTitle(c.p.status, norm.kind, c.incident.service_key),
    kind: norm.kind,
    // Свой номер жителя при отключении «без номера» — тоже доказательство.
    evidence: c.p.own_ads_number && c.incident.evidence === 'self' ? (c.p.own_evidence ?? 'ads') : c.incident.evidence,
    // Начало дела — время звонка или обращения только если с него дело и началось.
    startEvidence: c.incident.evidence,
    // Номер заявки получил сам житель — тогда он знает, кто её принял.
    ownNumber: !!c.p.own_ads_number || (c.p.role === 'reporter' && c.incident.evidence === 'ads'),
    // Повторный звонок первого жителя — показываем оба номера, первый не теряем.
    adsNumber:
      c.p.role === 'reporter' && c.p.own_ads_number && c.incident.ads_number && c.p.own_ads_number !== c.incident.ads_number
        ? `${c.incident.ads_number}, повторно № ${c.p.own_ads_number}`
        : c.p.own_ads_number || c.incident.ads_number,
    claimOutdated: claimOutdated(db, norms, c, now),
    extraFlats,
    role: c.p.role,
    neighbours: db.listParticipants(c.incident.id).length - 1,
    demo: !!c.incident.demo,
    months: calc.months.map((m) => ({
      month: m.month,
      percent: m.percent,
      lines: m.lines,
      bill: bills[m.month] ?? null,
      billHint: hints[m.month] ?? null,
      coldTariffHours: m.coldTariffHours ?? 0,
    })),
    serviceButton: norm.button,
    basis: norm.item,
    basisUrl: norm.url,
    estimate: est.sum,
    estimateComplete: est.complete,
    refundAmount: c.p.refund_amount,
    claim: claimOf(c.p),
    readings: db.listReadings(c.p.id).map((r) => ({ id: r.id, at: r.at, tempC: r.temp_c })),
    cardMid: c.p.last_card_mid,
    act: actSummary(db, c.incident.id, c.p.user_id),
    photos: db.listPhotos(c.p.id).length,
    inspection: c.p.inspection,
  };
}

function actSummary(db: Db, incidentId: number, userId: number): CaseSummary['act'] {
  const a = actOf(db, incidentId);
  if (!a) return null;
  const initiator = a.act.initiator_user_id === userId;
  return {
    status: a.act.status,
    residents: a.signers.filter((s) => s.role === 'resident').length,
    chair: a.act.chair_signed === 1 || a.signers.some((s) => s.role === 'chair'),
    mine: initiator || a.signers.some((s) => s.user_id === userId),
    initiator,
  };
}

/** PDF-документ акта: подписанты из бота и их замеры температуры. */
export function actDocFor(db: Db, norms: Norms, actId: number, now: Date): ClaimDoc | null {
  const act = db.getAct(actId);
  const incident = act ? db.getIncident(act.incident_id) : undefined;
  if (!act || !incident) return null;
  const signers = db.listSigners(act.id);
  const readings = signers.map((s) => {
    const p = db.getParticipantFor(incident.id, s.user_id);
    return { flat: s.flat, readings: p ? db.listReadings(p.id) : [] };
  });
  const doc = buildActDoc({ norms, incident, house: db.getHouse(incident.house_id)!, act, signers, readings, now });
  if (incident.demo) doc.note = `ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ: не является реальным актом. ${doc.note}`;
  return doc;
}
