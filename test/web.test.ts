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
  await h.press(user, 'Есть номер заявки');
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
      body: JSON.stringify({ fio: 'Иванов Иван Иванович', flat: '42', executor: 'ООО «УК Пример»', executorInn: '7700000009', executorType: 'uk' }),
    });
    assert.equal(put.status, 200);
    const body = (await put.json()) as any;
    assert.match(body.claimText, /ООО «УК Пример»/);
    assert.match(body.claimText, /ИНН 7700000009/);

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
    await fetch(`${base}/api/houses/${house.id}/info`, { method: 'PUT', headers, body: JSON.stringify({ ukName: 'ООО «УК Садовая»', ukInn: '7700000009' }) });
    const startedAt = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const { caseId } = (await (await fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify({ service: 'cold_water_off', houseId: house.id, evidence: 'self', startedAt }) })).json()) as any;

    // Акт: ФИО обязательны, PDF по подписанной ссылке.
    assert.equal((await fetch(`${base}/api/cases/${caseId}/act`, { method: 'POST', headers, body: JSON.stringify({ fio: 'Ив' }) })).status, 400);
    const act = (await (await fetch(`${base}/api/cases/${caseId}/act`, { method: 'POST', headers, body: JSON.stringify({ fio: 'Сидорова Мария Ивановна', flat: '14' }) })).json()) as any;
    const pdf = await fetch(act.url.replace('https://example.test', base));
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

    let data = (await (await fetch(`${base}/api/cases/${caseId}`, { headers })).json()) as any;
    assert.deepEqual(data.case.act, { status: 'collecting', residents: 1, chair: false, mine: true, initiator: true, demoSigners: [] });
    assert.deepEqual(data.executorHint, { name: 'ООО «УК Садовая»', type: 'uk', inn: '7700000009' });
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
    // Квартира в строке поиска — не часть адреса: дом находится и его можно выбрать (раньше — тупик «Добавьте номер дома»).
    const withFlat = (await (await fetch(`${base}/api/houses/search?q=${encodeURIComponent('ленина 1 кв 20')}&city=Москва`, { headers })).json()) as any;
    assert.deepEqual(withFlat.houses.map((x: any) => x.id), [house.id]);
    assert.equal(withFlat.exactId, house.id);

    // Телефон со словами ломает «позвонить» у всех соседей — не сохраняем. Ошибки — все сразу.
    const info = await fetch(`${base}/api/houses/${house.id}/info`, { method: 'PUT', headers, body: JSON.stringify({ adsPhone: 'звоните', ukInn: 'абв123', ukEmail: 'почта' }) });
    assert.equal(info.status, 400);
    assert.deepEqual(Object.keys(((await info.json()) as any).fields).sort(), ['adsPhone', 'ukEmail', 'ukInn']);
    assert.equal((await fetch(`${base}/api/houses/${house.id}/info`, { method: 'PUT', headers, body: JSON.stringify({ adsPhone: '+7 (495) 123-45-67' }) })).status, 200);
    // Опечатка в ИНН не стирает остальное: верные поля сохраняются, поле с ошибкой остаётся прежним.
    const partial = await fetch(`${base}/api/houses/${house.id}/info`, { method: 'PUT', headers, body: JSON.stringify({ adsPhone: '+7 495 000-11-22', ukName: 'ООО «УК Мира»', ukInn: '7700000001' }) });
    assert.equal(partial.status, 400);
    assert.deepEqual(Object.keys(((await partial.json()) as any).fields), ['ukInn']);
    const saved = h.db.houseInfo(h.db.getHouse(house.id)!);
    assert.equal(saved.adsPhone, '+7 495 000-11-22');
    assert.equal(saved.ukName, 'ООО «УК Мира»');
    assert.equal(saved.ukInn, undefined);
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
    // Время начала — прежнее (не время звонка): в заявлении номер без выдуманного времени регистрации.
    assert.equal(data.case.startEvidence, 'self');
    assert.equal(data.case.startedAt, startedAt);

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
    // «Не сделали» — только когда пришла квитанция за следующий месяц: в день подачи это неправда.
    const early = await fetch(`${base}/api/cases/${first.caseId}/receipt`, { method: 'POST', headers, body: JSON.stringify({ refunded: false }) });
    assert.equal(early.status, 422);
    assert.match(((await early.json()) as any).error, /Перерасчёт появится в квитанции/);
    assert.equal((await fetch(`${base}/api/cases/${first.caseId}/escalation-link`, { method: 'POST', headers, body: JSON.stringify({ kind: 'fine' }) })).status, 409);
    // Прошло полтора месяца: заявление подано, квитанция пришла.
    const p = h.db.getParticipant(first.caseId)!;
    const monthAgo = new Date(Date.now() - 45 * 24 * 3_600_000).toISOString();
    h.db.updateParticipant(p.id, { claim: JSON.stringify({ ...JSON.parse(p.claim!), createdAt: monthAgo, submittedAt: monthAgo, incomingNumber: '123' }) });
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
    const undo = (await (await fetch(`${base}/api/cases/${first.caseId}/receipt`, { method: 'POST', headers, body: JSON.stringify({ action: 'undo' }) })).json()) as any;
    assert.equal(undo.case.status, 'claim_ready', 'отметку «вернули» можно снять');

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

