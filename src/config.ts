import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isValidTimeZone } from './calc/time.ts';

const bool = (v: string | undefined, def = false) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));
const num = (v: string | undefined, def: number) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? def : Number(v));

export type AppConfig = ReturnType<typeof loadConfig>;

function partnerUrl(v: string | undefined): string | null {
  const url = v?.trim();
  if (!url) return null;
  if (!/^https:\/\//.test(url)) throw new Error('PARTNER_ORG_URL должен начинаться с https://');
  return url;
}

export function loadConfig(env = process.env) {
  const token = env.MAX_BOT_TOKEN?.trim() || '';
  const publicUrl = env.PUBLIC_URL?.trim().replace(/\/+$/, '') || null;
  const defaultTz = env.DEFAULT_TZ?.trim() || 'Europe/Moscow';
  if (!isValidTimeZone(defaultTz)) throw new Error(`DEFAULT_TZ: неизвестный часовой пояс «${defaultTz}»`);
  if (publicUrl && !publicUrl.startsWith('https://')) throw new Error('PUBLIC_URL должен начинаться с https://');

  const botMode = (env.BOT_MODE?.trim() || (publicUrl ? 'webhook' : 'polling')) as 'webhook' | 'polling';
  if (botMode !== 'webhook' && botMode !== 'polling') throw new Error('BOT_MODE: webhook или polling');
  if (botMode === 'webhook' && !publicUrl) throw new Error('BOT_MODE=webhook требует PUBLIC_URL');

  return {
    token,
    botUsername: env.BOT_USERNAME?.trim().replace(/^@/, '') || '',
    publicUrl,
    botMode,
    webhookSecret: env.WEBHOOK_SECRET?.trim() || (token ? createHash('sha256').update(`webhook:${token}`).digest('hex').slice(0, 48) : ''),
    port: num(env.PORT, 3000),
    dbPath: env.DB_PATH?.trim() || 'data/vernem.db',
    normsPath: env.NORMS_PATH?.trim() || 'norms/norms.yaml',
    defaultTz,
    demoMode: bool(env.DEMO_MODE, true),
    fastReminders: bool(env.FAST_REMINDERS, false),
    restoreCheckHours: num(env.RESTORE_CHECK_HOURS, 3),
    receiptCheckDays: num(env.RECEIPT_CHECK_DAYS, 30),
    miniAppEnabled: bool(env.MINIAPP_ENABLED, false) && !!publicUrl,
    allowDemoAuth: bool(env.ALLOW_DEMO_AUTH, false),
    initDataTtlHours: num(env.INIT_DATA_TTL_HOURS, 24),
    linkSecret: env.LINK_SECRET?.trim() || createHash('sha256').update(`links:${token || 'local'}`).digest('hex'),
    adminIds: (env.ADMIN_IDS ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    tmpDir: env.TMP_DIR?.trim() || tmpdir(),
    schedulerIntervalSec: num(env.SCHEDULER_INTERVAL_SEC, 30),
    partnerName: env.PARTNER_ORG_NAME?.trim() || null,
    partnerUrl: partnerUrl(env.PARTNER_ORG_URL),
  };
}
