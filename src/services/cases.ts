import { calculate, refundAmount } from '../calc/engine.ts';
import type { CalcInput, CalcResult, Interval, MonthCalc } from '../calc/engine.ts';
import { fmtPercent } from '../calc/format.ts';
import { allowedMonthlyHours } from '../calc/norms.ts';
import { formatShort, monthKey } from '../calc/time.ts';
import type { Norms } from '../calc/norms.ts';
import { buildClaim, claimToText } from '../docs/claim.ts';
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

export function calcInputFor(db: Db, norms: Norms, c: CaseBundle, now: Date): CalcInput {
  const norm = norms.services[c.incident.service_key];
  const end = c.p.ended_at ? new Date(c.p.ended_at) : now;
  if (norm.kind === 'interruption') {
    return { kind: 'interruption', intervals: [{ start: new Date(c.p.started_at), end }], variant: c.incident.variant };
  }
  const readings = db.listReadings(c.p.id).map((r) => ({ at: new Date(r.at), tempC: r.temp_c }));
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
  const allowed = allowedMonthlyHours(norm.interruption, c.incident.variant);
  const months: MonthCalc[] = own.months.map((m) => {
    const before = prev.months.find((x) => x.month === m.month);
    const total = all.months.find((x) => x.month === m.month);
    if (!before || !total) return m;
    const percent = Math.max(0, Math.round((total.percent - before.percent) * 100) / 100);
    const dates = earlier
      .filter((iv) => monthKey(iv.start, c.house.tz) <= m.month && monthKey(iv.end, c.house.tz) >= m.month)
      .map((iv) => `${formatShort(iv.start, c.house.tz)}–${formatShort(iv.end, c.house.tz)}`);
    return {
      ...total,
      percent,
      lines: [
        `Лимит ${allowed} ч — на весь месяц, поэтому считаю вместе с прошлыми отключениями: ${dates.join(', ')}.`,
        ...total.lines,
        before.percent > 0
          ? `Из них ${fmtPercent(before.percent)} уже положены по прошлому отключению — по этому: ${fmtPercent(percent)}.`
          : `По прошлому отключению снижения не было — всё это по этому отключению: ${fmtPercent(percent)}.`,
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

/** Меньше часа «холодной» горячей воды — копейки; заявление ради этого не делаем. */
export const MIN_COLD_TARIFF_HOURS = 1;

export function hasMoney(calc: CalcResult): boolean {
  return calc.months.some((m) => m.percent > 0 || (m.coldTariffHours ?? 0) >= MIN_COLD_TARIFF_HOURS);
}

/** Плата за месяц, которую житель уже вписывал в другом деле по той же услуге и дому. */
function billHints(db: Db, c: CaseBundle): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of db.listUserParticipants(c.p.user_id)) {
    if (o.id === c.p.id) continue;
    const inc = db.getIncident(o.incident_id);
    if (!inc || inc.service_key !== c.incident.service_key || inc.house_id !== c.incident.house_id) continue;
    for (const [month, bill] of Object.entries(billsOf(o))) if (!(month in out)) out[month] = bill;
  }
  return out;
}

export function estimate(calc: CalcResult, bills: Record<string, number>): { sum: number; complete: boolean } {
  let sum = 0;
  let complete = true;
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
    incident: c.incident,
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

export function claimDocFor(db: Db, norms: Norms, c: CaseBundle, now: Date): ClaimDoc {
  const doc = buildClaim(claimInputFor(db, norms, c, now));
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
export function statusTitle(status: ParticipantStatus, kind: string): string {
  if (status === 'tracking' && kind !== 'interruption') return 'Слежу за температурой';
  return STATUS_TITLE[status];
}

export const STATUS_TITLE: Record<ParticipantStatus, string> = {
  tracking: 'Слежу за отключением',
  ended: 'Услугу восстановили — нужен расчёт',
  claim_ready: 'Заявление готово',
  refunded: 'Перерасчёт получен',
  refused: 'Перерасчёт не сделали',
  closed: 'Закрыт без перерасчёта',
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
};

export function summarize(db: Db, norms: Norms, c: CaseBundle, now: Date): CaseSummary {
  const norm = norms.services[c.incident.service_key];
  const calc = calcFor(db, norms, c, now);
  const bills = billsOf(c.p);
  const est = estimate(calc, bills);
  const hints = billHints(db, c);
  return {
    id: c.p.id,
    service: c.incident.service_key,
    serviceTitle: norm.title,
    address: c.house.address,
    tz: c.house.tz,
    startedAt: c.p.started_at,
    endedAt: c.p.ended_at,
    status: c.p.status,
    statusTitle: statusTitle(c.p.status, norm.kind),
    kind: norm.kind,
    evidence: c.incident.evidence,
    adsNumber: c.p.own_ads_number || c.incident.ads_number,
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
  return buildActDoc({ norms, incident, house: db.getHouse(incident.house_id)!, act, signers, readings, now });
}