test('строгая проверка: документы не противоречат друг другу, данные — по адресу, город с опечаткой', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(31), 'Content-Type': 'application/json' };
    await h.start(31);
    const add = (body: object) => fetch(`${base}/api/me/houses`, { method: 'POST', headers, body: JSON.stringify(body) }).then((r) => r.json() as any);

    // Город: сокращение и опечатка узнаются, огрызок «Сам» — не город.
    const check = (q: string) => fetch(`${base}/api/cities/check?q=${encodeURIComponent(q)}`, { headers }).then((r) => r.json() as any);
    assert.equal((await check('Питер')).name, 'Санкт-Петербург');
    assert.equal((await check('Масква')).suggestion, 'Москва');
    assert.equal((await check('Сам')).name, null);
    // Короткие настоящие города — из справочника; «ё» в новом городе не теряется.
    assert.deepEqual([(await check('Обь')).name, (await check('Обь')).inList], ['Обь', true]);
    assert.equal((await check('г. Королёв')).name, 'Королёв');

    // Квартира в строке адреса — не отдельный дом; улица с заглавной буквы.
    const a = await add({ address: 'тверская д. 7 кв 15', city: 'Москва' });
    assert.equal(a.house.address, 'Москва, Тверская д. 7');
    assert.equal(a.house.flat, '15');
    const same = await add({ address: 'Тверская 7', city: 'Москва' });
    assert.equal(same.house.id, a.house.id);
    assert.equal(same.already, true);
    const b = await add({ address: 'ленина 5', city: 'Кинешма', flat: '42' });
    assert.equal(b.house.address, 'Кинешма, Ленина 5');

    // Квартира и лицевой счёт — у каждого адреса свои: чужая квартира не попадёт в заявление.
    h.db.savePerson(31, a.house.id, { fio: 'Петрова Мария Сергеевна', flat: '15', account: '111' });
    assert.deepEqual(h.db.personFor(31, b.house.id), { fio: 'Петрова Мария Сергеевна', flat: '42', account: null });
    assert.deepEqual(h.db.personFor(31, a.house.id), { fio: 'Петрова Мария Сергеевна', flat: '15', account: '111' });

    // «Еле тёплая» поверх открытого «нет горячей воды» — не заводим.
    const startedAt = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const hw = (await (await fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify({ service: 'hot_water_off', houseId: a.house.id, evidence: 'self', startedAt }) })).json()) as any;
    const warm = await fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify({ service: 'hot_water_temp', houseId: a.house.id, evidence: 'self', temp: '40' }) });
    assert.equal(warm.status, 422);
    assert.match(((await warm.json()) as any).error, /уже открыто/);

    // Акт: дата составления фиксирована, время отключения меняется вместе с временем первого жителя.
    await fetch(`${base}/api/cases/${hw.caseId}/act`, { method: 'POST', headers, body: JSON.stringify({ fio: 'Петрова Мария Сергеевна', flat: '15' }) });
    const newStart = new Date(Date.now() - 40 * 3_600_000).toISOString();
    assert.equal((await fetch(`${base}/api/cases/${hw.caseId}/times`, { method: 'PATCH', headers, body: JSON.stringify({ startedAt: newStart }) })).status, 200);
    const inc = h.db.getIncident(h.db.getParticipant(hw.caseId)!.incident_id)!;
    assert.equal(inc.started_at, newStart, 'время в акте = время в заявлении');
    const act = h.db.getActByIncident(inc.id)!;
    // Подписанный акт: время начала без снятия отметки не меняется.
    await fetch(`${base}/api/cases/${hw.caseId}/act/signed`, { method: 'POST', headers, body: JSON.stringify({ chair: false }) });
    const locked = await fetch(`${base}/api/cases/${hw.caseId}/times`, { method: 'PATCH', headers, body: JSON.stringify({ startedAt }) });
    assert.equal(locked.status, 422);
    assert.match(((await locked.json()) as any).error, /Акт уже подписан/);
    assert.equal(h.db.getAct(act.id)!.created_at, act.created_at);

    // Замер: норма — подсказка; ошибочный замер удаляется.
    const cold = (await (await fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify({ service: 'heating_temp', houseId: b.house.id, evidence: 'self', temp: '15' }) })).json()) as any;
    assert.equal((await fetch(`${base}/api/cases/${cold.caseId}/readings`, { method: 'POST', headers, body: JSON.stringify({ temp: '150' }) })).status, 400);
    const warmReading = (await (await fetch(`${base}/api/cases/${cold.caseId}/readings`, { method: 'POST', headers, body: JSON.stringify({ temp: '22' }) })).json()) as any;
    assert.match(warmReading.note, /это уже норма/);
    const rid = warmReading.case.readings.at(-1).id;
    const afterDel = (await (await fetch(`${base}/api/cases/${cold.caseId}/readings/${rid}`, { method: 'DELETE', headers })).json()) as any;
    assert.equal(afterDel.case.readings.length, 1);
  });
});

