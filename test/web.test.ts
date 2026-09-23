import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { Harness } from '../src/sim/harness.ts';
import { loadConfig } from '../src/config.ts';
import { loadNorms } from '../src/calc/norms.ts';
import { createApp } from '../src/web/server.ts';
import { signInitData, validateInitData } from '../src/web/auth.ts';
import { parseReceiptQr } from '../src/receipt/qr.ts';

const TOKEN = 'test-bot-token';

function initFor(userId: number, authDate = Math.floor(Date.now() / 1000)) {
  return signInitData(
    {
      auth_date: String(authDate),
      query_id: 'q-1',
      user: JSON.stringify({ id: userId, first_name: 'Иван', last_name: '', username: null, language_code: 'ru', photo_url: null }),
      chat: JSON.stringify({ id: 1, type: 'DIALOG' }),
    },
    TOKEN,
  );
}

async function withServer(fn: (base: string, h: Harness) => Promise<void>) {
  const h = new Harness();
  const cfg = loadConfig({ MAX_BOT_TOKEN: TOKEN, PUBLIC_URL: 'https://example.test', MINIAPP_ENABLED: 'true', BOT_USERNAME: 'vernem_demo_bot' } as any);
  const app = createApp({ db: h.db, norms: loadNorms(), cfg, bot: () => h.bot, botStatus: () => 'test' });
  const server = createServer(app);
  await new Promise<void>((ok) => server.listen(0, ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base, h);
  } finally {
    server.close();
    h.close();
  }
}

async function demoCase(h: Harness, user: number) {
  await h.start(user);
  await h.press(user, 'Демо');
  await h.press(user, 'Воду дали');
  await h.press(user, 'Только что');
  await h.text(user, '1200');
  return h.db.listUserParticipants(user)[0].id;
}

test('initData: верная подпись принимается, подделка и устаревшие данные — нет', () => {
  const good = initFor(42);
  const ok = validateInitData(good, TOKEN, 3600);
  assert.ok(ok.ok && ok.user.id === 42);
  assert.equal(validateInitData(good, 'other-token', 3600).ok, false);
  assert.equal(validateInitData(good.replace('%22id%22%3A42', '%22id%22%3A43'), TOKEN, 3600).ok, false);
  assert.equal(validateInitData(initFor(42, 1_000), TOKEN, 3600).ok, false);
  assert.equal(validateInitData(`${good}&hash=abc`, TOKEN, 3600).ok, false);
});

test('initData: пример из документации MAX разбирается по тому же алгоритму', () => {
  // Строка из dev.max.ru/docs/webapps/validation, но с нашей подписью.
  const raw = 'auth_date=1771409719&chat=%7B%22id%22%3A12345%2C%22type%22%3A%22DIALOG%22%7D&ip=192.168.0.1&query_id=4c0ab423-342b-4e45-aea4-2747dbc500cd&user=%7B%22id%22%3A67890%2C%22first_name%22%3A%22Max%22%7D';
  const decoded = Object.fromEntries(raw.split('&').map((kv) => kv.split('=')).map(([k, v]) => [k, decodeURIComponent(v)]));
  const signed = signInitData(decoded, TOKEN);
  const r = validateInitData(signed, TOKEN, 10 ** 10, 1771409719 + 10);
  assert.ok(r.ok && r.user.id === 67890);
});

test('API: без подписи — 401, со своей подписью — свои случаи, чужой случай — 404', async () => {
  await withServer(async (base, h) => {
    const pid = await demoCase(h, 7);
    assert.equal((await fetch(`${base}/api/cases`)).status, 401);

    const res = await fetch(`${base}/api/cases`, { headers: { 'X-Max-Init-Data': initFor(7) } });
    assert.equal(res.status, 200);
    const { cases } = (await res.json()) as any;
    assert.equal(cases.length, 1);
    assert.equal(cases[0].months[0].percent, 9.6);
    assert.equal(cases[0].estimate, 115.2);

    const foreign = await fetch(`${base}/api/cases/${pid}`, { headers: { 'X-Max-Init-Data': initFor(8) } });
    assert.equal(foreign.status, 404);
  });
});

