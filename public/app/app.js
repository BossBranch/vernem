/* «Вернём» — мини-приложение. Без сборки: чистый JS + MAX Bridge.
   Экраны: главная (сообщить, мои адреса, мои дела) → сообщить о проблеме → дело;
   мои адреса: поиск дома по списку, карточка дома с юридическими данными. */
(function () {
  'use strict';

  var WebApp = window.WebApp || null;
  var params = new URLSearchParams(location.search);
  var DEMO_USER = params.get('demo') === '1' ? '900000001' : null;
  var initData = (WebApp && WebApp.initData) || '';
  var startParam = (WebApp && WebApp.initDataUnsafe && WebApp.initDataUnsafe.start_param) || '';
  var root = document.getElementById('root');
  var toastEl = document.getElementById('toast');
  var me = null;

  var SERVICE_ICON = {
    hot_water_off: '🚿', hot_water_temp: '🌡', heating_temp: '🥶', heating_off: '🔥', cold_water_off: '🚰',
    electricity_off: '💡', gas_off: '🔵', sewerage_off: '🚽', waste_off: '🗑'
  };
  var TONE = { tracking: 'open', ended: 'action', claim_ready: 'action', refunded: 'money', refused: 'open', closed: '' };
  var MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  var ACT_STATUS = { collecting: 'ждёт подписей', chair: 'ждёт подписей', ready: 'ждёт подписей', signed: 'подписан' };
  var INSPECTION = { executor_act: 'УК составила акт', no_show: 'УК не пришла в срок', rescheduled: 'перенесли по согласованию' };
  var GIS_HOUSES = 'https://dom.gosuslugi.ru/#!/houses';

  // ---------- утилиты ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function rub(n) {
    var whole = Math.round(n * 100) % 100 === 0;
    return n.toLocaleString('ru-RU', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }) + ' ₽';
  }
  function pct(n) { return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + '%'; }
  function when(iso, tz) {
    return new Date(iso).toLocaleString('ru-RU', { timeZone: tz || 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function monthTitle(m) { var p = m.split('-'); return MONTHS[Number(p[1]) - 1] + ' ' + p[0]; }
  function haptic(type) { try { WebApp && WebApp.HapticFeedback.notificationOccurred(type); } catch (e) { /* не везде есть */ } }
  function track(name) { api('POST', '/api/track', { name: name }).catch(function () {}); }
  function $(id) { return document.getElementById(id); }
  function each(sel, fn) { Array.prototype.forEach.call(root.querySelectorAll(sel), fn); }
  /** Значение для <input type="datetime-local"> в местном времени устройства. */
  function localNow() {
    var d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  var toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 3200);
  }

  function api(method, url, body) {
    var headers = { 'Content-Type': 'application/json' };
    if (initData) headers['X-Max-Init-Data'] = initData;
    else if (DEMO_USER) headers['X-Demo-User'] = DEMO_USER;
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || 'Сервер не ответил. Проверьте интернет и попробуйте ещё раз.');
        return data;
      });
    }, function () {
      throw new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
    });
  }

  function busy(btn, text) {
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = text;
    return function () { btn.disabled = false; btn.textContent = old; };
  }

  function showError(message, retry) {
    root.innerHTML = '<p class="state error">' + esc(message) + '</p>' + (retry ? '<button class="btn" id="retry">Повторить</button>' : '');
    if (retry) $('retry').onclick = retry;
  }

  function openExternal(a) {
    a.onclick = function (e) { if (WebApp && WebApp.openLink) { e.preventDefault(); WebApp.openLink(a.href); } };
  }

  // ---------- кнопка «Назад» MAX ----------
  var backHandler = null;
  function setBack(fn) {
    if (!WebApp || !WebApp.BackButton) return;
    try {
      if (backHandler) WebApp.BackButton.offClick(backHandler);
      backHandler = fn;
      if (fn) { WebApp.BackButton.onClick(fn); WebApp.BackButton.show(); } else WebApp.BackButton.hide();
    } catch (e) { /* старый клиент */ }
  }
  function home() { location.hash = ''; }
  function backLink(text, hash) {
    setBack(function () { location.hash = hash || ''; });
    return '<button class="back" data-go="' + esc(hash || '') + '">← ' + esc(text) + '</button>';
  }
  function bindBack() { each('[data-go]', function (b) { b.onclick = function () { location.hash = b.getAttribute('data-go'); }; }); }

  function loadMe() { return api('GET', '/api/me').then(function (m) { me = m; return m; }); }

  // ---------- главная ----------
  function renderHome() {
    setBack(null);
    root.innerHTML = '<p class="state">Загружаю…</p>';
    Promise.all([loadMe(), api('GET', '/api/cases')]).then(function (res) {
      var cases = res[1].cases;
      var pending = cases.filter(function (c) { return c.status === 'claim_ready'; }).reduce(function (s, c) { return s + c.estimate; }, 0);
      var html = '<h1>Вернём</h1><p class="muted">Отключили воду, свет или в квартире холодно — по закону положено снизить плату. Помогу получить деньги.</p>';
      html += '<button class="btn primary big" id="report">🚨 Сообщить о проблеме</button>';

      html += '<h2 class="section">Мои адреса</h2>';
      if (!me.houses.length) html += '<p class="muted">Добавьте адрес — я буду сообщать, если у соседей что-то отключат.</p>';
      else html += '<ul class="houses">' + me.houses.map(houseRow).join('') + '</ul>';
      html += '<button class="btn" id="addHouse">➕ Добавить адрес</button>';

      html += '<h2 class="section">Мои дела</h2>';
      if (cases.length) {
        html += '<ul class="ledger">' +
          '<li class="main"><span class="label">Вернули</span><span class="dots"></span><span class="sum">' + rub(me.refunded) + '</span></li>' +
          (pending > 0 ? '<li class="sub"><span class="label">Ждём в квитанции</span><span class="dots"></span><span class="sum">' + rub(Math.round(pending * 100) / 100) + '</span></li>' : '') +
          '</ul><ul class="cases">' + cases.map(caseRow).join('') + '</ul>';
      } else {
        html += '<p class="muted">Пока пусто. Что-то сломается — нажмите «Сообщить о проблеме».</p>';
      }
      html += '<footer><p>Нормы: Приложение № 1 к ПП РФ № 354, проверены ' + esc(me.normsCheckedAt.split('-').reverse().join('.')) +
        '. Расчёт ориентировочный, итог считает УК.</p><button id="delme">Удалить все мои данные</button></footer>';
      root.innerHTML = html;
      $('report').onclick = function () { location.hash = me.houses.length ? '#report' : '#addhouse/report'; };
      $('addHouse').onclick = function () { location.hash = '#addhouse'; };
      each('.case', function (el) { el.onclick = function () { location.hash = '#case/' + el.getAttribute('data-id'); }; });
      each('.house', function (el) { el.onclick = function (e) { if (e.target.tagName !== 'A') location.hash = '#house/' + el.getAttribute('data-id'); }; });
      $('delme').onclick = deleteAll;
    }).catch(function (e) { showError(e.message, renderHome); });
  }

  function houseRow(h) {
    var i = h.info || {};
    return '<li><div class="house" data-id="' + h.id + '" role="button" tabindex="0">' +
      '<span class="title">🏠 ' + esc(h.address) + (h.entrance ? ', подъезд ' + esc(h.entrance) : '') + '</span>' +
      '<span class="meta">' + (i.ukName ? 'УК: ' + esc(i.ukName) : 'Данные дома не заполнены') + ' · соседей в сети: ' + h.members + '</span>' +
      (i.adsPhone ? '<a class="phone" href="tel:' + esc(i.adsPhone.replace(/[^\d+]/g, '')) + '">📞 Аварийная служба: ' + esc(i.adsPhone) + '</a>' : '') +
      '</div></li>';
  }

  function caseRow(c) {
    var sum = c.refundAmount ? rub(c.refundAmount) : c.estimate > 0 ? '≈ ' + rub(c.estimate) : '';
    return '<li><button class="case" data-id="' + c.id + '" data-tone="' + (TONE[c.status] || '') + '">' +
      '<span class="title">' + (SERVICE_ICON[c.service] || '') + ' ' + esc(c.serviceTitle) + '</span>' +
      '<span class="amount">' + esc(sum) + '</span>' +
      '<span class="meta">' + esc(c.address) + ' · с ' + esc(when(c.startedAt, c.tz)) + '</span>' +
      '<span class="status">' + esc(c.statusTitle) + (c.demo ? '<span class="demo-tag">демо</span>' : '') + '</span>' +
      '</button></li>';
  }

  function deleteAll() {
    if (!confirm('Удалить адреса, ФИО, все дела и заявления? Это нельзя отменить.')) return;
    api('DELETE', '/api/me').then(function () { toast('Все ваши данные удалены'); renderHome(); }).catch(function (e) { toast(e.message); });
  }

  // ---------- добавить адрес: дом выбирается из списка ----------
  function renderAddHouse(next) {
    if (!me) { loadMe().then(function () { renderAddHouse(next); }).catch(function (e) { toast(e.message); }); return; }
    var cities = me.cities || [];
    var html = backLink('Назад', '') + '<h1>Добавить адрес</h1>' +
      '<label for="city">Город</label><input id="city" list="cityList" autocomplete="off" value="' + esc(cities[0] || '') + '">' +
      '<datalist id="cityList">' + cities.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' +
      '<label for="q">Улица и номер дома</label><input id="q" autocomplete="off" placeholder="Например: Садовая 10">' +
      '<ul class="results" id="results"></ul>' +
      '<div id="pick" hidden><p class="picked" id="picked"></p>' +
      '<label for="entrance">Подъезд (необязательно)</label><input id="entrance" inputmode="numeric" maxlength="4">' +
      '<div class="actions"><button class="btn primary" id="add">Добавить</button></div></div>' +
      '<p class="muted hint">Выберите дом из списка — так вы окажетесь в одной сети с соседями. Нет дома в списке — вы первый, добавьте его.</p>';
    root.innerHTML = html;
    bindBack();
    var chosen = null;
    var timer = null;
    var q = $('q');
    var city = $('city');
    q.focus();
    // Город входит в адрес: «Садовая 10» в Москве и в Казани — разные дома.
    city.oninput = function () { q.oninput(); };
    q.oninput = function () {
      clearTimeout(timer);
      chosen = null;
      $('pick').hidden = true;
      var text = q.value.trim();
      var cityName = city.value.trim();
      if (text.length < 2) { $('results').innerHTML = ''; return; }
      if (cityName.length < 2) { $('results').innerHTML = '<li class="muted">Сначала укажите город</li>'; return; }
      timer = setTimeout(function () {
        api('GET', '/api/houses/search?q=' + encodeURIComponent(text) + '&city=' + encodeURIComponent(cityName)).then(function (r) {
          var items = r.houses.map(function (h) {
            return '<li><button class="result" data-id="' + h.id + '" data-address="' + esc(h.address) + '">🏠 ' + esc(h.address) + '<small>' + (h.members ? ' · соседей в сети: ' + h.members : '') + '</small></button></li>';
          });
          if (/\d/.test(text)) items.push('<li><button class="result new" data-new="1">➕ Моего дома нет — добавить «' + esc(text) + '»</button></li>');
          $('results').innerHTML = items.join('') || '<li class="muted">Добавьте номер дома</li>';
          Array.prototype.forEach.call($('results').querySelectorAll('.result'), function (b) {
            b.onclick = function () {
              chosen = b.getAttribute('data-new') ? { address: text, city: cityName, label: cityName + ', ' + text } : { houseId: Number(b.getAttribute('data-id')), label: b.getAttribute('data-address') };
              $('picked').textContent = '📍 ' + chosen.label;
              $('pick').hidden = false;
              $('results').innerHTML = '';
              $('entrance').focus();
            };
          });
        }).catch(function (e) { toast(e.message); });
      }, 250);
    };
    $('add').onclick = function () {
      if (!chosen) return;
      var done = busy($('add'), 'Добавляю…');
      var body = { entrance: $('entrance').value.trim() || undefined };
      if (chosen.houseId) body.houseId = chosen.houseId; else { body.address = chosen.address; body.city = chosen.city; }
      api('POST', '/api/me/houses', body).then(function (r) {
        haptic('success');
        track('app_house_added');
        toast('Адрес добавлен');
        location.hash = next === 'report' ? '#report' : '#house/' + r.house.id;
      }).catch(function (e) { haptic('error'); toast(e.message); }).then(done);
    };
  }

  // ---------- карточка дома: юридические данные ----------
  var INFO_FIELDS = [
    ['ukName', 'УК или ТСЖ — получатель за «содержание жилья»', 'ООО «УК Пример»'],
    ['ukInn', 'ИНН УК', '10 цифр', 'numeric'],
    ['adsPhone', 'Телефон аварийной службы', '+7 …', 'tel'],
    ['ukEmail', 'Почта УК для заявлений', 'uk@example.ru', 'email'],
    ['ukAddress', 'Адрес УК', 'куда нести заявление'],
    ['rsoHeat', 'Тепло и горячая вода — кому платите', 'например «АО Теплосеть» или «УК»'],
    ['rsoWater', 'Холодная вода и канализация', 'например «Водоканал» или «УК»'],
    ['rsoPower', 'Электричество', 'например «Мосэнергосбыт»'],
    ['rsoGas', 'Газ', ''],
    ['rop', 'Вывоз мусора (региональный оператор)', ''],
    ['gji', 'Жилищная инспекция региона', 'название, телефон или сайт']
  ];

  function renderHouse(id) {
    root.innerHTML = '<p class="state">Загружаю дом…</p>';
    api('GET', '/api/houses/' + id).then(function (r) {
      var h = r.house;
      var i = h.info || {};
      var html = backLink('Главная', '') + '<h1>🏠 ' + esc(h.address) + '</h1>' +
        '<p class="muted">Соседей в сети: ' + h.members + (i.updatedAt ? ' · данные обновлены ' + esc(when(i.updatedAt)) : '') + '</p>';

      html += '<section class="sheet"><h2>Я и этот дом</h2>' +
        '<div class="row2"><div><label for="entrance">Подъезд</label><input id="entrance" inputmode="numeric" maxlength="4" value="' + esc(h.entrance || '') + '"></div>' +
        '<div><label for="notify">Уведомления</label><select id="notify"><option value="1"' + (h.notify ? ' selected' : '') + '>Присылать</option><option value="0"' + (h.notify ? '' : ' selected') + '>Не присылать</option></select></div></div>' +
        (h.inviteLink ? '<label>Позовите соседей — чем больше в сети, тем быстрее соберётся акт</label><div class="copy"><input readonly id="invite" value="' + esc(h.inviteLink) + '"><button class="btn" id="copy">Копировать</button></div>' : '') +
        '</section>';

      html += '<section class="sheet"><h2>Данные дома <small>из квитанции</small></h2>' +
        '<p class="muted">Заполняют жители — один раз для всех соседей. Эти данные попадут в заявления. Сверить можно в <a href="' + GIS_HOUSES + '" data-ext>ГИС ЖКХ</a>.</p>' +
        INFO_FIELDS.map(function (f) {
          return '<label for="f_' + f[0] + '">' + esc(f[1]) + '</label><input id="f_' + f[0] + '"' + (f[3] ? ' inputmode="' + f[3] + '"' : '') + ' placeholder="' + esc(f[2]) + '" value="' + esc(i[f[0]] || '') + '">';
        }).join('') +
        '<div class="actions"><button class="btn primary" id="saveInfo">Сохранить</button></div></section>';

      html += '<div class="actions"><button class="btn danger" id="remove">Убрать адрес из моего списка</button></div>';
      root.innerHTML = html;
      bindBack();
      each('a[data-ext]', openExternal);

      function patch(body) {
        return api('PATCH', '/api/me/houses/' + h.id, body).then(function () { toast('Сохранено'); }).catch(function (e) { toast(e.message); });
      }
      $('entrance').onchange = function () { patch({ entrance: $('entrance').value.trim() || null }); };
      $('notify').onchange = function () { patch({ notify: $('notify').value === '1' }); };
      if ($('copy')) $('copy').onclick = function () {
        var link = $('invite').value;
        (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { toast('Ссылка скопирована — отправьте её соседям'); }, function () { $('invite').select(); toast('Выделите и скопируйте ссылку'); });
      };
      $('saveInfo').onclick = function () {
        var body = {};
        INFO_FIELDS.forEach(function (f) { body[f[0]] = $('f_' + f[0]).value.trim() || undefined; });
        var done = busy($('saveInfo'), 'Сохраняю…');
        api('PUT', '/api/houses/' + h.id + '/info', body).then(function () { haptic('success'); track('app_house_info'); toast('Данные дома сохранены'); }).catch(function (e) { haptic('error'); toast(e.message); }).then(done);
      };
      $('remove').onclick = function () {
        if (!confirm('Убрать «' + h.address + '» из вашего списка? Дела по этому адресу сохранятся.')) return;
        api('DELETE', '/api/me/houses/' + h.id).then(function () { toast('Адрес убран'); home(); }).catch(function (e) { toast(e.message); });
      };
    }).catch(function (e) { showError(e.message, function () { renderHouse(id); }); });
  }

  // ---------- сообщить о проблеме ----------
  function renderReport() {
    // Список адресов всегда свежий: его могли только что изменить на другом экране.
    loadMe().then(function () {
      if (!me.houses.length) { location.hash = '#addhouse/report'; return; }
      var st = { houseId: me.houses.length === 1 ? me.houses[0].id : null, service: null };
      var html = backLink('Главная', '') + '<h1>Что случилось?</h1>';
      html += '<label>Где</label><div class="chips" id="houses">' + me.houses.map(function (h) {
        return '<button class="chip' + (st.houseId === h.id ? ' on' : '') + '" data-id="' + h.id + '">📍 ' + esc(h.address) + '</button>';
      }).join('') + '</div>';
      html += '<label>Что</label><div class="grid" id="services">' + me.services.map(function (s) {
        return '<button class="tile" data-key="' + s.key + '" aria-label="' + esc(s.button) + '">' + (SERVICE_ICON[s.key] || '') + '<span>' + esc(s.button) + '</span></button>';
      }).join('') + '</div>';
      html += '<div id="details" hidden>' +
        '<div id="extra"></div>' +
        '<section class="sheet"><h2>📞 Аварийная служба</h2><p id="adsHint" class="muted"></p>' +
        '<label><input type="radio" name="ev" value="ads" checked> Позвонил — есть номер заявки</label>' +
        '<label><input type="radio" name="ev" value="written"> Написал обращение (Госуслуги Дом, ГИС ЖКХ)</label>' +
        '<label><input type="radio" name="ev" value="self"> Не дозвонился — соберу акт с соседями</label>' +
        '<div id="numberBox"><label for="number">Номер заявки или обращения</label><input id="number" maxlength="40"></div>' +
        '<label for="started">Когда началось (для заявки — когда её приняли)</label><input id="started" type="datetime-local" value="' + localNow() + '">' +
        '</section>' +
        '<div class="actions"><button class="btn primary" id="submit">Записать</button></div></div>';
      root.innerHTML = html;
      bindBack();

      function refresh() {
        each('#houses .chip', function (b) { b.classList.toggle('on', Number(b.getAttribute('data-id')) === st.houseId); });
        each('#services .tile', function (b) { b.classList.toggle('on', b.getAttribute('data-key') === st.service); });
        $('details').hidden = !(st.houseId && st.service);
        if (!st.service) return;
        var s = me.services.filter(function (x) { return x.key === st.service; })[0];
        var h = me.houses.filter(function (x) { return x.id === st.houseId; })[0];
        var extra = '';
        if (st.service === 'hot_water_off') extra = '<label><input type="checkbox" id="planned"> Отключили по плану (летом, с объявлением)</label>';
        if (st.service === 'electricity_off') extra = '<label for="variant">Сколько у дома вводов электричества</label><select id="variant"><option value="one_source">Один / не знаю</option><option value="two_sources">Два (обычно у домов с лифтами)</option></select>';
        if (s && s.kind !== 'interruption') {
          extra = (st.service === 'heating_temp' ? '<label for="corner">Комната</label><select id="corner"><option value="0">Обычная — норма +18 °C</option><option value="1">Угловая — норма +20 °C</option></select>' : '') +
            '<label for="temp">🌡 Сколько градусов показал термометр</label><input id="temp" inputmode="decimal" placeholder="Например 16">' +
            '<p class="muted hint">' + (st.service === 'heating_temp' ? 'Меряйте в центре комнаты, на высоте около 1 м, вдали от окон и батарей.' : 'Меряйте воду из крана после слива в течение 3 минут.') + '</p>';
        }
        $('extra').innerHTML = extra ? '<section class="sheet">' + extra + '</section>' : '';
        var phone = h && h.info && h.info.adsPhone;
        $('adsHint').innerHTML = phone
          ? 'Позвоните: <a href="tel:' + esc(phone.replace(/[^\d+]/g, '')) + '">' + esc(phone) + '</a>. Скажите адрес и что случилось, запишите номер заявки — это главное доказательство.'
          : 'Телефон есть в квитанции. Скажите адрес и что случилось, запишите номер заявки — это главное доказательство.';
      }
      each('#houses .chip', function (b) { b.onclick = function () { st.houseId = Number(b.getAttribute('data-id')); refresh(); }; });
      each('#services .tile', function (b) { b.onclick = function () { st.service = b.getAttribute('data-key'); refresh(); }; });
      each('input[name=ev]', function (r) { r.onchange = function () { $('numberBox').hidden = r.value === 'self' && r.checked; }; });
      refresh();

      $('submit').onclick = function () {
        var ev = root.querySelector('input[name=ev]:checked').value;
        var body = {
          houseId: st.houseId,
          service: st.service,
          evidence: ev,
          number: $('number').value.trim() || null,
          startedAt: new Date($('started').value).toISOString(),
          temp: $('temp') ? $('temp').value.trim() : undefined,
          corner: $('corner') ? $('corner').value === '1' : false,
          variant: $('variant') ? $('variant').value : undefined,
          planned: $('planned') ? $('planned').checked : false
        };
        if (ev !== 'self' && !body.number) { toast('Впишите номер заявки или выберите «Не дозвонился»'); return; }
        var done = busy($('submit'), 'Записываю…');
        api('POST', '/api/report', body).then(function (r) {
          haptic('success');
          track('app_report');
          toast('Записал. Сообщил соседям — подробности в чате с ботом');
          location.hash = '#case/' + r.caseId;
        }).catch(function (e) { haptic('error'); toast(e.message); }).then(done);
      };
    }).catch(function (e) { showError(e.message, renderReport); });
  }

  // ---------- дело ----------
  function renderCase(id, focusShare) {
    root.innerHTML = '<p class="state">Загружаю…</p>';
    api('GET', '/api/cases/' + id).then(function (data) {
      var c = data.case;
      var html = backLink('Главная', '');
      html += '<h1>' + (SERVICE_ICON[c.service] || '') + ' ' + esc(c.serviceTitle) + '</h1>';
      html += '<p class="muted">' + esc(c.address) + ' · ' + esc(c.statusTitle) + (c.demo ? '<span class="demo-tag">демо-данные</span>' : '') + '</p>';

      if (c.status === 'tracking') {
        html += '<section class="sheet"><h2>Починили?</h2><label for="ended">Когда</label><input id="ended" type="datetime-local" value="' + localNow() + '">' +
          '<div class="actions"><button class="btn primary" id="endBtn">✅ Починили — посчитать деньги</button></div>' +
          '<p class="muted hint">Скажите аварийной службе, что починили: так фиксируется конец (п. 112 ПП № 354).</p></section>';
      }

      html += '<section class="sheet"><h2>Что записано</h2><dl class="facts">' +
        '<dt>Начало</dt><dd class="num">' + esc(when(c.startedAt, c.tz)) + '</dd>' +
        '<dt>Окончание</dt><dd class="num">' + (c.endedAt ? esc(when(c.endedAt, c.tz)) : 'ещё не починили') + '</dd>' +
        '<dt>Доказательство</dt><dd>' + esc(evidenceText(c)) + '</dd>' +
        (c.readings.length ? '<dt>Замеры</dt><dd class="num">' + c.readings.map(function (r) { return esc(when(r.at, c.tz)) + ': +' + String(r.tempC).replace('.', ',') + ' °C'; }).join('<br>') + '</dd>' : '') +
        (c.neighbours > 0 ? '<dt>Соседи</dt><dd>' + c.neighbours + '</dd>' : '') +
        (c.inspection ? '<dt>Проверка</dt><dd>' + esc(INSPECTION[c.inspection] || '') + '</dd>' : '') +
        (c.act ? '<dt>Акт</dt><dd>' + esc(ACT_STATUS[c.act.status] || '') + ' · жителей: ' + c.act.residents + '</dd>' : '') +
        (c.photos > 0 ? '<dt>Фото</dt><dd class="num">' + c.photos + '</dd>' : '') +
        '</dl>' +
        (c.evidence === 'self' && !c.act ? '<p class="muted hint">📄 Без номера заявки нужен акт — доказательство, что услуги не было. В чате с ботом нажмите «📄 Акт с соседями»: пришлю PDF, соседи его подпишут.</p>' : '') +
        '</section>';

      if (c.endedAt) {
        html += '<section class="sheet"><h2>Деньги <small>' + esc(c.basis) + '</small></h2>' + (c.estimate > 0 ? '<p class="total">Положено ≈ ' + rub(c.estimate) + '</p>' : '') + '<ul class="formula">';
        c.months.forEach(function (m) {
          if (c.months.length > 1) html += '<li class="month">' + esc(monthTitle(m.month)) + '</li>';
          m.lines.forEach(function (l) { html += '<li>' + esc(l) + '</li>'; });
        });
        html += '</ul><p class="source muted">Источник: <a href="' + esc(c.basisUrl) + '" data-ext>' + esc(c.basis) + ' к ПП РФ № 354</a>. Итог считает УК.</p></section>';
      }

      if (c.endedAt && c.status !== 'closed') html += claimForm(c);

      html += '<div class="actions">';
      if (c.status === 'tracking' || c.status === 'ended' || c.status === 'claim_ready') html += '<button class="btn" id="share">👥 Позвать соседей</button>';
      html += '</div>';
      root.innerHTML = html;
      bindBack();
      bindCase(c);
      if (focusShare) { var s = $('share'); if (s) s.focus(); }
    }).catch(function (e) { showError(e.message, function () { renderCase(id); }); });
  }

  function evidenceText(c) {
    if (c.evidence === 'ads' && c.adsNumber) return 'заявка № ' + c.adsNumber + (c.role === 'neighbour' ? ' (по дому)' : '');
    if (c.evidence === 'written') return 'обращение' + (c.adsNumber ? ' № ' + c.adsNumber : '');
    return c.act && c.act.status === 'signed' ? 'акт с соседями' : 'без номера заявки';
  }

  function claimForm(c) {
    var cl = c.claim || {};
    var opt = function (v, t) { return '<option value="' + v + '"' + (cl.executorType === v ? ' selected' : '') + '>' + t + '</option>'; };
    var bills = c.months.filter(function (m) { return m.percent > 0; }).map(function (m) {
      return '<label for="bill_' + m.month + '">Начислено за услугу за ' + esc(monthTitle(m.month)) + ', ₽ (строка в квитанции)</label><input id="bill_' + m.month + '" data-month="' + m.month + '" class="bill" inputmode="decimal" placeholder="Например 1200" value="' + (m.bill ? String(m.bill).replace('.', ',') : '') + '">';
    }).join('');
    return '<section class="sheet"><h2>Заявление <small>на перерасчёт</small></h2>' +
      '<p class="muted hint">💰 Заявление — требование вернуть деньги. Подписываете вы. Акт с соседями, если есть, — приложение к нему.</p>' +
      bills +
      '<button class="btn" id="scan" type="button">📷 Заполнить из QR квитанции</button>' +
      '<label for="executor">Кому (получатель платежа)</label><input id="executor" autocomplete="off" value="' + esc(cl.executor || '') + '" placeholder="Как в квитанции">' +
      '<div class="row2"><div><label for="inn">ИНН</label><input id="inn" inputmode="numeric" value="' + esc(cl.executorInn || '') + '"></div>' +
      '<div><label for="etype">Кто это</label><select id="etype">' + opt('uk', 'УК / ТСЖ') + opt('rso', 'Поставщик') + opt('rop', 'Рег. оператор ТКО') + opt('unknown', 'Не знаю') + '</select></div></div>' +
      '<label for="fio">Ваши ФИО</label><input id="fio" autocomplete="name" value="' + esc(cl.fio || '') + '">' +
      '<div class="row2"><div><label for="flat">Квартира</label><input id="flat" value="' + esc(cl.flat || '') + '"></div>' +
      '<div><label for="account">Лицевой счёт</label><input id="account" value="' + esc(cl.account || '') + '"></div></div>' +
      '<div class="actions"><button class="btn primary" id="pdf">📄 Скачать заявление (PDF)</button></div>' +
      '<p class="muted hint">Подать можно лично в УК (два экземпляра, на своём — отметка о приёме), через «Госуслуги Дом» или ГИС ЖКХ с PDF во вложении, или на почту УК. PDF можно переписать от руки.</p>' +
      '</section>';
  }

  function formValues() {
    var v = function (id) { var el = $(id); return el ? el.value.trim() : undefined; };
    var bills = {};
    each('.bill', function (el) { bills[el.getAttribute('data-month')] = el.value.trim(); });
    return { executor: v('executor'), executorInn: v('inn'), executorType: v('etype'), fio: v('fio'), flat: v('flat'), account: v('account'), bills: bills };
  }

  function bindCase(c) {
    each('a[data-ext]', openExternal);
    var dirty = false;
    each('input, select', function (el) {
      el.addEventListener('input', function () {
        if (!dirty && WebApp && WebApp.enableClosingConfirmation) try { WebApp.enableClosingConfirmation(); } catch (e) {}
        dirty = true;
      });
    });

    function save() {
      return api('PUT', '/api/cases/' + c.id + '/claim', formValues()).then(function (data) {
        dirty = false;
        try { WebApp && WebApp.disableClosingConfirmation(); } catch (e) {}
        return data;
      });
    }

    var endBtn = $('endBtn');
    if (endBtn) endBtn.onclick = function () {
      var done = busy(endBtn, 'Считаю…');
      api('POST', '/api/cases/' + c.id + '/end', { endedAt: new Date($('ended').value).toISOString() }).then(function () {
        haptic('success');
        track('app_end');
        renderCase(c.id);
      }).catch(function (e) { haptic('error'); toast(e.message); done(); });
    };

    var pdfBtn = $('pdf');
    if (pdfBtn) pdfBtn.onclick = function () {
      var done = busy(pdfBtn, 'Готовлю PDF…');
      save().then(function () {
        return api('POST', '/api/cases/' + c.id + '/pdf-link');
      }).then(function (r) {
        track('app_pdf');
        if (WebApp && WebApp.downloadFile && initData) {
          return Promise.resolve(WebApp.downloadFile(r.url, r.fileName)).then(function () { toast('Заявление скачивается'); });
        }
        window.open(r.url, '_blank');
      }).catch(function (e) { toast(e && e.message ? e.message : 'Не удалось скачать PDF'); }).then(done);
    };

    var scanBtn = $('scan');
    if (scanBtn) scanBtn.onclick = function () {
      if (!WebApp || !WebApp.openCodeReader) { toast('Сканер QR работает в приложении MAX'); return; }
      Promise.resolve(WebApp.openCodeReader(true)).then(function (res) {
        var qr = typeof res === 'string' ? res : res && (res.value || res.text || res.result || res.data);
        if (!qr) throw new Error('QR-код не распознан. Попробуйте ещё раз при хорошем освещении.');
        return api('POST', '/api/receipt/parse', { qr: qr });
      }).then(function (r) {
        var i = r.info;
        if (i.executor) $('executor').value = i.executor;
        if (i.executorInn) $('inn').value = i.executorInn;
        if (i.account) $('account').value = i.account;
        dirty = true;
        haptic('success');
        track('app_qr');
        toast('Данные из квитанции подставлены — проверьте');
      }).catch(function (e) {
        haptic('error');
        toast(e && e.message ? e.message : (e && e.error && e.error.code === 'client.qr.cancelled' ? 'Сканирование отменено' : 'Не удалось отсканировать QR'));
      });
    };

    var shareBtn = $('share');
    if (shareBtn) shareBtn.onclick = function () {
      var done = busy(shareBtn, 'Готовлю карточку…');
      api('POST', '/api/cases/' + c.id + '/share').then(function (r) {
        track('app_share');
        if (WebApp && WebApp.shareMaxContent && initData) {
          // Бот уже прислал карточку в диалог; пересылаем её в домовой чат через нативный экран MAX.
          return Promise.resolve(WebApp.shareMaxContent({ mid: r.mid, chatType: 'DIALOG' })).then(function () { haptic('success'); });
        }
        toast('Карточка в чате с ботом — перешлите её соседям');
      }).catch(function (e) { toast(e && e.message ? e.message : 'Не удалось поделиться'); }).then(done);
    };
  }

  // ---------- маршрутизация ----------
  function route() {
    var h = location.hash;
    var m;
    if ((m = /^#case\/(\d+)$/.exec(h))) return renderCase(Number(m[1]), false);
    if ((m = /^#house\/(\d+)$/.exec(h))) return renderHouse(Number(m[1]));
    if ((m = /^#addhouse(\/report)?$/.exec(h))) return renderAddHouse(m[1] ? 'report' : null);
    if (h === '#report') return renderReport();
    renderHome();
  }

  if (!initData && !DEMO_USER) {
    root.innerHTML = '<h1>Вернём</h1><p>Это мини-приложение открывается из бота «Вернём» в MAX — кнопка «Открыть приложение» в меню бота.</p>';
    return;
  }
  window.addEventListener('hashchange', route);
  var share = /^share_(\d+)$/.exec(startParam);
  var house = /^house_(\d+)$/.exec(startParam);
  if (share) { history.replaceState(null, '', '#case/' + share[1]); renderCase(Number(share[1]), true); }
  else if (house) { history.replaceState(null, '', '#house/' + house[1]); renderHouse(Number(house[1])); }
  else if (startParam === 'report') { history.replaceState(null, '', '#report'); renderReport(); }
  else route();
})();