test('третий строгий отчёт: даты документов, устаревшее заявление, лифт на весь дом, проверки ввода', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(41), 'Content-Type': 'application/json' };
    await h.start(41);
    const post = (url: string, body: object = {}) => fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const { house } = (await (await post('/api/me/houses', { address: 'Мира 1', city: 'Москва', flat: '7' })).json()) as any;
    const report = (body: object) => post('/api/report', { houseId: house.id, ...body }).then((r) => r.json() as any);
    const hours = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

    // Свет: ответ про лифт — один на дом; второе дело с другим ответом меняет расчёт обоих.
    const light1 = await report({ service: 'electricity_off', evidence: 'self', startedAt: hours(40), variant: 'one_source' });
    await post(`/api/cases/${light1.caseId}/end`, { endedAt: hours(30) });
    const light2 = await report({ service: 'electricity_off', evidence: 'self', startedAt: hours(20), variant: 'two_sources' });
    await post(`/api/cases/${light2.caseId}/end`, { endedAt: hours(15) });
    const case1 = ((await (await fetch(`${base}/api/cases/${light1.caseId}`, { headers })).json()) as any).case;
    assert.match(case1.months[0].lines.join(' '), /Допустимо: 2 ч в месяц/, 'первое дело пересчитано по ответу «есть лифт»');
    assert.equal(case1.status, 'ended', 'закрытое «без денег» дело получило деньги и открылось для заявления');

    // Скачали заявление, потом исправили время — заявление устарело; новая выдача — новая дата, подача сбрасывается.
    await fetch(`${base}/api/cases/${light1.caseId}/claim`, { method: 'PUT', headers, body: JSON.stringify({ fio: 'Орлова Анна Петровна' }) });
    await post(`/api/cases/${light1.caseId}/pdf-link`);
    const p0 = h.db.getParticipant(light1.caseId)!;
    const monthAgo = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
    h.db.updateParticipant(p0.id, { claim: JSON.stringify({ ...JSON.parse(p0.claim!), createdAt: monthAgo, submittedAt: monthAgo }) });
    // Дата подачи раньше даты заявления — ошибка.
    const early = await post(`/api/cases/${light1.caseId}/submitted`, { date: new Date(Date.now() - 45 * 24 * 3_600_000).toISOString().slice(0, 10) });
    assert.ok([400].includes(early.status));
    const patched = await fetch(`${base}/api/cases/${light1.caseId}/times`, { method: 'PATCH', headers, body: JSON.stringify({ startedAt: hours(38) }) });
    assert.equal(patched.status, 200, await patched.clone().text());
    let data = (await (await fetch(`${base}/api/cases/${light1.caseId}`, { headers })).json()) as any;
    assert.equal(data.case.claimOutdated, true);
    await post(`/api/cases/${light1.caseId}/pdf-link`);
    data = (await (await fetch(`${base}/api/cases/${light1.caseId}`, { headers })).json()) as any;
    assert.equal(data.case.claimOutdated, false);
    assert.ok(new Date(data.case.claim.createdAt).getTime() > Date.now() - 60_000, 'новое заявление — новая дата');
    assert.equal(data.case.claim.submittedAt, undefined, 'прежняя отметка о подаче к новому заявлению не относится');

    // Документ эскалации датирован сегодняшним днём, а не днём заявления.
    const p1 = h.db.getParticipant(light1.caseId)!;
    h.db.updateParticipant(p1.id, { status: 'refused', claim: JSON.stringify({ ...JSON.parse(p1.claim!), createdAt: monthAgo }) });
    const { buildEscalation } = await import('../src/docs/escalation.ts');
    const { claimInputFor, loadCase } = await import('../src/services/cases.ts');
    const doc = buildEscalation('fine', claimInputFor(h.db, h.bot.norms, loadCase(h.db, p1.id)!, new Date()), { refund: null });
    const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
    assert.ok(doc.signature.includes(today), doc.signature);

    // Пересечение с закрытым делом по связанной услуге — одни и те же часы не оплачиваем дважды.
    const hw = await report({ service: 'hot_water_off', evidence: 'self', startedAt: hours(10) });
    await post(`/api/cases/${hw.caseId}/end`, { endedAt: hours(5) });
    const warm = await post('/api/report', { houseId: house.id, service: 'hot_water_temp', evidence: 'self', startedAt: hours(8), temp: '40' });
    assert.equal(warm.status, 422);
    assert.match(((await warm.json()) as any).error, /Одни и те же часы нельзя оплатить дважды/);
    // Вода −5 °C — ошибка у поля.
    assert.equal((await post('/api/report', { houseId: house.id, service: 'hot_water_temp', evidence: 'self', startedAt: hours(3), temp: '-5' })).status, 400);

    // Замер раньше нового начала — исправить время нельзя, пока его не удалить.
    const cold = await report({ service: 'heating_temp', evidence: 'self', startedAt: hours(10), temp: '15' });
    const moved = await fetch(`${base}/api/cases/${cold.caseId}/times`, { method: 'PATCH', headers, body: JSON.stringify({ startedAt: hours(5) }) });
    assert.equal(moved.status, 422);
    assert.match(((await moved.json()) as any).error, /Есть замер раньше нового начала/);

    // Проверки ввода в заявлении: ИНН с ошибкой в контрольной цифре, «Я» вместо ФИО, сумма «1.250,50», огромная сумма.
    const bad = await fetch(`${base}/api/cases/${hw.caseId}/claim`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ executorInn: '7700000001', fio: 'Я', bills: { [new Date().toISOString().slice(0, 7)]: '999999999' } }),
    });
    const badBody = (await bad.json()) as any;
    assert.equal(bad.status, 400);
    assert.ok(badBody.fields.inn && badBody.fields.fio && Object.keys(badBody.fields).some((k: string) => k.startsWith('bill_')), JSON.stringify(badBody));
    const month = new Date().toISOString().slice(0, 7);
    await fetch(`${base}/api/cases/${hw.caseId}/claim`, { method: 'PUT', headers, body: JSON.stringify({ bills: { [month]: '1.250,50' } }) });
    const withBill = (await (await fetch(`${base}/api/cases/${hw.caseId}`, { headers })).json()) as any;
    assert.equal(withBill.case.months.find((m: any) => m.month === month).bill, 1250.5);

    // «Не запоминать» — забываем ФИО, но квартира остаётся в карточке адреса.
    await fetch(`${base}/api/cases/${hw.caseId}/claim`, { method: 'PUT', headers, body: JSON.stringify({ remember: false }) });
    assert.equal(h.db.getUserHouse(41, house.id)!.flat, '7');
    const hint = (await (await fetch(`${base}/api/cases/${hw.caseId}`, { headers })).json()) as any;
    assert.equal(hint.personHint.flat, '7', 'квартира из адреса попадает в заявление нового жителя');
  });
});

