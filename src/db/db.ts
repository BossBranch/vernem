import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CalcResult } from '../calc/engine.ts';
import type { ServiceKey } from '../calc/norms.ts';
import { normalizeCity } from '../calc/cities.ts';

export type Evidence = 'ads' | 'written' | 'self';
export type ParticipantStatus = 'tracking' | 'ended' | 'claim_ready' | 'refunded' | 'refused' | 'closed';
export type ExecutorType = 'uk' | 'rso' | 'rop' | 'unknown';
/** Итог проверки исполнителем (п. 108–109): акт составлен / никто не пришёл / перенесли. */
export type Inspection = 'executor_act' | 'no_show' | 'rescheduled';

export type User = {
  id: number;
  first_name: string | null;
  state: string;
  state_data: string;
  house_id: number | null;
  entrance: string | null;
  notify_house: number;
  fio: string | null;
  flat: string | null;
  account: string | null;
  save_personal: number;
  house_chat_id: number | null;
  created_at: string;
};

export type House = {
  id: number;
  code: string | null;
  address: string;
  address_norm: string;
  tz: string;
  electricity_variant: string | null;
  chair_user_id: number | null;
  /** JSON HouseInfo: юридические данные дома, которые заполняют жители. */
  info: string | null;
  demo: number;
  /** Город (для домов первой версии — null). Дом ищется и сравнивается только внутри своего города. */
  city: string | null;
  city_norm: string | null;
};

/**
 * Юридическая информация о доме. Заполняют жители (данные есть в квитанции и в ГИС ЖКХ),
 * поэтому в интерфейсе всегда видно, кто и когда её обновил.
 */
export type HouseInfo = {
  ukName?: string;
  ukInn?: string;
  ukAddress?: string;
  ukEmail?: string;
  adsPhone?: string;
  rsoHeat?: string;
  rsoWater?: string;
  rsoPower?: string;
  rsoGas?: string;
  rop?: string;
  gji?: string;
  /** Есть лифт или больше 9 этажей → два ввода электричества (лимит перерыва 2 ч, а не 24). Одно на весь дом. */
  twoPowerSources?: boolean;
  updatedAt?: string;
  updatedBy?: number;
};

/** Адрес в списке «Мои адреса»: у одного человека их может быть несколько. */
/** Адрес в списке жителя: подъезд, уведомления, квартира и лицевой счёт — у каждого адреса свои. */
export type UserHouse = House & { entrance: string | null; notify: number; flat: string | null; account: string | null };

export type Incident = {
  id: number;
  code: string;
  house_id: number;
  service_key: ServiceKey;
  reporter_user_id: number;
  started_at: string;
  ended_at: string | null;
  ads_number: string | null;
  evidence: Evidence;
  variant: string | null;
  entrance: string | null;
  demo: number;
  created_at: string;
};

export type Claim = {
  fio?: string;
  flat?: string;
  account?: string;
  executor?: string;
  executorInn?: string;
  executorType?: ExecutorType;
  createdAt?: string;
  /** Когда житель подал заявление исполнителю и под каким входящим номером. */
  submittedAt?: string;
  incomingNumber?: string;
  /** Кто принял заявку в аварийной службе — диспетчер обязан назвать себя (п. 106 Правил). */
  adsOperator?: string;
  /** Снимок расчёта и времени на момент выдачи: если изменился — заявление надо подать заново. */
  issuedSnapshot?: string;
  /** Часы, когда горячая вода была ниже +40 °C: объём и тарифы из квитанции по месяцам — для суммы в рублях. */
  coldTariff?: Record<string, { volume: number; hot: number; cold: number }>;
  /** Другие квартиры жителя в этом же доме: по каждой — своё заявление (своя квартира, счёт и плата). */
  extraFlats?: { flat: string; account?: string; bills: Record<string, number> }[];
};

export type Participant = {
  id: number;
  incident_id: number;
  user_id: number;
  role: 'reporter' | 'neighbour';
  started_at: string;
  ended_at: string | null;
  own_ads_number: string | null;
  corner: number;
  status: ParticipantStatus;
  bills: string; // JSON: { "2026-09": 1200 }
  calc: string | null; // JSON CalcResult
  claim: string | null; // JSON Claim
  refund_amount: number | null;
  last_card_mid: string | null;
  inspection: Inspection | null;
  /** Свой номер жителя (own_ads_number) — по звонку в аварийную службу или письменному обращению. */
  own_evidence?: 'ads' | 'written' | null;
  created_at: string;
  updated_at: string;
};

export type Reading = { id: number; participant_id: number; at: string; temp_c: number };

export type ReminderKind = 'ask_restored' | 'ask_receipt' | 'ask_inspection';
export type Reminder = { id: number; kind: ReminderKind; participant_id: number; user_id: number; due_at: string; sent_at: string | null };

/** Уведомление соседа о зафиксированном в доме отключении. */
export type Alert = { id: number; incident_id: number; user_id: number; due_at: string; sent_at: string | null; answer: string | null };

