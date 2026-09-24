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

test('мини-приложение: акт с соседями, подсказки из карточки дома и акта, ссылка для соседей', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(11), 'Content-Type': 'application/json' };
    await h.start(11);
    const { house } = (await (await fetch(`${base}/api/me/houses`, { method: 'POST', headers, body: JSON.stringify({ address: 'Садовая 10', city: 'Москва' }) })).json()) as any;
    await fetch(`${base}/api/houses/${house.id}/info`, { method: 'PUT', headers, body: JSON.stringify({ ukName: 'ООО «УК Садовая»', ukInn: '7700000001' }) });
    const startedAt = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const { caseId } = (await (await fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify({ service: 'cold_water_off', houseId: house.id, evidence: 'self', startedAt }) })).json()) as any;

    // Акт: ФИО обязательны, PDF по подписанной ссылке.
    assert.equal((await fetch(`${base}/api/cases/${caseId}/act`, { method: 'POST', headers, body: JSON.stringify({ fio: 'Ив' }) })).status, 400);
    const act = (await (await fetch(`${base}/api/cases/${caseId}/act`, { method: 'POST', headers, body: JSON.stringify({ fio: 'Сидорова Мария Ивановна', flat: '14' }) })).json()) as any;
    const pdf = await fetch(act.url.replace('https://example.test', base));
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

    let data = (await (await fetch(`${base}/api/cases/${caseId}`, { headers })).json()) as any;
    assert.deepEqual(data.case.act, { status: 'collecting', residents: 1, chair: false, mine: true, initiator: true });
    assert.deepEqual(data.executorHint, { name: 'ООО «УК Садовая»', type: 'uk', inn: '7700000001' });
    assert.deepEqual(data.personHint, { fio: 'Сидорова Мария Ивановна', flat: '14', account: null });

    // Отметить «подписан» может только тот, кто начал акт.
    assert.equal((await fetch(`${base}/api/cases/${caseId}/act/signed`, { method: 'POST', headers: { ...headers, 'X-Max-Init-Data': initFor(12) }, body: '{}' })).status, 404);
    assert.equal((await fetch(`${base}/api/cases/${caseId}/act/signed`, { method: 'POST', headers, body: JSON.stringify({ chair: true }) })).status, 200);
    await fetch(`${base}/api/cases/${caseId}/end`, { method: 'POST', headers, body: JSON.stringify({ endedAt: new Date().toISOString() }) });
    data = (await (await fetch(`${base}/api/cases/${caseId}`, { headers })).json()) as any;
    assert.equal(data.case.act.status, 'signed');
    assert.match(data.claimText, /подтверждено актом.*председателем совета/);

    // «Позвать соседей»: ссылка «у меня тоже» возвращается всегда — её можно переслать без MAX.
    const share = (await (await fetch(`${base}/api/cases/${caseId}/share`, { method: 'POST', headers })).json()) as any;
    assert.match(share.link, /^https:\/\/max\.ru\/vernem_demo_bot\?start=j_/);
    assert.ok(share.text.includes(share.link));
    assert.doesNotMatch(share.text, /\*\*/);
  });
});

test('проверка ввода: все ошибки формы сразу и с привязкой к полям', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(21), 'Content-Type': 'application/json' };
    await h.start(21);
    // Мусор в подъезде не попадёт в акт.
    const badEntrance = await fetch(`${base}/api/me/houses`, { method: 'POST', headers, body: JSON.stringify({ address: 'Ленина 1', city: 'Москва', entrance: 'абв' }) });
    assert.equal(badEntrance.status, 400);
    assert.ok(((await badEntrance.json()) as any).fields.entrance);
    const { house, already } = (await (await fetch(`${base}/api/me/houses`, { method: 'POST', headers, body: JSON.stringify({ address: 'Ленина 1', city: 'Москва', entrance: '2а' }) })).json()) as any;
    assert.equal(house.entrance, '2А');
    assert.equal(already, false);
    const again = (await (await fetch(`${base}/api/me/houses`, { method: 'POST', headers, body: JSON.stringify({ houseId: house.id }) })).json()) as any;
    assert.equal(again.already, true);
    const search = (await (await fetch(`${base}/api/houses/search?q=${encodeURIComponent('ленина 1')}&city=Москва`, { headers })).json()) as any;
    assert.equal(search.exactId, house.id, 'точное совпадение — «добавить новый» не предлагаем');

    // Телефон со словами ломает «позвонить» у всех соседей — не сохраняем. Ошибки — все сразу.
    const info = await fetch(`${base}/api/houses/${house.id}/info`, { method: 'PUT', headers, body: JSON.stringify({ adsPhone: 'звоните', ukInn: 'абв123', ukEmail: 'почта' }) });
    assert.equal(info.status, 400);
    assert.deepEqual(Object.keys(((await info.json()) as any).fields).sort(), ['adsPhone', 'ukEmail', 'ukInn']);
    assert.equal((await fetch(`${base}/api/houses/${house.id}/info`, { method: 'PUT', headers, body: JSON.stringify({ adsPhone: '+7 (495) 123-45-67' }) })).status, 200);
  });
});