test('вторая квартира в доме и рубли за часы «по тарифу холодной воды»', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(51), 'Content-Type': 'application/json' };
    await h.start(51);
    const post = (url: string, body: object = {}) => fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const put = (url: string, body: object) => fetch(`${base}${url}`, { method: 'PUT', headers, body: JSON.stringify(body) });
    const { house } = (await (await post('/api/me/houses', { address: 'Садовая 1', city: 'Москва', flat: '5' })).json()) as any;

    // Горячая вода +30 °C 20 часов: за эти часы — оплата по тарифу холодной воды.
    const start = new Date(Date.now() - 22 * 3_600_000);
    const warm = (await (await post('/api/report', { houseId: house.id, service: 'hot_water_temp', evidence: 'self', startedAt: start.toISOString(), temp: '30' })).json()) as any;
    await post(`/api/cases/${warm.caseId}/end`, { endedAt: new Date(start.getTime() + 20 * 3_600_000).toISOString() });
    const month = new Date(start).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }).slice(0, 7);
    const bad = await put(`/api/cases/${warm.caseId}/claim`, { coldTariff: { [month]: { volume: '3,5', hot: '50', cold: '60' } } });
    assert.equal(bad.status, 400, 'холодная дороже горячей — ошибка у поля');
    await put(`/api/cases/${warm.caseId}/claim`, { coldTariff: { [month]: { volume: '3,5', hot: '250', cold: '55' } } });
    const data = (await (await fetch(`${base}/api/cases/${warm.caseId}`, { headers })).json()) as any;
    const [y, m] = month.split('-').map(Number);
    const monthHours = new Date(y, m, 0).getDate() * 24;
    const expected = Math.floor(3.5 * (20 / monthHours) * (250 - 55) * 100) / 100;
    assert.ok(Math.abs(data.case.estimate - expected) < 0.02, `${data.case.estimate} ≈ ${expected}`);
    assert.match(data.claimText, /по тарифу за холодную воду \(ориентировочно/);

    // Вторая квартира: своё заявление со своей квартирой, счётом и платой.
    const cw = (await (await post('/api/report', { houseId: house.id, service: 'cold_water_off', evidence: 'ads', number: 'Х-9', startedAt: new Date(Date.now() - 30 * 3_600_000).toISOString() })).json()) as any;
    await post(`/api/cases/${cw.caseId}/end`, { endedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    const cwMonth = new Date(Date.now() - 2 * 3_600_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }).slice(0, 7);
    const same = await put(`/api/cases/${cw.caseId}/extra-flats`, { flats: [{ flat: '5', bills: {} }] });
    assert.equal(same.status, 400, 'основная квартира не может быть «ещё одной»');
    const ok = (await (await put(`/api/cases/${cw.caseId}/extra-flats`, { flats: [{ flat: '12', account: '999', bills: { [cwMonth]: '500' } }] })).json()) as any;
    assert.equal(ok.case.extraFlats[0].flat, '12');
    assert.ok(ok.case.extraFlats[0].estimate > 0);
    const link = (await (await post(`/api/cases/${cw.caseId}/pdf-link`, { extra: 0 })).json()) as any;
    assert.match(link.fileName, /^Заявление_кв12_/);
    const pdf = await fetch(link.url.replace('https://example.test', base));
    assert.equal(pdf.status, 200);
    const { claimTextFor, loadCase } = await import('../src/services/cases.ts');
    const { claimDocFor } = await import('../src/services/cases.ts');
    const { claimToText } = await import('../src/docs/claim.ts');
    const text = claimToText(claimDocFor(h.db, h.bot.norms, loadCase(h.db, cw.caseId)!, new Date(), 0));
    assert.match(text, /кв\. 12/);
    assert.match(text, /л\/с \(код плательщика\): 999/);
    assert.doesNotMatch(claimTextFor(h.db, h.bot.norms, loadCase(h.db, cw.caseId)!, new Date()), /кв\. 12/, 'основное заявление — на свою квартиру');
  });
});