/**
 * Акт о нарушении качества, составленный потребителями без исполнителя (п. 110(1) ПП РФ № 354):
 * collecting — собираем подтверждения жителей; chair — ждём председателя;
 * ready — все подтвердили, PDF разослан; signed — инициатор отметил, что акт подписан на бумаге.
 */
export type ActStatus = 'collecting' | 'chair' | 'ready' | 'signed';
export type ActReason = 'no_ads' | 'no_inspection';
export type Act = {
  id: number;
  code: string;
  incident_id: number;
  initiator_user_id: number;
  reason: ActReason;
  status: ActStatus;
  created_at: string;
  ready_at: string | null;
  signed_at: string | null;
  /** Подписал ли акт на бумаге председатель совета дома: 1 — да, 0 — нет, null — не спрашивали. */
  chair_signed: number | null;
};
export type ActSigner = { id: number; act_id: number; user_id: number; role: 'resident' | 'chair'; fio: string; flat: string | null; confirmed_at: string };

export type PhotoKind = 'evidence' | 'receipt' | 'act';
export type Photo = { id: number; participant_id: number; kind: PhotoKind; token: string; url: string | null; received_at: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  first_name TEXT,
  state TEXT NOT NULL DEFAULT 'idle',
  state_data TEXT NOT NULL DEFAULT '{}',
  house_id INTEGER REFERENCES houses(id),
  entrance TEXT,
  notify_house INTEGER NOT NULL DEFAULT 1,
  fio TEXT, flat TEXT, account TEXT,
  save_personal INTEGER NOT NULL DEFAULT 0,
  house_chat_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS houses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  address TEXT NOT NULL,
  address_norm TEXT NOT NULL UNIQUE,
  tz TEXT NOT NULL,
  electricity_variant TEXT,
  chair_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  house_id INTEGER NOT NULL REFERENCES houses(id),
  service_key TEXT NOT NULL,
  reporter_user_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  ads_number TEXT,
  evidence TEXT NOT NULL,
  variant TEXT,
  entrance TEXT,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS incidents_open ON incidents(house_id, service_key, ended_at);
CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  own_ads_number TEXT,
  corner INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'tracking',
  bills TEXT NOT NULL DEFAULT '{}',
  calc TEXT,
  claim TEXT,
  refund_amount REAL,
  last_card_mid TEXT,
  inspection TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(incident_id, user_id)
);
CREATE INDEX IF NOT EXISTS participants_user ON participants(user_id);
CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  temp_c REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  due_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(sent_at, due_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  name TEXT NOT NULL,
  data TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS chats (
  chat_id INTEGER PRIMARY KEY,
  title TEXT,
  house_id INTEGER REFERENCES houses(id),
  linked_by_user_id INTEGER,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

// Таблицы и индексы, которые появились после первой версии. Создаются после миграции колонок.
const SCHEMA_V2 = `
CREATE UNIQUE INDEX IF NOT EXISTS houses_code ON houses(code);
CREATE INDEX IF NOT EXISTS users_house ON users(house_id);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  due_at TEXT NOT NULL,
  sent_at TEXT,
  answer TEXT,
  UNIQUE(incident_id, user_id)
);
CREATE INDEX IF NOT EXISTS alerts_due ON alerts(sent_at, due_at);
CREATE TABLE IF NOT EXISTS acts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  incident_id INTEGER NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
  initiator_user_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'collecting',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ready_at TEXT,
  signed_at TEXT,
  chair_signed INTEGER
);
CREATE TABLE IF NOT EXISTS act_signers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  act_id INTEGER NOT NULL REFERENCES acts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  fio TEXT NOT NULL,
  flat TEXT,
  confirmed_at TEXT NOT NULL,
  UNIQUE(act_id, user_id)
);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  token TEXT NOT NULL,
  url TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_participant ON photos(participant_id);
CREATE TABLE IF NOT EXISTS user_houses (
  user_id INTEGER NOT NULL,
  house_id INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  entrance TEXT,
  notify INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, house_id)
);
CREATE INDEX IF NOT EXISTS user_houses_house ON user_houses(house_id);
-- Жители первой версии: один адрес в users.house_id переносится в список адресов.
INSERT OR IGNORE INTO user_houses (user_id, house_id, entrance, notify)
  SELECT id, house_id, entrance, notify_house FROM users WHERE house_id IS NOT NULL;
`;

/** Колонки, добавленные после первой версии: для БД, созданных раньше, добавляются через ALTER TABLE. */
const ADDED_COLUMNS: [table: string, column: string, ddl: string][] = [
  ['users', 'entrance', 'TEXT'],
  ['users', 'notify_house', 'INTEGER NOT NULL DEFAULT 1'],
  ['houses', 'code', 'TEXT'],
  ['houses', 'chair_user_id', 'INTEGER'],
  ['incidents', 'entrance', 'TEXT'],
  ['participants', 'inspection', 'TEXT'],
  ['houses', 'info', 'TEXT'],
  ['houses', 'demo', 'INTEGER NOT NULL DEFAULT 0'],
  ['houses', 'city', 'TEXT'],
  ['houses', 'city_norm', 'TEXT'],
  ['acts', 'chair_signed', 'INTEGER'],
  ['user_houses', 'flat', 'TEXT'],
  ['user_houses', 'account', 'TEXT'],
  ['participants', 'own_evidence', 'TEXT'],
];

/**
 * Грубая нормализация адреса, чтобы соседи попадали в один дом:
 * «ул. Примерная, д. 5, корп. 1» и «Примерная 5к1» → «примерная5к1».
 * В следующей версии заменяется привязкой к ФИАС/ГАР.
 */
/** «кв. 15», «квартира 15» — номер квартиры, а не часть адреса дома. */
const FLAT_RE = /(?<![а-яa-z])(?:квартира|кв)\.?\s*№?\s*(\d+[а-яa-z]?)/giu;

/** Квартира, если житель вписал её в строку адреса. */
export function flatFromAddress(address: string): string | null {
  const m = new RegExp(FLAT_RE.source, 'iu').exec(address);
  return m ? m[1].toUpperCase() : null;
}

/** Адрес дома для записи: без квартиры, названия с заглавной буквы («ленина 5» → «Ленина 5»). */
export function tidyStreet(address: string): string {
  const ABBR = new Set(['ул', 'д', 'к', 'корп', 'стр', 'пр', 'пр-т', 'просп', 'пер', 'ш', 'б-р', 'бульв', 'наб', 'пл', 'пр-д', 'мкр', 'лит', 'литера', 'дом', 'улица', 'проспект', 'переулок', 'шоссе', 'бульвар', 'набережная', 'площадь', 'проезд', 'корпус', 'строение', 'микрорайон', 'им', 'имени', 'на', 'и']);
  return address
    .replace(new RegExp(FLAT_RE.source, 'giu'), ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s,]+$/, '')
    .trim()
    .split(' ')
    .map((w) => {
      const bare = w.toLowerCase().replace(/[.,]/g, '');
      if (ABBR.has(bare) || !/^[а-яё]/.test(w)) return w;
      return w[0].toUpperCase() + w.slice(1);
    })
    .join(' ');
}

export function normalizeAddress(address: string): string {
  const W = '[а-яa-z0-9-]';
  const word = (list: string) => new RegExp(`(?<!${W})(?:${list})(?!${W})\\.?`, 'gu');
  return address
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[,;]/g, ' ')
    .replace(FLAT_RE, ' ')
    // «д1», «д.1» — номер дома без пробела.
    .replace(/(?<![а-яa-z])д\.?(?=\d)/gu, ' ')
    .replace(word('корпус|корп|к'), ' к')
    .replace(word('строение|стр'), ' с')
    .replace(word('улица|ул|проспект|просп|пр-т|пр|переулок|пер|бульвар|бульв|б-р|шоссе|ш|площадь|пл|набережная|наб|проезд|пр-д|дом|д'), ' ')
    .replace(/\./g, ' ')
    .replace(/\s+/g, '')
    .trim();
}

