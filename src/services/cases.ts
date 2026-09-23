import { calculate, refundAmount } from '../calc/engine.ts';
import type { CalcInput, CalcResult } from '../calc/engine.ts';
import type { Norms } from '../calc/norms.ts';
import { buildClaim, claimToText } from '../docs/claim.ts';
import type { ClaimDoc, ClaimInput } from '../docs/claim.ts';
import type { Act, ActSigner, Claim, Db, House, Incident, Participant, ParticipantStatus } from '../db/db.ts';

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

export function calcFor(db: Db, norms: Norms, c: CaseBundle, now: Date): CalcResult {
  return calculate(norms.services[c.incident.service_key], calcInputFor(db, norms, c, now), c.house.tz);
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

export function hasMoney(calc: CalcResult): boolean {
  return calc.months.some((m) => m.percent > 0 || (m.coldTariffHours ?? 0) > 0);
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
  return doc;
}

export function claimTextFor(db: Db, norms: Norms, c: CaseBundle, now: Date): string {
  return claimToText(claimDocFor(db, norms, c, now));
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
  months: { month: string; percent: number; lines: string[]; bill: number | null; coldTariffHours: number }[];
  basis: string;
  basisUrl: string;
  estimate: number;
  estimateComplete: boolean;
  refundAmount: number | null;
  claim: Claim;
  readings: { at: string; tempC: number }[];
  cardMid: string | null;
  act: { status: Act['status']; residents: number; chair: boolean } | null;
  photos: number;
  inspection: Participant['inspection'];
};

export function summarize(db: Db, norms: Norms, c: CaseBundle, now: Date): CaseSummary {
  const norm = norms.services[c.incident.service_key];
  const calc = calcFor(db, norms, c, now);
  const bills = billsOf(c.p);
  const est = estimate(calc, bills);
  return {
    id: c.p.id,
    service: c.incident.service_key,
    serviceTitle: norm.title,
    address: c.house.address,
    tz: c.house.tz,
    startedAt: c.p.started_at,
    endedAt: c.p.ended_at,
    status: c.p.status,
    statusTitle: STATUS_TITLE[c.p.status],
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
      coldTariffHours: m.coldTariffHours ?? 0,
    })),
    basis: norm.item,
    basisUrl: norm.url,
    estimate: est.sum,
    estimateComplete: est.complete,
    refundAmount: c.p.refund_amount,
    claim: claimOf(c.p),
    readings: db.listReadings(c.p.id).map((r) => ({ at: r.at, tempC: r.temp_c })),
    cardMid: c.p.last_card_mid,
    act: actSummary(db, c.incident.id),
    photos: db.listPhotos(c.p.id).length,
    inspection: c.p.inspection,
  };
}

function actSummary(db: Db, incidentId: number): CaseSummary['act'] {
  const a = actOf(db, incidentId);
  if (!a) return null;
  return { status: a.act.status, residents: a.signers.filter((s) => s.role === 'resident').length, chair: a.act.chair_signed === 1 || a.signers.some((s) => s.role === 'chair') };
}