test('отопление летом не считается', async () => {
  const h = new Harness();
  const house = h.db.upsertHouse('Лесная 3', 'Europe/Moscow', 0, 'Москва');
  const inc = h.db.createIncident({ house_id: house.id, service_key: 'heating_temp', reporter_user_id: 1, started_at: '2026-07-10T09:00:00Z', ads_number: null, evidence: 'self', variant: null, demo: 0 });
  const p = h.db.addParticipant({ incident_id: inc.id, user_id: 1, role: 'reporter', started_at: '2026-07-10T09:00:00Z' });
  h.db.addReading(p.id, '2026-07-10T09:00:00Z', 15);
  h.db.updateParticipant(p.id, { ended_at: '2026-09-02T09:00:00Z', status: 'ended' });
  const { calcFor, loadCase } = await import('../src/services/cases.ts');
  const months = calcFor(h.db, h.bot.norms, loadCase(h.db, p.id)!, new Date('2026-09-03T00:00:00Z')).months;
  assert.deepEqual(months.filter((m) => m.month < '2026-09').map((m) => m.percent), [0, 0]);
  assert.ok(months.find((m) => m.month === '2026-09')!.percent > 0);
  h.close();
});

test('повторное сообщение: замер не теряется, номер — без выдуманного времени, закрытое дело объясняет почему', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(61), 'Content-Type': 'application/json' };
    await h.start(61);
    const { house } = (await (await fetch(`${base}/api/me/houses`, { method: 'POST', headers, body: JSON.stringify({ address: 'Лесная 7', city: 'Москва' }) })).json()) as any;
    const report = (body: object) => fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify({ houseId: house.id, ...body }) }).then((r) => r.json() as any);
    const yesterday = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const first = await report({ service: 'heating_temp', evidence: 'self', startedAt: yesterday, temp: '16' });
    const again = await report({ service: 'heating_temp', evidence: 'ads', number: 'Б-55', startedAt: new Date().toISOString(), temp: '17' });
    assert.equal(again.outcome, 'existing');
    assert.equal(again.readingSaved, true);
    assert.equal(again.since, yesterday);
    const data = (await (await fetch(`${base}/api/cases/${first.caseId}`, { headers })).json()) as any;
    assert.deepEqual(data.case.readings.map((r: any) => r.tempC), [16, 17]);
    await fetch(`${base}/api/cases/${first.caseId}/end`, { method: 'POST', headers, body: JSON.stringify({}) });
    const put = (await (await fetch(`${base}/api/cases/${first.caseId}/claim`, { method: 'PUT', headers, body: JSON.stringify({ fio: 'Лесная Анна Петровна' }) })).json()) as any;
    assert.match(put.claimText, /сообщение зарегистрировано под № Б-55 \(п\. 105–106 Правил\)/);
    assert.doesNotMatch(put.claimText, /С этого времени исчисляется период нарушения/);

    // Короткое отключение: статус объясняет, почему денег нет.
    const short = await report({ service: 'cold_water_off', evidence: 'ads', number: '1', startedAt: new Date(Date.now() - 3_600_000).toISOString() });
    const ended = (await (await fetch(`${base}/api/cases/${short.caseId}/end`, { method: 'POST', headers, body: JSON.stringify({}) })).json()) as any;
    assert.equal(ended.case.status, 'closed');
    assert.equal(ended.case.statusTitle, 'Денег не положено — отключение было коротким');
  });
});

test('кто принял заявку — в заявлении; после подачи статус «ждём квитанцию»; подать завтрашним днём нельзя', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(51), 'Content-Type': 'application/json' };
    const pid = await demoCase(h, 51);
    const r = (await (await fetch(`${base}/api/cases/${pid}/claim`, { method: 'PUT', headers, body: JSON.stringify({ fio: 'Орлова Анна Петровна', adsOperator: 'Смирнова О. П.' }) })).json()) as any;
    assert.equal(r.case.ownNumber, true);
    assert.match(r.claimText, /время регистрации — [\d.]+ [\d:]+, сообщение принял\(а\) Смирнова О\. П\. \(п\. 106 Правил\)/);
    await fetch(`${base}/api/cases/${pid}/pdf-link`, { method: 'POST', headers });
    const day = (shift: number) => new Date(Date.now() + shift).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
    const bad = await fetch(`${base}/api/cases/${pid}/submitted`, { method: 'POST', headers, body: JSON.stringify({ date: day(24 * 3_600_000) }) });
    assert.equal(bad.status, 400, 'завтрашняя дата подачи — ошибка');
    // Приложение шлёт «сегодня, 12:00» — до полудня это не «будущее»: сравниваем по дню.
    const ok = (await (await fetch(`${base}/api/cases/${pid}/submitted`, { method: 'POST', headers, body: JSON.stringify({ date: `${day(0)}T12:00:00` }) })).json()) as any;
    assert.match(ok.case.statusTitle, /^Подано — ждём квитанцию за [а-я]+ \d{4}$/);
  });
});