test('API: правка заявления, подписанная ссылка на PDF, поделиться карточкой', async () => {
  await withServer(async (base, h) => {
    const pid = await demoCase(h, 7);
    const headers = { 'X-Max-Init-Data': initFor(7), 'Content-Type': 'application/json' };

    const bad = await fetch(`${base}/api/cases/${pid}/claim`, { method: 'PUT', headers, body: JSON.stringify({ executorInn: '12' }) });
    assert.equal(bad.status, 400);

    const put = await fetch(`${base}/api/cases/${pid}/claim`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ fio: 'Иванов Иван Иванович', flat: '42', executor: 'ООО «УК Пример»', executorInn: '7700000000', executorType: 'uk' }),
    });
    assert.equal(put.status, 200);
    const body = (await put.json()) as any;
    assert.match(body.claimText, /ООО «УК Пример»/);
    assert.match(body.claimText, /ИНН 7700000000/);

    const link = (await (await fetch(`${base}/api/cases/${pid}/pdf-link`, { method: 'POST', headers })).json()) as any;
    assert.match(link.url, /^https:\/\/example\.test\/files\/claim\/\d+\.pdf\?exp=\d+&sig=[0-9a-f]+$/);
    const local = link.url.replace('https://example.test', base);
    const pdf = await fetch(local);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await fetch(local.replace(/sig=[0-9a-f]+/, 'sig=00'))).status, 403);

    const share = (await (await fetch(`${base}/api/cases/${pid}/share`, { method: 'POST', headers })).json()) as any;
    assert.match(share.mid, /^mid\./);
    assert.match(h.last(7).buttons!.flat()[0].type === 'link' ? (h.last(7).buttons!.flat()[0] as any).url : '', /start=j_/);
  });
});

test('API: разбор QR квитанции и удаление данных', async () => {
  await withServer(async (base, h) => {
    await demoCase(h, 7);
    const headers = { 'X-Max-Init-Data': initFor(7), 'Content-Type': 'application/json' };
    const qr = 'ST00012|Name=ООО "УК Пример"|PersonalAcc=40702810000000000001|BankName=ПАО Банк|BIC=044525225|CorrespAcc=30101810400000000225|PayeeINN=7700000000|Sum=512345|PersAcc=12345678|paymPeriod=0926';
    const r = (await (await fetch(`${base}/api/receipt/parse`, { method: 'POST', headers, body: JSON.stringify({ qr }) })).json()) as any;
    assert.equal(r.info.executor, 'ООО "УК Пример"');
    assert.equal(r.info.executorInn, '7700000000');
    assert.equal(r.info.account, '12345678');
    assert.equal(r.info.totalSum, 5123.45);

    const notQr = await fetch(`${base}/api/receipt/parse`, { method: 'POST', headers, body: JSON.stringify({ qr: 'https://example.com' }) });
    assert.equal(notQr.status, 422);

    assert.equal((await fetch(`${base}/api/me`, { method: 'DELETE', headers })).status, 200);
    assert.equal(h.db.listUserParticipants(7).length, 0);
  });
});

test('API адресов: город обязателен, поиск — только внутри города', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(9), 'Content-Type': 'application/json' };
    await h.start(9);
    assert.equal((await fetch(`${base}/api/houses/search?q=Садовая 10`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/api/me/houses`, { method: 'POST', headers, body: JSON.stringify({ address: 'Садовая 10' }) })).status, 400);

    const add = await fetch(`${base}/api/me/houses`, { method: 'POST', headers, body: JSON.stringify({ address: 'Садовая 10', city: 'Казань' }) });
    const { house } = (await add.json()) as any;
    assert.equal(house.address, 'Казань, Садовая 10');
    assert.equal(house.city, 'Казань');

    const search = (city: string) =>
      fetch(`${base}/api/houses/search?q=${encodeURIComponent('садовая 10')}&city=${encodeURIComponent(city)}`, { headers }).then((r) => r.json() as any);
    assert.equal((await search('казань')).houses.length, 1);
    assert.equal((await search('Москва')).houses.length, 0);
    const me = (await fetch(`${base}/api/me`, { headers }).then((r) => r.json())) as any;
    assert.equal(me.cities[0], 'Казань', 'свой город — первым в подсказке');
  });
});

test('health и статика мини-приложения', async () => {
  await withServer(async (base) => {
    const health = (await (await fetch(`${base}/health`)).json()) as any;
    assert.equal(health.ok, true);
    assert.equal(health.version, '1.0.0');
    const page = await fetch(`${base}/app/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /max-web-app\.js/);
  });
});

test('QR: разделитель и регистр полей по ГОСТ', () => {
  const r = parseReceiptQr('ST00012#name=ТСЖ Дом#payeeinn=1234567890#persacc=A-1');
  assert.ok(r.ok && r.info.executor === 'ТСЖ Дом' && r.info.account === 'A-1');
  assert.equal(parseReceiptQr('').ok, false);
});