/** Слова поискового запроса адреса в той же нормализации, что и address_norm. */
export function addressTokens(query: string): string[] {
  const stop = new Set(['улица', 'ул', 'проспект', 'просп', 'пр-т', 'пр', 'переулок', 'пер', 'бульвар', 'бульв', 'б-р', 'шоссе', 'ш', 'площадь', 'пл', 'набережная', 'наб', 'проезд', 'пр-д', 'дом', 'д', 'город', 'г', 'кв', 'квартира']);
  return query
    .toLowerCase()
    .replace(/ё/g, 'е')
    // «Садовая 10 кв 15» — квартира не часть адреса дома: иначе «15» ищется в адресе и дом не находится.
    .replace(new RegExp(FLAT_RE.source, 'giu'), ' ')
    .replace(/[,.;"«»()]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && !stop.has(t))
    .map((t) => normalizeAddress(t))
    .filter(Boolean)
    .slice(0, 5);
}

export function newCode(): string {
  return randomBytes(6).toString('base64url').replace(/[-_]/g, 'x');
}

/**
 * Ключ исполнителя для подсчёта нарушений по нескольким домам: ИНН, а если его нет —
 * название без организационно-правовой формы и кавычек («ООО "УК Пример"» → «ук пример»).
 */
export function executorKey(claim: Pick<Claim, 'executor' | 'executorInn'>): string | null {
  if (claim.executorInn) return `inn:${claim.executorInn}`;
  if (!claim.executor) return null;
  const name = claim.executor
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(^|\s)(ооо|оао|зао|пао|ао|муп|гуп|ип|тсж|тсн|жск)(?=\s|$|["«])/g, ' ')
    .replace(/["«»'“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name ? `name:${name}` : null;
}

export class Db {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.db.exec(SCHEMA);
    this.migrate();
    this.db.exec(SCHEMA_V2);
    // Второй проход: колонки таблиц, которые появились только в SCHEMA_V2 (например, acts).
    this.migrate();
    // Квартира и лицевой счёт раньше были одни на жителя. У кого один адрес — переносим к нему,
    // у кого несколько — не угадываем (иначе чужая квартира попала бы в заявление по другому дому).
    this.db.exec(`UPDATE user_houses SET flat = (SELECT flat FROM users WHERE users.id = user_houses.user_id),
      account = (SELECT account FROM users WHERE users.id = user_houses.user_id)
      WHERE flat IS NULL AND account IS NULL
        AND (SELECT COUNT(*) FROM user_houses u2 WHERE u2.user_id = user_houses.user_id) = 1
        AND (SELECT save_personal FROM users WHERE users.id = user_houses.user_id) = 1`);
  }

  private migrate() {
    for (const [table, column, ddl] of ADDED_COLUMNS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      // Таблицы актов в самой старой схеме нет: её создаст SCHEMA_V2 уже с нужными колонками.
      if (!cols.length) continue;
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  close() {
    this.db.close();
  }

  // ---------- пользователи и состояние диалога ----------

  ensureUser(id: number, firstName?: string | null): User {
    this.db
      .prepare(`INSERT INTO users (id, first_name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET first_name = COALESCE(excluded.first_name, users.first_name)`)
      .run(id, firstName ?? null);
    return this.getUser(id)!;
  }

  getUser(id: number): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  }

  setState(userId: number, state: string, data: object = {}) {
    this.db.prepare('UPDATE users SET state = ?, state_data = ? WHERE id = ?').run(state, JSON.stringify(data), userId);
  }

  getState<T = Record<string, any>>(userId: number): { state: string; data: T } {
    const u = this.getUser(userId);
    return { state: u?.state ?? 'idle', data: JSON.parse(u?.state_data ?? '{}') as T };
  }

  updateUser(userId: number, fields: Partial<Pick<User, 'house_id' | 'entrance' | 'notify_house' | 'fio' | 'flat' | 'account' | 'save_personal' | 'house_chat_id'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const sql = `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => (fields[k] ?? null) as any), userId);
  }

  /** Удаляет все персональные данные пользователя (152-ФЗ: право на удаление). */
  deleteUserData(userId: number) {
    this.db.exec('BEGIN');
    try {
      const parts = this.db.prepare('SELECT id, incident_id, role FROM participants WHERE user_id = ?').all(userId) as {
        id: number;
        incident_id: number;
        role: string;
      }[];
      for (const p of parts) this.db.prepare('DELETE FROM participants WHERE id = ?').run(p.id);
      // Отключения без участников больше никому не нужны.
      this.db.prepare('DELETE FROM incidents WHERE id NOT IN (SELECT DISTINCT incident_id FROM participants)').run();
      // ФИО и квартира в чужих актах — тоже персональные данные этого жителя.
      this.db.prepare('DELETE FROM act_signers WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM alerts WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM user_houses WHERE user_id = ?').run(userId);
      this.db.prepare('UPDATE houses SET chair_user_id = NULL WHERE chair_user_id = ?').run(userId);
      this.db.prepare('DELETE FROM events WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------- дома ----------

  /**
   * Дом по адресу. С городом: адрес хранится как «Город, улица дом», а ключ дома включает город,
   * поэтому «Садовая 10» в Москве и в Казани — разные дома.
   */
  /** Дом, который уже есть в реестре под этим городом и адресом (без создания нового). */
  findHouse(address: string, city: string): House | undefined {
    const norm = `${normalizeCity(city)}|${normalizeAddress(address.trim())}`;
    return this.db.prepare('SELECT * FROM houses WHERE address_norm = ?').get(norm) as House | undefined;
  }

  upsertHouse(address: string, tz: string, demo = 0, city: string | null = null): House {
    const street = demo ? address.trim() : tidyStreet(address);
    const cityNorm = city ? normalizeCity(city) : null;
    const norm = cityNorm ? `${cityNorm}|${normalizeAddress(street)}` : normalizeAddress(street);
    const full = city ? `${city}, ${street}` : street;
    this.db
      .prepare('INSERT INTO houses (code, address, address_norm, tz, demo, city, city_norm) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(address_norm) DO NOTHING')
      .run(newCode(), full, norm, tz, demo, city, cityNorm);
    const house = this.db.prepare('SELECT * FROM houses WHERE address_norm = ?').get(norm) as House;
    // Дома из первой версии БД создавались без кода приглашения.
    if (!house.code) {
      house.code = newCode();
      this.db.prepare('UPDATE houses SET code = ? WHERE id = ?').run(house.code, house.id);
    }
    return house;
  }

  getHouse(id: number): House | undefined {
    return this.db.prepare('SELECT * FROM houses WHERE id = ?').get(id) as House | undefined;
  }

  getHouseByCode(code: string): House | undefined {
    return this.db.prepare('SELECT * FROM houses WHERE code = ?').get(code) as House | undefined;
  }

  setHouseVariant(houseId: number, variant: string) {
    this.db.prepare('UPDATE houses SET electricity_variant = ? WHERE id = ?').run(variant, houseId);
  }

  setChair(houseId: number, userId: number | null) {
    this.db.prepare('UPDATE houses SET chair_user_id = ? WHERE id = ?').run(userId, houseId);
  }

  /** Жители дома (по списку «Мои адреса»), которые согласны получать уведомления об отключениях. */
  houseSubscribers(houseId: number): User[] {
    return this.db
      .prepare('SELECT u.* FROM users u JOIN user_houses uh ON uh.user_id = u.id WHERE uh.house_id = ? AND uh.notify = 1 ORDER BY u.id')
      .all(houseId) as User[];
  }

  countHouseMembers(houseId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM user_houses WHERE house_id = ?').get(houseId) as { n: number }).n;
  }

  // ---------- «Мои адреса» ----------

  listUserHouses(userId: number): UserHouse[] {
    return this.db
      .prepare('SELECT h.*, uh.entrance AS entrance, uh.notify AS notify, uh.flat AS flat, uh.account AS account FROM user_houses uh JOIN houses h ON h.id = uh.house_id WHERE uh.user_id = ? ORDER BY uh.created_at, h.id')
      .all(userId) as UserHouse[];
  }

  getUserHouse(userId: number, houseId: number): UserHouse | undefined {
    return this.db
      .prepare('SELECT h.*, uh.entrance AS entrance, uh.notify AS notify, uh.flat AS flat, uh.account AS account FROM user_houses uh JOIN houses h ON h.id = uh.house_id WHERE uh.user_id = ? AND uh.house_id = ?')
      .get(userId, houseId) as UserHouse | undefined;
  }

  /** Добавляет адрес в список жителя (повторно — без изменений) и делает его текущим. */
  addUserHouse(userId: number, houseId: number) {
    this.db.prepare('INSERT INTO user_houses (user_id, house_id) VALUES (?, ?) ON CONFLICT(user_id, house_id) DO NOTHING').run(userId, houseId);
    this.db.prepare('UPDATE users SET house_id = ? WHERE id = ?').run(houseId, userId);
  }

  setUserHouse(userId: number, houseId: number, fields: { entrance?: string | null; notify?: number; flat?: string | null; account?: string | null }) {
    for (const key of ['entrance', 'notify', 'flat', 'account'] as const) {
      if (fields[key] !== undefined) this.db.prepare(`UPDATE user_houses SET ${key} = ? WHERE user_id = ? AND house_id = ?`).run(fields[key] ?? null, userId, houseId);
    }
  }

  /**
   * Личные данные для документов по конкретному дому: ФИО общее, квартира и лицевой счёт — у адреса
   * (у жителя может быть своя квартира и квартира родителей). Только если житель разрешил их хранить.
   */
  personFor(userId: number, houseId: number): { fio: string | null; flat: string | null; account: string | null } {
    const u = this.getUser(userId);
    const uh = this.getUserHouse(userId, houseId);
    return { fio: u?.save_personal ? u.fio : null, flat: uh?.flat ?? null, account: uh?.account ?? null };
  }

  savePerson(userId: number, houseId: number, p: { fio?: string | null; flat?: string | null; account?: string | null }) {
    this.updateUser(userId, { fio: p.fio ?? null, save_personal: 1 });
    if (this.getUserHouse(userId, houseId)) this.setUserHouse(userId, houseId, { flat: p.flat ?? null, account: p.account ?? null });
  }

  /** «Не запоминать» — забываем ФИО; квартира и лицевой счёт остаются в карточке адреса, там их и правят. */
  forgetPerson(userId: number) {
    this.updateUser(userId, { fio: null, flat: null, account: null, save_personal: 0 });
  }

  removeUserHouse(userId: number, houseId: number) {
    this.db.prepare('DELETE FROM user_houses WHERE user_id = ? AND house_id = ?').run(userId, houseId);
    const next = this.db.prepare('SELECT house_id FROM user_houses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId) as { house_id: number } | undefined;
    this.db.prepare('UPDATE users SET house_id = ? WHERE id = ?').run(next?.house_id ?? null, userId);
  }

  /**
   * Поиск дома в реестре сервиса по словам запроса: «примерная 5», «5 примерная», «ул. Примерная, д. 5».
   * Реестр — дома, которые уже добавили жители (плюс демо-дома). В продакшене — ФИАС.
   */
  searchHouses(query: string, limit = 8, city: string | null = null): House[] {
    const tokens = addressTokens(query);
    if (!tokens.length) return [];
    const where = tokens.map(() => 'address_norm LIKE ?').join(' AND ');
    const cityNorm = city ? normalizeCity(city) : null;
    return this.db
      .prepare(`SELECT * FROM houses WHERE ${where}${cityNorm ? ' AND city_norm = ?' : ''} ORDER BY demo, length(address_norm), id LIMIT ?`)
      .all(...tokens.map((t) => `%${t}%`), ...(cityNorm ? [cityNorm] : []), limit) as House[];
  }

  /** Города, в которых у жителя есть адреса, — для быстрых кнопок. */
  userCities(userId: number): string[] {
    return (
      this.db.prepare('SELECT DISTINCT h.city AS city FROM user_houses uh JOIN houses h ON h.id = uh.house_id WHERE uh.user_id = ? AND h.city IS NOT NULL ORDER BY uh.created_at DESC').all(userId) as {
        city: string;
      }[]
    ).map((r) => r.city);
  }

  houseInfo(house: House): HouseInfo {
    try {
      return house.info ? (JSON.parse(house.info) as HouseInfo) : {};
    } catch {
      return {};
    }
  }

  setHouseInfo(houseId: number, info: HouseInfo) {
    this.db.prepare('UPDATE houses SET info = ? WHERE id = ?').run(JSON.stringify(info), houseId);
  }

  // ---------- отключения ----------

  createIncident(i: Omit<Incident, 'id' | 'code' | 'created_at' | 'ended_at' | 'demo' | 'entrance'> & { demo?: number; entrance?: string | null }): Incident {
    const code = newCode();
    const res = this.db
      .prepare(
        `INSERT INTO incidents (code, house_id, service_key, reporter_user_id, started_at, ads_number, evidence, variant, entrance, demo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(code, i.house_id, i.service_key, i.reporter_user_id, i.started_at, i.ads_number, i.evidence, i.variant, i.entrance ?? null, i.demo ?? 0);
    return this.getIncident(Number(res.lastInsertRowid))!;
  }

  getIncident(id: number): Incident | undefined {
    return this.db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as Incident | undefined;
  }

  getIncidentByCode(code: string): Incident | undefined {
    return this.db.prepare('SELECT * FROM incidents WHERE code = ?').get(code) as Incident | undefined;
  }

  findOpenIncident(houseId: number, service: ServiceKey): Incident | undefined {
    return this.db
      .prepare('SELECT * FROM incidents WHERE house_id = ? AND service_key = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(houseId, service) as Incident | undefined;
  }

  listOpenIncidents(houseId: number): Incident[] {
    return this.db.prepare('SELECT * FROM incidents WHERE house_id = ? AND ended_at IS NULL AND demo = 0 ORDER BY id DESC').all(houseId) as Incident[];
  }

  closeIncident(id: number, endedAt: string) {
    this.db.prepare('UPDATE incidents SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(endedAt, id);
  }

  /** Житель, сообщивший первым, исправил время — время отключения для акта меняется вместе с ним. */
  setIncidentTimes(id: number, startedAt: string, endedAt?: string | null) {
    this.db.prepare('UPDATE incidents SET started_at = ? WHERE id = ?').run(startedAt, id);
    if (endedAt !== undefined) this.db.prepare('UPDATE incidents SET ended_at = ? WHERE id = ?').run(endedAt, id);
  }

  /** Участники всех отключений одной услуги в доме — чтобы пересчитать их при смене данных дома. */
  listHouseParticipants(houseId: number, serviceKey: string): Participant[] {
    return this.db
      .prepare('SELECT p.* FROM participants p JOIN incidents i ON i.id = p.incident_id WHERE i.house_id = ? AND i.service_key = ?')
      .all(houseId, serviceKey) as Participant[];
  }

  /** «Ещё не починили»: снова открыть отключение, если его закрыли по ошибке. */
  reopenIncident(id: number) {
    this.db.prepare('UPDATE incidents SET ended_at = NULL WHERE id = ?').run(id);
  }

  /** Житель сообщил без номера, а потом дозвонился — номер заявки становится доказательством. */
  setIncidentEvidence(id: number, evidence: Incident['evidence'], adsNumber: string) {
    this.db.prepare('UPDATE incidents SET evidence = ?, ads_number = ? WHERE id = ?').run(evidence, adsNumber, id);
  }

  // ---------- участники ----------

  addParticipant(p: Pick<Participant, 'incident_id' | 'user_id' | 'role' | 'started_at'> & { own_ads_number?: string | null; corner?: number }): Participant {
    this.db
      .prepare(
        `INSERT INTO participants (incident_id, user_id, role, started_at, own_ads_number, corner)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(incident_id, user_id) DO NOTHING`,
      )
      .run(p.incident_id, p.user_id, p.role, p.started_at, p.own_ads_number ?? null, p.corner ?? 0);
    return this.db.prepare('SELECT * FROM participants WHERE incident_id = ? AND user_id = ?').get(p.incident_id, p.user_id) as Participant;
  }

  getParticipant(id: number): Participant | undefined {
    return this.db.prepare('SELECT * FROM participants WHERE id = ?').get(id) as Participant | undefined;
  }

  getParticipantFor(incidentId: number, userId: number): Participant | undefined {
    return this.db.prepare('SELECT * FROM participants WHERE incident_id = ? AND user_id = ?').get(incidentId, userId) as Participant | undefined;
  }

  listParticipants(incidentId: number): Participant[] {
    return this.db.prepare('SELECT * FROM participants WHERE incident_id = ? ORDER BY id').all(incidentId) as Participant[];
  }

  listUserParticipants(userId: number): Participant[] {
    return this.db.prepare('SELECT * FROM participants WHERE user_id = ? ORDER BY id DESC').all(userId) as Participant[];
  }

  openParticipantsOfUser(userId: number): Participant[] {
    return this.db.prepare("SELECT * FROM participants WHERE user_id = ? AND status = 'tracking' ORDER BY id DESC").all(userId) as Participant[];
  }

  updateParticipant(id: number, fields: Partial<Omit<Participant, 'id' | 'incident_id' | 'user_id' | 'created_at'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const sql = `UPDATE participants SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => (fields[k] ?? null) as any), id);
  }

  /** Удаляет случай жителя; отключение без участников удаляется вместе с ним. */
  deleteParticipant(id: number) {
    const p = this.getParticipant(id);
    if (!p) return;
    this.db.prepare('DELETE FROM participants WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM incidents WHERE id = ? AND id NOT IN (SELECT DISTINCT incident_id FROM participants)').run(p.incident_id);
  }

  setCalc(id: number, calc: CalcResult) {
    this.updateParticipant(id, { calc: JSON.stringify(calc) });
  }

  // ---------- показания температуры ----------

  addReading(participantId: number, at: string, tempC: number) {
    this.db.prepare('INSERT INTO readings (participant_id, at, temp_c) VALUES (?, ?, ?)').run(participantId, at, tempC);
  }

  listReadings(participantId: number): Reading[] {
    return this.db.prepare('SELECT * FROM readings WHERE participant_id = ? ORDER BY at').all(participantId) as Reading[];
  }

  deleteReading(participantId: number, readingId: number): boolean {
    return this.db.prepare('DELETE FROM readings WHERE id = ? AND participant_id = ?').run(readingId, participantId).changes > 0;
  }

  // ---------- напоминания ----------

  schedule(kind: ReminderKind, participantId: number, userId: number, dueAt: Date) {
    this.db.prepare("DELETE FROM reminders WHERE participant_id = ? AND kind = ? AND sent_at IS NULL").run(participantId, kind);
    this.db.prepare('INSERT INTO reminders (kind, participant_id, user_id, due_at) VALUES (?, ?, ?, ?)').run(kind, participantId, userId, dueAt.toISOString());
  }

  cancelReminders(participantId: number, kind?: ReminderKind) {
    if (kind) this.db.prepare('DELETE FROM reminders WHERE participant_id = ? AND kind = ? AND sent_at IS NULL').run(participantId, kind);
    else this.db.prepare('DELETE FROM reminders WHERE participant_id = ? AND sent_at IS NULL').run(participantId);
  }

  /** Забирает наступившие напоминания и сразу помечает их отправленными, чтобы не отправить дважды. */
  takeDueReminders(now: Date, limit = 50): Reminder[] {
    const rows = this.db
      .prepare('SELECT * FROM reminders WHERE sent_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT ?')
      .all(now.toISOString(), limit) as Reminder[];
    const mark = this.db.prepare('UPDATE reminders SET sent_at = ? WHERE id = ?');
    for (const r of rows) mark.run(now.toISOString(), r.id);
    return rows;
  }

  // ---------- уведомления соседей ----------

  /** Ставит уведомление в очередь; повторно одному жителю по одному отключению не отправляется. */
  queueAlert(incidentId: number, userId: number, dueAt: Date) {
    this.db.prepare('INSERT INTO alerts (incident_id, user_id, due_at) VALUES (?, ?, ?) ON CONFLICT(incident_id, user_id) DO NOTHING').run(incidentId, userId, dueAt.toISOString());
  }

  takeDueAlerts(now: Date, limit = 100): Alert[] {
    const rows = this.db.prepare('SELECT * FROM alerts WHERE sent_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT ?').all(now.toISOString(), limit) as Alert[];
    const mark = this.db.prepare('UPDATE alerts SET sent_at = ? WHERE id = ?');
    for (const a of rows) mark.run(now.toISOString(), a.id);
    return rows;
  }

  getAlert(id: number): Alert | undefined {
    return this.db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as Alert | undefined;
  }

  answerAlert(id: number, answer: string) {
    this.db.prepare('UPDATE alerts SET answer = ? WHERE id = ?').run(answer, id);
  }

  /** Жители сделали отметку сами — неотправленные уведомления по этому отключению им больше не нужны. */
  cancelAlert(incidentId: number, userId: number) {
    this.db.prepare('DELETE FROM alerts WHERE incident_id = ? AND user_id = ? AND sent_at IS NULL').run(incidentId, userId);
  }

  // ---------- акты (п. 110(1)) ----------

  createAct(incidentId: number, initiatorUserId: number, reason: ActReason, at: Date = new Date()): Act {
    this.db
      .prepare('INSERT INTO acts (code, incident_id, initiator_user_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(newCode(), incidentId, initiatorUserId, reason, at.toISOString());
    return this.getActByIncident(incidentId)!;
  }

  getAct(id: number): Act | undefined {
    return this.db.prepare('SELECT * FROM acts WHERE id = ?').get(id) as Act | undefined;
  }

  getActByIncident(incidentId: number): Act | undefined {
    return this.db.prepare('SELECT * FROM acts WHERE incident_id = ?').get(incidentId) as Act | undefined;
  }

  getActByCode(code: string): Act | undefined {
    return this.db.prepare('SELECT * FROM acts WHERE code = ?').get(code) as Act | undefined;
  }

  setActStatus(id: number, status: ActStatus, at?: Date) {
    const col = status === 'ready' ? ', ready_at = ?' : status === 'signed' ? ', signed_at = ?' : '';
    const args: (string | number)[] = [status];
    if (col) args.push((at ?? new Date()).toISOString());
    args.push(id);
    this.db.prepare(`UPDATE acts SET status = ?${col} WHERE id = ?`).run(...args);
  }

  setActChairSigned(id: number, value: number) {
    this.db.prepare('UPDATE acts SET chair_signed = ? WHERE id = ?').run(value, id);
  }

  addSigner(actId: number, userId: number, role: ActSigner['role'], fio: string, flat: string | null, at: Date) {
    this.db
      .prepare('INSERT INTO act_signers (act_id, user_id, role, fio, flat, confirmed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(act_id, user_id) DO NOTHING')
      .run(actId, userId, role, fio, flat, at.toISOString());
  }

  /** Житель исправил свои ФИО или квартиру в акте, пока его не подписали на бумаге. */
  updateSigner(actId: number, userId: number, fio: string, flat: string | null) {
    this.db.prepare('UPDATE act_signers SET fio = ?, flat = ? WHERE act_id = ? AND user_id = ?').run(fio, flat, actId, userId);
  }

  listSigners(actId: number): ActSigner[] {
    return this.db.prepare('SELECT * FROM act_signers WHERE act_id = ? ORDER BY role DESC, id').all(actId) as ActSigner[];
  }

  // ---------- фото ----------

  addPhoto(participantId: number, kind: PhotoKind, token: string, url: string | null, at: Date) {
    this.db.prepare('INSERT INTO photos (participant_id, kind, token, url, received_at) VALUES (?, ?, ?, ?, ?)').run(participantId, kind, token, url, at.toISOString());
  }

  listPhotos(participantId: number): Photo[] {
    return this.db.prepare('SELECT * FROM photos WHERE participant_id = ? ORDER BY received_at').all(participantId) as Photo[];
  }

  // ---------- давление массой ----------

  /**
   * Сколько домов и отключений за период связаны с тем же исполнителем.
   * Учитываются только подтверждённые факты: номер АДС, письменное обращение или подписанный акт.
   */
  executorStats(key: string, since: Date): { houses: number; incidents: number } {
    const rows = this.db
      .prepare(
        `SELECT p.claim AS claim, i.id AS incident_id, i.house_id AS house_id, i.evidence AS evidence, a.status AS act_status
         FROM participants p
         JOIN incidents i ON i.id = p.incident_id
         LEFT JOIN acts a ON a.incident_id = i.id
         WHERE p.claim IS NOT NULL AND i.demo = 0 AND i.started_at >= ?`,
      )
      .all(since.toISOString()) as { claim: string; incident_id: number; house_id: number; evidence: string; act_status: string | null }[];
    const houses = new Set<number>();
    const incidents = new Set<number>();
    for (const r of rows) {
      if (r.evidence === 'self' && r.act_status !== 'signed') continue;
      let claim: Claim;
      try {
        claim = JSON.parse(r.claim);
      } catch {
        continue;
      }
      if (executorKey(claim) !== key) continue;
      houses.add(r.house_id);
      incidents.add(r.incident_id);
    }
    return { houses: houses.size, incidents: incidents.size };
  }

  // ---------- групповые чаты ----------

  upsertChat(chatId: number, title: string | null) {
    this.db.prepare('INSERT INTO chats (chat_id, title) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title').run(chatId, title);
  }

  linkChat(chatId: number, houseId: number, userId: number) {
    this.db.prepare('UPDATE chats SET house_id = ?, linked_by_user_id = ? WHERE chat_id = ?').run(houseId, userId, chatId);
  }

  removeChat(chatId: number) {
    this.db.prepare('DELETE FROM chats WHERE chat_id = ?').run(chatId);
    this.db.prepare('UPDATE users SET house_chat_id = NULL WHERE house_chat_id = ?').run(chatId);
  }

  getChat(chatId: number): { chat_id: number; title: string | null; house_id: number | null } | undefined {
    return this.db.prepare('SELECT * FROM chats WHERE chat_id = ?').get(chatId) as any;
  }

  // ---------- метрики ----------

  track(userId: number | null, name: string, data?: object) {
    this.db.prepare('INSERT INTO events (user_id, name, data) VALUES (?, ?, ?)').run(userId, name, data ? JSON.stringify(data) : null);
  }

  funnel(): Record<string, number> {
    const rows = this.db.prepare('SELECT name, COUNT(DISTINCT user_id) AS users FROM events GROUP BY name').all() as { name: string; users: number }[];
    return Object.fromEntries(rows.map((r) => [r.name, r.users]));
  }
}