test('исправить время: то же время без секунд — не изменение; огромная сумма — понятная ошибка', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(71), 'Content-Type': 'application/json' };
    const pid = await demoCase(h, 71);
    await fetch(`${base}/api/cases/${pid}/claim`, { method: 'PUT', headers, body: JSON.stringify({ fio: 'Орлова Анна Петровна' }) });
    await fetch(`${base}/api/cases/${pid}/pdf-link`, { method: 'POST', headers });
    const before = h.db.getParticipant(pid)!;
    // Поле времени в приложении без секунд: отправляем начало и окончание, обрезанные до минуты.
    const minute = (iso: string) => new Date(Math.floor(new Date(iso).getTime() / 60_000) * 60_000).toISOString();
    const r = await fetch(`${base}/api/cases/${pid}/times`, { method: 'PATCH', headers, body: JSON.stringify({ startedAt: minute(before.started_at), endedAt: minute(before.ended_at!) }) });
    assert.equal(r.status, 200);
    const data = (await r.json()) as any;
    assert.equal(data.case.claimOutdated, false, 'заявление не устарело');
    assert.equal(h.db.getParticipant(pid)!.started_at, before.started_at, 'точное время не перезаписано');

    const big = (await (await fetch(`${base}/api/cases/${pid}/claim`, { method: 'PUT', headers, body: JSON.stringify({ bills: { [data.case.months[0].month]: '99999999' } }) })).json()) as any;
    assert.match(Object.values(big.fields ?? {}).join(' '), /меньше 100 000 ₽/);

    // Сменили плату после скачивания — сумма в PDF другая: заявление устарело.
    const rebilled = (await (await fetch(`${base}/api/cases/${pid}/claim`, { method: 'PUT', headers, body: JSON.stringify({ fio: 'Орлова Анна Петровна', bills: { [data.case.months[0].month]: '2000' } }) })).json()) as any;
    assert.equal(rebilled.case.claimOutdated, true);

    // «Запомнить» с пустым ФИО в этом заявлении не стирает сохранённое для следующих.
    await fetch(`${base}/api/cases/${pid}/claim`, { method: 'PUT', headers, body: JSON.stringify({ fio: 'Орлова Анна Петровна', flat: '7', remember: true }) });
    await fetch(`${base}/api/cases/${pid}/claim`, { method: 'PUT', headers, body: JSON.stringify({ fio: '', flat: '7', remember: true }) });
    assert.equal(h.db.getUser(71)!.fio, 'Орлова Анна Петровна');

    // Номер заявки без единой буквы или цифры — не номер.
    const houseId = h.db.listUserHouses(71)[0]?.id ?? (await (await fetch(`${base}/api/me/houses`, { method: 'POST', headers, body: JSON.stringify({ address: 'Лесная 9', city: 'Москва' }) })).json() as any).house.id;
    const bad = await fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify({ houseId, service: 'cold_water_off', evidence: 'ads', number: '!!!', startedAt: new Date().toISOString() }) });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as any).fields.number, /должны быть цифры/);
  });
});

test('лифт: «не знаю» не ставит ответ всему дому, «да» и «нет» ставят; текст заявления совпадает с расчётом; огромная сумма возврата — ошибка', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(81), 'Content-Type': 'application/json' };
    await h.start(81);
    const { house } = (await (await fetch(`${base}/api/me/houses`, { method: 'POST', headers, body: JSON.stringify({ address: 'Мира 21', city: 'Москва' }) })).json()) as any;
    const report = (body: object) => fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify({ houseId: house.id, service: 'electricity_off', evidence: 'ads', number: '5', ...body }) }).then((r) => r.json() as any);
    const info = () => h.db.houseInfo(h.db.getHouse(house.id)!).twoPowerSources;
    // «Не знаю» — варианта нет: ответ за дом не записан, считаем по строгому лимиту 24 ч.
    const first = await report({ startedAt: new Date(Date.now() - 30 * 3_600_000).toISOString() });
    assert.equal(info(), undefined, '«Не знаю» — ответ за дом не записан');
    await fetch(`${base}/api/cases/${first.caseId}/end`, { method: 'POST', headers, body: JSON.stringify({ endedAt: new Date(Date.now() - 26 * 3_600_000).toISOString() }) });
    await report({ variant: 'two_sources', startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    assert.equal(info(), true, '«Да» — записан');
    // Текст заявления и расчёт — по одному ответу (карточка дома), даже если дело открывали с «Не знаю».
    const put1 = (await (await fetch(`${base}/api/cases/${first.caseId}/claim`, { method: 'PUT', headers, body: JSON.stringify({ fio: 'Мирова Анна Петровна' }) })).json()) as any;
    assert.match(put1.claimText, /составляет 2 ч суммарно в течение месяца/);
    assert.match(put1.case.months[0].lines.join(' '), /Допустимо: 2 ч в месяц/);
    // «Нет» из формы — тоже ответ за дом.
    const { house: other } = (await (await fetch(`${base}/api/me/houses`, { method: 'POST', headers, body: JSON.stringify({ address: 'Мира 23', city: 'Москва' }) })).json()) as any;
    await fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify({ houseId: other.id, service: 'electricity_off', evidence: 'ads', number: '6', variant: 'one_source', startedAt: new Date(Date.now() - 3_600_000).toISOString() }) });
    assert.equal(h.db.houseInfo(h.db.getHouse(other.id)!).twoPowerSources, false, '«Нет» — записан');

    // Сумма возврата больше 100 000 ₽ по одной услуге — почти наверняка опечатка.
    await fetch(`${base}/api/cases/${first.caseId}/claim`, { method: 'PUT', headers, body: JSON.stringify({ fio: 'Мирова Анна Петровна', bills: { [new Date(Date.now() - 30 * 3_600_000).toISOString().slice(0, 7)]: '900' } }) });
    await fetch(`${base}/api/cases/${first.caseId}/pdf-link`, { method: 'POST', headers });
    for (const amount of ['115200', '2000000']) {
      const r = await fetch(`${base}/api/cases/${first.caseId}/receipt`, { method: 'POST', headers, body: JSON.stringify({ action: 'yes', amount }) });
      assert.equal(r.status, 400, amount);
      assert.match(((await r.json()) as any).fields.refundAmount, /меньше 100 000 ₽/);
    }
  });
});

