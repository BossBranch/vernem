import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export type ServiceKey =
  | 'hot_water_off'
  | 'hot_water_temp'
  | 'heating_temp'
  | 'heating_off'
  | 'cold_water_off'
  | 'electricity_off'
  | 'gas_off'
  | 'sewerage_off'
  | 'waste_off';

export const SERVICE_ORDER: ServiceKey[] = [
  'hot_water_off',
  'hot_water_temp',
  'heating_temp',
  'heating_off',
  'cold_water_off',
  'electricity_off',
  'gas_off',
  'sewerage_off',
  'waste_off',
];

export type InterruptionNorm = {
  monthly_hours?: number;
  single_hours?: number;
  /** Единовременный лимит в тёплое время (май–сентябрь), если отличается. */
  single_hours_warm?: number;
  single_hours_note?: string;
  variants?: Record<string, number>;
  default_variant?: string;
  rate_percent: number;
  unit_hours: number;
};

export type HotWaterTempNorm = {
  norm_c: number;
  day_tolerance_c: number;
  night_tolerance_c: number;
  night_from_hour: number;
  night_to_hour: number;
  step_c: number;
  rate_percent_per_step_hour: number;
  cold_tariff_below_c: number;
};

export type HeatingTempNorm = {
  norm_c: number;
  corner_norm_c: number;
  cold_region_norm_c: number;
  cold_region_corner_norm_c: number;
  night_drop_c: number;
  night_from_hour: number;
  night_to_hour: number;
  rate_percent_per_degree_hour: number;
};

export type ServiceNorm = {
  key: ServiceKey;
  title: string;
  genitive: string;
  button: string;
  item: string;
  url: string;
  kind: 'interruption' | 'hot_water_temperature' | 'heating_temperature';
  interruption?: InterruptionNorm;
  temperature?: HotWaterTempNorm | HeatingTempNorm;
  planned_outage_note?: string;
  measure_hint?: string;
  executor_hint?: string;
};

export type Norms = {
  schema_version: number;
  source: {
    title: string;
    edition: string;
    checked_at: string;
    rules_url: string;
    recalculation_items: string;
    fixation_items: string;
  };
  services: Record<ServiceKey, ServiceNorm>;
};

function fail(msg: string): never {
  throw new Error(`norms.yaml: ${msg}`);
}

export function parseNorms(text: string): Norms {
  const raw = parse(text) as any;
  if (!raw || raw.schema_version !== 1) fail('ожидается schema_version: 1');
  if (!raw.source?.checked_at) fail('нет source.checked_at');
  const services = {} as Record<ServiceKey, ServiceNorm>;
  for (const key of SERVICE_ORDER) {
    const s = raw.services?.[key];
    if (!s) fail(`нет услуги ${key}`);
    for (const f of ['title', 'genitive', 'button', 'item', 'url', 'kind']) {
      if (!s[f]) fail(`${key}: нет поля ${f}`);
    }
    if (s.kind === 'interruption') {
      const i = s.interruption;
      if (!i || typeof i.rate_percent !== 'number' || typeof i.unit_hours !== 'number') {
        fail(`${key}: неполный блок interruption`);
      }
      if (typeof i.monthly_hours !== 'number' && !i.variants) {
        fail(`${key}: нужен monthly_hours или variants`);
      }
    } else if (!s.temperature) {
      fail(`${key}: нет блока temperature`);
    }
    services[key] = { ...s, key };
  }
  return { schema_version: 1, source: raw.source, services };
}

let cached: Norms | null = null;

export function loadNorms(path = process.env.NORMS_PATH ?? 'norms/norms.yaml'): Norms {
  if (!cached) cached = parseNorms(readFileSync(path, 'utf8'));
  return cached;
}

/** Допустимые часы перерыва в месяц с учётом варианта (например, число источников питания). */
export function allowedMonthlyHours(norm: InterruptionNorm, variant?: string | null): number {
  if (norm.variants) {
    const v = variant && norm.variants[variant] !== undefined ? variant : norm.default_variant;
    if (!v || norm.variants[v] === undefined) throw new Error('Не найден вариант нормы');
    return norm.variants[v];
  }
  return norm.monthly_hours as number;
}