test('дело в мини-приложении: повтор, правка времени, «ещё не починили», квитанция, эскалация, удаление', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(22), 'Content-Type': 'application/json' };
    await h.start(22);
    const { house } = (await (await fetch(`${base}/api/me/houses`, { method: 'POST', headers, body: JSON.stringify({ address: 'Мира 3', city: 'Москва' }) })).json()) as any;
    const report = (body: object) => fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify({ service: 'hot_water_off', houseId: house.id, ...body }) }).then((r) => r.json() as any);
    const startedAt = new Date(Date.now() - 50 * 3_600_000).toISOString();
    const first = await report({ evidence: 'self', startedAt });
    assert.equal(first.outcome, 'new');

    // Повторное сообщение с номером: не теряется, а становится доказательством.
    const second = await report({ evidence: 'ads', number: '777', startedAt });
    assert.equal(second.outcome, 'existing');
    assert.equal(second.caseId, first.caseId);
    assert.equal(second.numberSaved, true);
    let data = (await (await fetch(`${base}/api/cases/${first.caseId}`, { headers })).json()) as any;
    assert.equal(data.case.adsNumber, '777');
    assert.equal(data.case.evidence, 'ads');

    const end = () => fetch(`${base}/api/cases/${first.caseId}/end`, { method: 'POST', headers, body: JSON.stringify({ endedAt: new Date().toISOString() }) });
    assert.equal((await end()).status, 200);
    // «Ещё не починили» — вернуть в отслеживание, затем снова «починили».
    assert.equal((await fetch(`${base}/api/cases/${first.caseId}/reopen`, { method: 'POST', headers })).status, 200);
    data = (await (await fetch(`${base}/api/cases/${first.caseId}`, { headers })).json()) as any;
    assert.equal(data.case.status, 'tracking');
    assert.equal((await end()).status, 200);

    // Исправить время: окончание раньше начала — ошибка у поля, короткий перерыв — дело закрывается.
    const bad = await fetch(`${base}/api/cases/${first.caseId}/times`, { method: 'PATCH', headers, body: JSON.stringify({ endedAt: new Date(Date.now() - 60 * 3_600_000).toISOString() }) });
    assert.equal(bad.status, 422);
    assert.ok(((await bad.json()) as any).fields.editEnd);
    const short = (await (await fetch(`${base}/api/cases/${first.caseId}/times`, { method: 'PATCH', headers, body: JSON.stringify({ startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }) })).json()) as any;
    assert.equal(short.case.status, 'closed');
    const long = (await (await fetch(`${base}/api/cases/${first.caseId}/times`, { method: 'PATCH', headers, body: JSON.stringify({ startedAt }) })).json()) as any;
    assert.equal(long.case.status, 'ended');

    // Заявление → «не сделали» → документы эскалации → «всё-таки вернули».
    await fetch(`${base}/api/cases/${first.caseId}/claim`, { method: 'PUT', headers, body: JSON.stringify({ fio: 'Петров Пётр', remember: true, bills: { [data.case.months[0].month]: '1000' } }) });
    assert.equal(h.db.getUser(22)!.fio, 'Петров Пётр', '«запомнить мои данные»');
    await fetch(`${base}/api/cases/${first.caseId}/pdf-link`, { method: 'POST', headers });
    assert.equal((await fetch(`${base}/api/cases/${first.caseId}/receipt`, { method: 'POST', headers, body: JSON.stringify({ refunded: false }) })).status, 200);
    const esc = (await (await fetch(`${base}/api/cases/${first.caseId}/escalation-link`, { method: 'POST', headers, body: JSON.stringify({ kind: 'fine' }) })).json()) as any;
    const pdf = await fetch(esc.url.replace('https://example.test', base));
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    const bad2 = await fetch(`${base}/api/cases/${first.caseId}/receipt`, { method: 'POST', headers, body: JSON.stringify({ refunded: true, amount: 'много' }) });
    assert.ok(((await bad2.json()) as any).fields.refundAmount);
    const refunded = (await (await fetch(`${base}/api/cases/${first.caseId}/receipt`, { method: 'POST', headers, body: JSON.stringify({ refunded: true, amount: '50,5' }) })).json()) as any;
    assert.equal(refunded.case.status, 'refunded');
    assert.equal(refunded.case.refundAmount, 50.5);
    assert.equal((await fetch(`${base}/api/cases/${first.caseId}`, { method: 'DELETE', headers })).status, 422, 'полученный перерасчёт не удаляем');

    // Дело по ошибке — удаляется. Замер температуры — отдельным запросом.
    const cold = (await (await fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify({ service: 'heating_temp', houseId: house.id, evidence: 'self', temp: '15' }) })).json()) as any;
    assert.equal((await fetch(`${base}/api/cases/${cold.caseId}/readings`, { method: 'POST', headers, body: JSON.stringify({ temp: 'холодно' }) })).status, 400);
    const withReading = (await (await fetch(`${base}/api/cases/${cold.caseId}/readings`, { method: 'POST', headers, body: JSON.stringify({ temp: '14,5' }) })).json()) as any;
    assert.equal(withReading.case.readings.length, 2);
    assert.equal(withReading.case.statusTitle, 'Слежу за температурой');
    assert.equal((await fetch(`${base}/api/cases/${cold.caseId}`, { method: 'DELETE', headers })).status, 200);
    assert.equal(h.db.getParticipant(cold.caseId), undefined);
  });
});

test('health и статика мини-приложения', async () => {
  await withServer(async (base) => {
    const health = (await (await fetch(`${base}/health`)).json()) as any;
    assert.equal(health.ok, true);
    assert.equal(health.version, '1.0.2');
    const page = await fetch(`${base}/app/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /max-web-app\.js/);
    // Хеш версии в ссылках на скрипт и стили: после обновления телефон не покажет старый интерфейс.
    assert.match(html, /src="app\.js\?v=[0-9a-f]{10}"/);
    assert.match(html, /href="app\.css\?v=[0-9a-f]{10}"/);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
  });
});

test('QR: разделитель и регистр полей по ГОСТ', () => {
  const r = parseReceiptQr('ST00012#name=ТСЖ Дом#payeeinn=1234567890#persacc=A-1');
  assert.ok(r.ok && r.info.executor === 'ТСЖ Дом' && r.info.account === 'A-1');
  assert.equal(parseReceiptQr('').ok, false);
});