test('сменили получателя после скачивания — заявление устарело; «не назвали» — не номер заявки', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(91), 'Content-Type': 'application/json' };
    const pid = await demoCase(h, 91);
    const put = (body: object) => fetch(`${base}/api/cases/${pid}/claim`, { method: 'PUT', headers, body: JSON.stringify(body) }).then((r) => r.json() as any);
    const uk = { fio: 'Орлова Анна Петровна', executor: 'ООО «УК Пример»', executorType: 'uk', executorInn: '7700000009' };
    await put(uk);
    await fetch(`${base}/api/cases/${pid}/pdf-link`, { method: 'POST', headers });
    assert.equal((await put(uk)).case.claimOutdated, false, 'те же данные — заявление не устарело');
    // В скачанном PDF — УК; сменили получателя (ИНН прежнего приложение очищает) — PDF надо скачать заново.
    const other = await put({ ...uk, executor: 'АО «Газпром межрегионгаз»', executorType: 'rso', executorInn: '' });
    assert.equal(other.case.claimOutdated, true, 'другой получатель — скачанное заявление устарело');
    assert.match(other.claimText, /Руководителю АО «Газпром межрегионгаз»/);
    assert.doesNotMatch(other.claimText, /ИНН 7700000009/);

    // «не назвали» в поле номера — не номер: в заявлении было бы «зарегистрировано под № не назвали».
    const { house } = (await (await fetch(`${base}/api/me/houses`, { method: 'POST', headers, body: JSON.stringify({ address: 'Лесная 11', city: 'Москва' }) })).json()) as any;
    const bad = await fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify({ houseId: house.id, service: 'cold_water_off', evidence: 'ads', number: 'не назвали', startedAt: new Date().toISOString() }) });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as any).fields.number, /выберите «Номера нет»/);
  });
});

test('подписанный акт: председатель входит в снимок заявления, окончание не противоречит акту', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(97), 'Content-Type': 'application/json' };
    await h.start(97);
    const post = (url: string, body: object = {}) => fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const get = async (id: number) => ((await (await fetch(`${base}/api/cases/${id}`, { headers })).json()) as any);
    const hours = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
    const { house } = (await (await post('/api/me/houses', { address: 'Лесная 21', city: 'Москва', flat: '3' })).json()) as any;
    const { caseId } = (await (await post('/api/report', { houseId: house.id, service: 'cold_water_off', evidence: 'self', startedAt: hours(30) })).json()) as any;

    // Акт составлен и подписан, пока воды нет: в нём «на момент составления не устранено».
    assert.equal((await post(`/api/cases/${caseId}/act`, { fio: 'Лесная Анна Петровна', flat: '3' })).status, 200);
    assert.equal((await post(`/api/cases/${caseId}/act/signed`, { chair: true })).status, 200);
    const early = await post(`/api/cases/${caseId}/end`, { endedAt: hours(2) });
    assert.equal(early.status, 422, 'окончание раньше составления подписанного акта');
    assert.match(((await early.json()) as any).error, /ещё не восстановлена/);
    assert.equal((await post(`/api/cases/${caseId}/end`, { endedAt: new Date().toISOString() })).status, 200);
    // Исправить окончание на время раньше акта — тоже нельзя.
    const moved = await fetch(`${base}/api/cases/${caseId}/times`, { method: 'PATCH', headers, body: JSON.stringify({ endedAt: hours(3) }) });
    assert.equal(moved.status, 422);
    assert.match(((await moved.json()) as any).error, /ещё не восстановлена/);

    // Заявление скачано с «…и председателем»; потом ответ про председателя поменяли — заявление устарело.
    await fetch(`${base}/api/cases/${caseId}/claim`, { method: 'PUT', headers, body: JSON.stringify({ fio: 'Лесная Анна Петровна', flat: '3' }) });
    await post(`/api/cases/${caseId}/pdf-link`);
    assert.match((await get(caseId)).claimText, /и председателем совета многоквартирного дома/);
    assert.equal((await get(caseId)).case.claimOutdated, false);
    await post(`/api/cases/${caseId}/act/unsigned`);
    await post(`/api/cases/${caseId}/act/signed`, { chair: false });
    const after = await get(caseId);
    assert.doesNotMatch(after.claimText, /и председателем/);
    assert.equal(after.case.claimOutdated, true, 'без председателя — скачанное заявление устарело');
  });
});

