import { createHmac, timingSafeEqual } from 'node:crypto';

export type InitUser = { id: number; first_name?: string; last_name?: string; username?: string | null };
export type InitCheck =
  | { ok: true; user: InitUser; startParam: string | null; authDate: number }
  | { ok: false; reason: string };

const safeEqualHex = (a: string, b: string) => {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/**
 * Проверка WebAppData по https://dev.max.ru/docs/webapps/validation:
 * secret_key = HMAC_SHA256(key="WebAppData", data=BOT_TOKEN),
 * hash = hex(HMAC_SHA256(key=secret_key, data=отсортированные «key=value» через \n без hash)).
 */
export function validateInitData(initData: string, botToken: string, maxAgeSec: number, nowSec = Math.floor(Date.now() / 1000)): InitCheck {
  if (!initData) return { ok: false, reason: 'нет initData' };
  if (!botToken) return { ok: false, reason: 'на сервере не задан токен бота' };

  const pairs = initData.split('&').map((kv) => {
    const i = kv.indexOf('=');
    return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
  });
  const keys = pairs.map((p) => p[0]);
  if (new Set(keys).size !== keys.length) return { ok: false, reason: 'повторяющиеся параметры' };
  const hashPair = pairs.find((p) => p[0] === 'hash');
  if (!hashPair || !hashPair[1]) return { ok: false, reason: 'нет hash' };

  let decoded: [string, string][];
  try {
    decoded = pairs.filter((p) => p[0] !== 'hash').map(([k, v]) => [k, decodeURIComponent(v)] as [string, string]);
  } catch {
    return { ok: false, reason: 'битая кодировка' };
  }
  decoded.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const launchParams = decoded.map(([k, v]) => `${k}=${v}`).join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(launchParams).digest('hex');
  if (!safeEqualHex(expected, hashPair[1].toLowerCase())) return { ok: false, reason: 'подпись не совпадает' };

  const params = Object.fromEntries(decoded);
  const authDate = Number(params.auth_date);
  if (!Number.isFinite(authDate)) return { ok: false, reason: 'нет auth_date' };
  if (nowSec - authDate > maxAgeSec) return { ok: false, reason: 'данные запуска устарели, откройте приложение заново' };

  let user: InitUser;
  try {
    user = JSON.parse(params.user);
  } catch {
    return { ok: false, reason: 'нет данных пользователя' };
  }
  if (!user || typeof user.id !== 'number') return { ok: false, reason: 'нет id пользователя' };
  return { ok: true, user, startParam: params.start_param || null, authDate };
}

/** Строит подписанную initData — для тестов и демо. */
export function signInitData(params: Record<string, string>, botToken: string): string {
  const entries = Object.entries(params).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const launchParams = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(launchParams).digest('hex');
  return [...entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`), `hash=${hash}`].join('&');
}

/** Короткоживущая подписанная ссылка: WebApp.downloadFile не умеет передавать заголовки. */
export function signLink(path: string, secret: string, ttlSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const exp = nowSec + ttlSec;
  const sig = createHmac('sha256', secret).update(`${path}|${exp}`).digest('hex').slice(0, 32);
  return `${path}?exp=${exp}&sig=${sig}`;
}

export function verifyLink(path: string, exp: string | undefined, sig: string | undefined, secret: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < nowSec) return false;
  const expected = createHmac('sha256', secret).update(`${path}|${exp}`).digest('hex').slice(0, 32);
  return safeEqualHex(expected, sig);
}