test('время до минуты: «ровно 4 суток» не теряют час из-за секунд в сохранённом начале', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(98), 'Content-Type': 'application/json' };
    await h.start(98);
    const post = (url: string, body: object = {}) => fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const { house } = (await (await post('/api/me/houses', { address: 'Лесная 31', city: 'Москва' })).json()) as any;
    // Начало с секундами — как «Только что» в форме; окончание из поля времени — ровно минуты, через 4 суток.
    const minute = Math.floor((Date.now() - 100 * 3_600_000) / 60_000) * 60_000;
    const startedAt = new Date(minute + 58_263).toISOString();
    const { caseId } = (await (await post('/api/report', { houseId: house.id, service: 'hot_water_off', evidence: 'ads', number: '4512', startedAt })).json()) as any;
    await post(`/api/cases/${caseId}/end`, { endedAt: new Date(minute + 90 * 3_600_000).toISOString() });
    // Исправили окончание в поле без секунд — ровно 96 ч от начала (по минутам).
    const patched = await fetch(`${base}/api/cases/${caseId}/times`, { method: 'PATCH', headers, body: JSON.stringify({ endedAt: new Date(minute + 96 * 3_600_000).toISOString() }) });
    assert.equal(patched.status, 200);
    const put = (await (await fetch(`${base}/api/cases/${caseId}/claim`, { method: 'PUT', headers, body: JSON.stringify({ fio: 'Лесная Анна Петровна' }) })).json()) as any;
    // 96 ч − 8 ч допустимых = 88 ч × 0,15% = 13,2% (а не 87 ч и 13,05%).
    assert.equal(put.case.months.reduce((s: number, m: any) => s + m.percent, 0), 13.2);
    assert.match(put.claimText, /\(4 суток\) коммунальная услуга/);
    assert.match(put.case.months.map((m: any) => m.lines.join(' ')).join(' '), /Перерыв за месяц: \d+ ч \(/);
  });
});

test('устаревшее заявление возвращается в актуальное; плата после подачи его не портит; «кв 5» — не дом', async () => {
  await withServer(async (base, h) => {
    const headers = { 'X-Max-Init-Data': initFor(99), 'Content-Type': 'application/json' };
    await h.start(99);
    const post = (url: string, body: object = {}) => fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const get = async (id: number) => ((await (await fetch(`${base}/api/cases/${id}`, { headers })).json()) as any).case;
    const put = (id: number, body: object) => fetch(`${base}/api/cases/${id}/claim`, { method: 'PUT', headers, body: JSON.stringify(body) });
    const times = (id: number, body: object) => fetch(`${base}/api/cases/${id}/times`, { method: 'PATCH', headers, body: JSON.stringify(body) });
    const { house } = (await (await post('/api/me/houses', { address: 'Лесная 41', city: 'Москва' })).json()) as any;
    // Окончание с секундами — как «Только что»; в поле времени потом будет то же время без секунд.
    const { caseId } = (await (await post('/api/report', { houseId: house.id, service: 'hot_water_off', evidence: 'ads', number: '4512', startedAt: new Date(Date.now() - 50 * 3_600_000).toISOString() })).json()) as any;
    await post(`/api/cases/${caseId}/end`, { endedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    const month = (await get(caseId)).months[0].month;
    await put(caseId, { fio: 'Лесная Анна Петровна', bills: { [month]: '1000' } });
    await post(`/api/cases/${caseId}/pdf-link`);
    const endedAt = (await get(caseId)).endedAt as string;
    const minute = (iso: string) => new Date(Math.floor(new Date(iso).getTime() / 60_000) * 60_000).toISOString();

    // Сдвинули окончание — устарело; вернули прежнее (поле без секунд) — снова актуально.
    await times(caseId, { endedAt: new Date(new Date(endedAt).getTime() - 3 * 3_600_000).toISOString() });
    assert.equal((await get(caseId)).claimOutdated, true);
    await times(caseId, { endedAt: minute(endedAt) });
    assert.equal((await get(caseId)).claimOutdated, false, 'вернули прежнее время — заявление снова актуально');

    // До подачи новая плата делает заявление устаревшим (в нём другие рубли), после подачи — нет.
    await put(caseId, { fio: 'Лесная Анна Петровна', bills: { [month]: '1100' } });
    assert.equal((await get(caseId)).claimOutdated, true);
    await put(caseId, { fio: 'Лесная Анна Петровна', bills: { [month]: '1000' } });
    assert.equal((await get(caseId)).claimOutdated, false);
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
    await post(`/api/cases/${caseId}/submitted`, { date: `${today}T12:00:00`, number: '77' });
    await put(caseId, { fio: 'Лесная Анна Петровна', bills: { [month]: '1300' } });
    const after = await get(caseId);
    assert.equal(after.claimOutdated, false, 'уточнили плату после подачи — подавать заново не нужно');
    await post(`/api/cases/${caseId}/pdf-link`);
    assert.ok((await get(caseId)).claim.submittedAt, 'отметка «подано» не сбросилась');

    // «кв 5» — не адрес дома.
    const bad = await post('/api/me/houses', { address: 'кв 5', city: 'Казань' });
    assert.equal(bad.status, 400);
  });
});

test('health и статика мини-приложения', async () => {
  await withServer(async (base) => {
    const health = (await (await fetch(`${base}/health`)).json()) as any;
    assert.equal(health.ok, true);
    assert.equal(health.version, '1.2.0');
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
