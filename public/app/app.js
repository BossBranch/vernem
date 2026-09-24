/* «Вернём» — мини-приложение. Без сборки: чистый JS + MAX Bridge.
   Экраны: главная (сообщить, мои адреса, мои дела) → сообщить о проблеме → дело;
   мои адреса: город и дом из списка, карточка дома с данными из квитанции.
   Правило текстов: на экране — простые слова, ссылки на законы — только в документах. */
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
  /** Что значит каждая плитка — чтобы «Холодно в квартире» не путали с «Нет отопления». */
  var SERVICE_DESC = {
    hot_water_off: 'Из крана с горячей водой вода не идёт или идёт только холодная.',
    hot_water_temp: 'Горячая вода есть, но еле тёплая — заметно ниже +60 °C.',
    heating_temp: 'Батареи тёплые, но в комнате ниже +18 °C (в угловой — ниже +20 °C).',
    heating_off: 'Батареи совсем холодные — отопление отключили.',
    cold_water_off: 'Холодной воды нет совсем.',
    electricity_off: 'Нет света в квартире или во всём доме.',
    gas_off: 'Газа нет — плита не горит.',
    sewerage_off: 'Канализация засорилась или сломалась — пользоваться нельзя.',
    waste_off: 'Мусор не вывозят — контейнеры переполнены.'
  };
  /** Когда началось — по-человечески для каждой проблемы. */
  var START_LABEL = {
    hot_water_temp: 'С какого времени вода еле тёплая',
    heating_temp: 'С какого времени холодно',
    sewerage_off: 'Когда начался засор',
    waste_off: 'С какого дня не вывозят мусор'
  };
  var END_TITLE = { heating_temp: 'Стало тепло?', hot_water_temp: 'Вода снова горячая?', waste_off: 'Мусор вывезли?' };
  var END_BUTTON = { heating_temp: '✅ Стало тепло — посчитать деньги', hot_water_temp: '✅ Вода горячая — посчитать деньги', waste_off: '✅ Вывезли — посчитать деньги' };
  var TONE = { tracking: 'open', ended: 'action', claim_ready: 'action', refunded: 'money', refused: 'open', closed: '' };
  /** Как услуга называется в квитанции — для вопроса «сколько начислено за …». */
  var BILL_NAME = {
    hot_water_off: 'горячую воду', hot_water_temp: 'горячую воду', heating_temp: 'отопление', heating_off: 'отопление',
    cold_water_off: 'холодную воду', electricity_off: 'электричество', gas_off: 'газ', sewerage_off: 'водоотведение', waste_off: 'вывоз мусора'
  };
  var MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
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
  /** Число не отрывается от единицы: «8 ч», «1 200 ₽», «+18 °C». */
  function nb(s) { return esc(s).replace(/(\d) (?=(ч|мин|сут|°C|₽|%|руб))/g, '$1&nbsp;'); }
  function rub(n) {
    var whole = Math.round(n * 100) % 100 === 0;
    return n.toLocaleString('ru-RU', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }) + ' ₽';
  }
  function when(iso, tz) {
    return new Date(iso).toLocaleString('ru-RU', { timeZone: tz || 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function day(iso, tz) { return new Date(iso).toLocaleDateString('ru-RU', { timeZone: tz || 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' }); }
  function monthTitle(m) { var p = m.split('-'); return MONTHS[Number(p[1]) - 1] + ' ' + p[0]; }
  function monthKeyOf(iso) { var d = new Date(iso); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function nextMonth(key) { var p = key.split('-').map(Number); return p[1] === 12 ? (p[0] + 1) + '-01' : p[0] + '-' + String(p[1] + 1).padStart(2, '0'); }
  function plural(n, forms) {
    var a = Math.abs(n) % 100, b = a % 10;
    return forms[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2];
  }
  /** ISO-время → значение для <input type="datetime-local"> во времени устройства. */
  function toLocalInput(iso) {
    var d = new Date(iso);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }
  function localNow() { return toLocalInput(new Date().toISOString()); }
  function today() { return localNow().slice(0, 10); }
  /** Телефон годится для ссылки «позвонить»: только цифры и знаки номера. */
  function telHref(phone) {
    var digits = String(phone || '').replace(/[^\d+]/g, '');
    return /[^\d\s+()\-.]/.test(phone) || digits.replace(/\D/g, '').length < 3 ? null : 'tel:' + digits;
  }
  function parseMoney(s) {
    var v = parseFloat(String(s || '').replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(v) ? v : null;
  }
  function haptic(type) { try { WebApp && WebApp.HapticFeedback.notificationOccurred(type); } catch (e) { /* не везде есть */ } }
  function track(name) { api('POST', '/api/track', { name: name }).catch(function () {}); }
  function $(id) { return document.getElementById(id); }
  function each(sel, fn) { Array.prototype.forEach.call(root.querySelectorAll(sel), fn); }

  var toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    // Длинное сообщение — дольше на экране; нажатие закрывает сразу.
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, Math.min(12000, 3500 + text.length * 60));
  }
  toastEl.onclick = function () { toastEl.hidden = true; };

  function api(method, url, body) {
    var headers = { 'Content-Type': 'application/json' };
    if (initData) headers['X-Max-Init-Data'] = initData;
    else if (DEMO_USER) headers['X-Demo-User'] = DEMO_USER;
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var err = new Error(data.error || 'Сервер не ответил. Проверьте интернет и попробуйте ещё раз.');
          err.fields = data.fields || null;
          throw err;
        }
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

  /**
   * Ошибки по полям: текст под полем, красная рамка, прокрутка к первому.
   * map — имя поля на сервере → id элемента на экране (если отличаются).
   */
  function clearErrors() {
    each('.field-error', function (p) { p.parentNode.removeChild(p); });
    each('[aria-invalid]', function (el) { el.removeAttribute('aria-invalid'); });
  }
  function showErrors(e, map) {
    clearErrors();
    var first = null;
    var fields = (e && e.fields) || {};
    Object.keys(fields).forEach(function (k) {
      var el = $((map && map[k]) || k);
      if (!el) return;
      var d = el.closest && el.closest('details');
      if (d) d.open = true;
      el.setAttribute('aria-invalid', 'true');
      var p = document.createElement('p');
      p.className = 'field-error';
      p.innerHTML = nb(fields[k]);
      el.insertAdjacentElement('afterend', p);
      if (!first) first = el;
    });
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      try { first.focus({ preventScroll: true }); } catch (x) { first.focus(); }
    }
    haptic('error');
    if (!first || Object.keys(fields).length > 1) toast(e && e.message ? e.message : 'Что-то пошло не так. Попробуйте ещё раз.');
  }
  function fieldErr(id, message) { var f = {}; f[id] = message; return { message: message, fields: f }; }

  function showError(message, retry) {
    root.innerHTML = '<p class="state error">' + esc(message) + '</p>' + (retry ? '<button class="btn" id="retry">Повторить</button>' : '');
    if (retry) $('retry').onclick = retry;
  }

  /** Скачать файл по ссылке: в MAX — нативно, в браузере — переходом (ответ с attachment не уводит со страницы). */
  function download(url, fileName) {
    if (WebApp && WebApp.downloadFile && initData) return Promise.resolve(WebApp.downloadFile(url, fileName));
    location.href = url;
    return Promise.resolve();
  }

  /** Поделиться ссылкой: системное меню телефона, иначе — копия в буфер обмена. */
  function shareLink(url, text) {
    if (navigator.share) return navigator.share({ text: text, url: url }).catch(function () {});
    return (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(
      function () { toast('Ссылка скопирована — отправьте её соседям'); },
      function () { window.prompt('Скопируйте ссылку и отправьте соседям:', url); }
    );
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
      var html = '<h1>Вернём</h1><p class="lead">Отключили воду, свет или в квартире холодно — по закону положено снизить плату. Помогу получить эти деньги.</p>';
      html += '<button class="btn primary big" id="report">🚨 Сообщить о проблеме</button>';

      html += '<h2 class="section">Мои адреса</h2>';
      if (!me.houses.length) html += '<p class="muted">Добавьте адрес — я буду сообщать, если у соседей что-то отключат.</p>';
      else html += '<ul class="houses">' + me.houses.map(houseRow).join('') + '</ul>';
      html += '<button class="btn" id="addHouse">➕ Добавить адрес</button>';

      html += '<h2 class="section">Мои дела</h2>';
      if (cases.length) {
        html += '<ul class="ledger">' +
          '<li class="main"><span class="label">Вернули</span><span class="dots"></span><span class="sum">' + rub(me.refunded) + '</span></li>' +
          (pending > 0 ? '<li class="sub"><span class="label">Положено по готовым заявлениям</span><span class="dots"></span><span class="sum">≈ ' + rub(Math.round(pending * 100) / 100) + '</span></li>' : '') +
          '</ul><ul class="cases">' + cases.map(caseRow).join('') + '</ul>';
      } else {
        html += '<p class="muted">Пока пусто.</p>';
      }
      html += '<details class="sheet how"' + (cases.length ? '' : ' open') + '><summary>Как это работает</summary><ol class="steps">' +
        '<li><b>Отключили</b> — нажмите «Сообщить о проблеме» и позвоните в аварийную службу: номер заявки — главное доказательство.</li>' +
        '<li><b>Починили</b> — нажмите «Починили», я посчитаю, сколько вам должны вернуть по закону.</li>' +
        '<li><b>Заявление</b> — скачайте его и отдайте в УК. Когда придёт следующая квитанция — отметьте, вернули ли деньги.</li>' +
        '</ol></details>';
      html += '<footer><p>Нормы: Приложение № 1 к ПП РФ № 354, проверены ' + esc(me.normsCheckedAt.split('-').reverse().join('.')) +
        '. Расчёт ориентировочный, итог считает УК.</p><button id="delme">Удалить все мои данные</button><div id="delBox"></div></footer>';
      root.innerHTML = html;
      $('report').onclick = function () { location.hash = me.houses.length ? '#report' : '#addhouse/report'; };
      $('addHouse').onclick = function () { location.hash = '#addhouse'; };
      each('.case', function (el) { el.onclick = function () { location.hash = '#case/' + el.getAttribute('data-id'); }; });
      each('.house', function (el) { el.onclick = function (e) { if (e.target.tagName !== 'A') location.hash = '#house/' + el.getAttribute('data-id'); }; });
      $('delme').onclick = function () { askDeleteAll(cases.length); };
    }).catch(function (e) { showError(e.message, renderHome); });
  }

  function houseRow(h) {
    var i = h.info || {};
    var tel = telHref(i.adsPhone);
    return '<li><div class="house" data-id="' + h.id + '" role="button" tabindex="0">' +
      '<span class="title">🏠 ' + esc(h.address) + (h.entrance ? ', подъезд ' + esc(h.entrance) : '') + (h.flat ? ', кв. ' + esc(h.flat) : '') + '</span>' +
      '<span class="meta">' + (i.ukName ? 'УК: ' + esc(i.ukName) : infoFilled(i) ? 'Данные дома заполнены не полностью' : 'Данные дома не заполнены') + ' · ' + esc(membersText(h.members)) + '</span>' +
      (i.adsPhone ? (tel ? '<a class="phone" href="' + esc(tel) + '">📞 Аварийная служба: ' + esc(i.adsPhone) + '</a>' : '<span class="meta">Аварийная служба: ' + esc(i.adsPhone) + '</span>') : '') +
      '</div></li>';
  }
  function infoFilled(i) { return Object.keys(i || {}).some(function (k) { return k !== 'updatedAt' && k !== 'updatedBy' && i[k]; }); }
  function membersText(n) { return n > 1 ? 'в сети ' + n + ' ' + plural(n, ['житель', 'жителя', 'жителей']) : 'в сети пока только вы'; }

  function caseRow(c) {
    var sum = c.status === 'refunded' ? (c.refundAmount ? rub(c.refundAmount) : 'сумма не указана') : c.estimate > 0 ? '≈ ' + rub(c.estimate) : '';
    return '<li><button class="case" data-id="' + c.id + '" data-tone="' + (TONE[c.status] || '') + '">' +
      '<span class="title">' + (SERVICE_ICON[c.service] || '') + ' ' + esc(c.serviceButton || c.serviceTitle) + '</span>' +
      '<span class="amount">' + esc(sum) + '</span>' +
      '<span class="meta">' + esc(c.address) + ' · с ' + esc(when(c.startedAt, c.tz)) + '</span>' +
      '<span class="status">' + esc(c.statusTitle) + (c.demo ? '<span class="demo-tag">демо</span>' : '') + '</span>' +
      '</button></li>';
  }

  /** Удаление всего — необратимо, поэтому второе подтверждение на экране, а не одно системное окно. */
  function askDeleteAll(nCases) {
    var box = $('delBox');
    box.innerHTML = '<div class="confirm-box"><p><b>Удалить всё?</b> Адреса (' + me.houses.length + '), дела (' + nCases + '), ФИО и заявления удалятся навсегда. Отменить будет нельзя.</p>' +
      '<div class="actions"><button class="btn danger-fill" id="delYes">Да, удалить всё</button><button class="btn" id="delNo">Отмена</button></div></div>';
    $('delNo').onclick = function () { box.innerHTML = ''; };
    $('delYes').onclick = function () {
      api('DELETE', '/api/me').then(function () { toast('Все ваши данные удалены'); renderHome(); }).catch(function (e) { toast(e.message); });
    };
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---------- добавить адрес: город кнопками, дом из списка ----------
  function normCity(s) { return String(s).toLowerCase().replace(/ё/g, 'е').replace(/^\s*(г\.|гор\.|город)\s*/, '').replace(/\s+/g, ' ').trim(); }

  function renderAddHouse(next) {
    if (!me) { loadMe().then(function () { renderAddHouse(next); }).catch(function (e) { toast(e.message); }); return; }
    var cities = me.cities || [];
    // Свой город подставляем сразу; новому жителю — выбрать кнопкой: подставленная «Москва» незаметно
    // записала бы дом не в тот город.
    var cityName = (me.myCities && me.myCities[0]) || '';
    var html = backLink('Назад', '') + '<h1>Добавить адрес</h1>' +
      (next === 'report' ? '<p class="note">Сначала добавьте адрес — потом сразу перейдём к проблеме.</p>' : '') +
      '<label>Город</label><div id="cityBox"></div>' +
      '<label for="q">Улица и номер дома</label><input id="q" autocomplete="off" placeholder="Например: Садовая 10">' +
      '<p class="muted hint" id="searchHint">Выберите свой дом из списка — так вы окажетесь в одной сети с соседями. Нет в списке — вы первый, добавьте его.</p>' +
      '<ul class="results" id="results"></ul>' +
      '<div id="pick" hidden><p class="picked" id="picked"></p>' +
      '<div class="row2"><div><label for="entrance">Подъезд</label><input id="entrance" maxlength="4" placeholder="2 или 2А"></div>' +
      '<div><label for="flat">Квартира</label><input id="flat" maxlength="10" placeholder="Например 15"></div></div>' +
      '<p class="muted hint">Необязательно. Квартира нужна для заявлений — только вам.</p>' +
      '<div class="actions"><button class="btn primary" id="add">Добавить</button></div></div>';
    root.innerHTML = html;
    bindBack();
    var chosen = null;
    var timer = null;
    var cityTimer = null;
    var q = $('q');

    // Город входит в адрес: «Садовая 10» в Москве и в Казани — разные дома.
    function drawCity() {
      var box = $('cityBox');
      if (cityName) {
        box.innerHTML = '<div class="picked-row"><span class="picked">🏙 ' + esc(cityName) + '</span><button class="linklike" id="cityChange">Изменить</button></div>';
        $('cityChange').onclick = function () { cityName = ''; drawCity(); $('cityQ').focus(); };
        q.disabled = false;
        q.placeholder = 'Например: Садовая 10';
        q.oninput();
        return;
      }
      box.innerHTML = '<div class="chips">' + cities.slice(0, 6).map(function (c) { return '<button class="chip" data-city="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>' +
        '<input id="cityQ" autocomplete="off" placeholder="Другой город — начните вводить">' +
        '<ul class="results" id="cityResults"></ul>';
      q.disabled = true;
      q.placeholder = 'Сначала выберите город';
      $('results').innerHTML = '';
      $('pick').hidden = true;
      each('#cityBox .chip', function (b) { b.onclick = function () { pickCity(b.getAttribute('data-city')); }; });
      $('cityQ').oninput = function () {
        clearTimeout(cityTimer);
        var t = $('cityQ').value.trim();
        var n = normCity(t);
        if (n.length < 2) { $('cityResults').innerHTML = ''; return; }
        var found = cities.filter(function (c) { return normCity(c).indexOf(n) === 0; }).slice(0, 5);
        drawCityResults(found, null, null);
        // Сервер знает сокращения («Питер») и ловит опечатки («Масква»).
        cityTimer = setTimeout(function () {
          api('GET', '/api/cities/check?q=' + encodeURIComponent(t)).then(function (r) {
            if ($('cityQ') && $('cityQ').value.trim() === t) drawCityResults(found, r, t);
          }).catch(function () {});
        }, 300);
      };
    }
    function drawCityResults(found, check, typed) {
      var items = [];
      if (check && check.suggestion && found.indexOf(check.suggestion) < 0) items.push('<li><button class="result" data-city="' + esc(check.suggestion) + '">🏙 Возможно, «' + esc(check.suggestion) + '»?</button></li>');
      if (check && check.inList && found.indexOf(check.name) < 0) found = [check.name].concat(found);
      found.forEach(function (c) { items.push('<li><button class="result" data-city="' + esc(c) + '">🏙 ' + esc(c) + '</button></li>'); });
      // Похоже на опечатку («Масква») — не предлагаем завести «новый город».
      if (check && check.name && !check.inList && !check.suggestion) items.push('<li><button class="result new" data-city="' + esc(check.name) + '">➕ Другой город: «' + esc(check.name) + '»</button></li>');
      if (check && !check.name && typed && !items.length) items.push('<li class="muted">Напишите название полностью — хотя бы четыре буквы</li>');
      $('cityResults').innerHTML = items.join('');
      each('#cityResults .result', function (b) { b.onclick = function () { pickCity(b.getAttribute('data-city')); }; });
    }
    function pickCity(name) {
      cityName = name.trim();
      drawCity();
      q.focus();
    }

    q.oninput = function () {
      clearTimeout(timer);
      chosen = null;
      $('pick').hidden = true;
      $('searchHint').hidden = false;
      var text = q.value.trim();
      if (!cityName) return;
      if (text.length < 2) { $('results').innerHTML = ''; return; }
      timer = setTimeout(function () {
        api('GET', '/api/houses/search?q=' + encodeURIComponent(text) + '&city=' + encodeURIComponent(cityName)).then(function (r) {
          var items = r.houses.map(function (h) {
            return '<li><button class="result" data-id="' + h.id + '" data-address="' + esc(h.address) + '">🏠 ' + esc(h.address) + '<small>' + (h.members ? ' · жителей в сети: ' + h.members : '') + '</small></button></li>';
          });
          // Дом с таким адресом уже в списке — «добавить новый» только запутает.
          if (/\d/.test(text) && !r.exactId) items.push('<li><button class="result new" data-new="1">➕ Моего дома нет — добавить «' + esc(cityName + ', ' + text) + '»</button></li>');
          $('results').innerHTML = items.join('') || '<li class="muted">Добавьте номер дома</li>';
          Array.prototype.forEach.call($('results').querySelectorAll('.result'), function (b) {
            b.onclick = function () {
              chosen = b.getAttribute('data-new') ? { address: text, city: cityName, label: cityName + ', ' + text } : { houseId: Number(b.getAttribute('data-id')), label: b.getAttribute('data-address') };
              $('picked').textContent = '📍 ' + chosen.label;
              $('pick').hidden = false;
              $('searchHint').hidden = true;
              $('results').innerHTML = '';
              $('entrance').focus();
            };
          });
        }).catch(function (e) { toast(e.message); });
      }, 250);
    };
    drawCity();
    if (cityName) q.focus();
    $('add').onclick = function () {
      if (!chosen) return;
      var done = busy($('add'), 'Добавляю…');
      var body = { entrance: $('entrance').value.trim() || undefined, flat: $('flat').value.trim() || undefined };
      if (chosen.houseId) body.houseId = chosen.houseId; else { body.address = chosen.address; body.city = chosen.city; }
      api('POST', '/api/me/houses', body).then(function (r) {
        haptic('success');
        track('app_house_added');
        toast(r.already ? (r.entranceChanged ? 'Этот адрес уже был в списке — подъезд обновил' : 'Этот адрес уже есть в вашем списке') : 'Адрес добавлен');
        location.hash = next === 'report' ? '#report/' + r.house.id : '#house/' + r.house.id;
      }).catch(function (e) { showErrors(e); }).then(done);
    };
  }

  // ---------- карточка дома: данные из квитанции ----------
  var INFO_FIELDS = [
    ['ukName', 'УК или ТСЖ — получатель за «содержание жилья»', 'Например: ООО «УК Пример»'],
    ['ukInn', 'ИНН УК', '10 цифр из квитанции', 'numeric'],
    ['adsPhone', 'Телефон аварийной службы', 'Например: +7 495 123-45-67', 'tel'],
    ['ukEmail', 'Почта УК — туда можно отправить заявление', 'Например: uk@example.ru', 'email'],
    ['ukAddress', 'Адрес УК — попадёт в заявление («куда»)', 'Город, улица, дом, офис'],
    ['rsoHeat', 'Кому платите за тепло и горячую воду', 'Например: АО «Теплосеть» или «УК»'],
    ['rsoWater', 'Кому платите за холодную воду и канализацию', 'Например: «Водоканал» или «УК»'],
    ['rsoPower', 'Кому платите за электричество', 'Например: «Мосэнергосбыт»'],
    ['rsoGas', 'Кому платите за газ', 'Например: «Мосгаз»'],
    ['rop', 'Кто вывозит мусор (региональный оператор)', 'Название из квитанции'],
    ['gji', 'Жилищная инспекция региона', 'Название, телефон или сайт']
  ];

  function renderHouse(id) {
    root.innerHTML = '<p class="state">Загружаю дом…</p>';
    api('GET', '/api/houses/' + id).then(function (r) {
      var h = r.house;
      var i = h.info || {};
      var html = backLink('Главная', '') + '<h1>🏠 ' + esc(h.address) + '</h1>' +
        '<p class="muted">' + (h.members > 1 ? 'В сети дома ' + h.members + ' ' + plural(h.members, ['житель', 'жителя', 'жителей']) + ' вместе с вами.' : 'В сети дома пока только вы. Позовите соседей: когда что-то отключат, я спрошу их «у вас тоже?», а вместе проще доказать.') + '</p>' +
        '<button class="btn primary" id="reportHere">🚨 Сообщить о проблеме в этом доме</button>';

      html += '<section class="sheet"><h2>Я и этот дом</h2>' +
        '<div class="row2"><div><label for="entrance">Подъезд</label><input id="entrance" maxlength="4" placeholder="2 или 2А" value="' + esc(h.entrance || '') + '"></div>' +
        '<div><label for="flat">Квартира</label><input id="flat" maxlength="10" value="' + esc(h.flat || '') + '"></div></div>' +
        '<label for="account">Лицевой счёт (из квитанции)</label><input id="account" maxlength="40" value="' + esc(h.account || '') + '">' +
        '<p class="muted hint">Квартира и лицевой счёт нужны только для ваших заявлений, соседи их не видят.</p>' +
        '<label for="notify">Писать мне, если у соседей отключат воду, свет или тепло</label><select id="notify"><option value="1"' + (h.notify ? ' selected' : '') + '>Да, писать</option><option value="0"' + (h.notify ? '' : ' selected') + '>Нет, не писать</option></select>' +
        (h.inviteLink ? '<label>Позовите соседей — чем больше в сети, тем проще доказать отключение</label><div class="copy"><input readonly id="invite" value="' + esc(h.inviteLink) + '"><button class="btn" id="copy">Копировать</button></div>' : '') +
        '</section>';

      html += '<section class="sheet"><h2>Данные дома <small>из квитанции</small></h2>' +
        '<p class="muted">Заполняют жители — один раз для всех соседей: эти данные попадут в заявления. Их видят и могут поправить все жители дома, поэтому сверяйте с квитанцией (или с <a href="' + GIS_HOUSES + '" data-ext>ГИС ЖКХ</a>).</p>' +
        // Главное — три поля; остальное свёрнуто, чтобы форма не пугала.
        INFO_FIELDS.slice(0, 3).map(infoField).join('') +
        '<details class="more"' + (INFO_FIELDS.slice(3).some(function (f) { return i[f[0]]; }) ? ' open' : '') + '><summary>Ещё: почта и адрес УК, поставщики, жилинспекция</summary>' +
        INFO_FIELDS.slice(3).map(infoField).join('') + '</details>' +
        '<p class="muted hint" id="infoStatus">' + (i.updatedAt ? 'Обновлено ' + esc(when(i.updatedAt)) : 'Изменения сохраняются сами, когда вы переходите к следующему полю.') + '</p>' +
        '<div class="actions"><button class="btn primary" id="saveInfo">Сохранить</button></div></section>';

      html += '<div class="actions"><button class="btn danger" id="remove">Убрать адрес из моего списка</button></div>';
      root.innerHTML = html;
      bindBack();
      each('a[data-ext]', openExternal);
      $('reportHere').onclick = function () { location.hash = '#report/' + h.id; };

      function infoField(f) {
        return '<label for="f_' + f[0] + '">' + esc(f[1]) + '</label><input id="f_' + f[0] + '" data-info="1"' + (f[3] ? ' inputmode="' + f[3] + '"' : '') + ' placeholder="' + esc(f[2]) + '" value="' + esc(i[f[0]] || '') + '">';
      }

      function patch(body) {
        return api('PATCH', '/api/me/houses/' + h.id, body).then(function () { clearErrors(); toast('Сохранено'); }).catch(function (e) { showErrors(e); });
      }
      $('entrance').onchange = function () { patch({ entrance: $('entrance').value.trim() || null }); };
      $('flat').onchange = function () { patch({ flat: $('flat').value.trim() || null }); };
      $('account').onchange = function () { patch({ account: $('account').value.trim() || null }); };
      $('notify').onchange = function () { patch({ notify: $('notify').value === '1' }); };
      if ($('copy')) $('copy').onclick = function () {
        var link = $('invite').value;
        (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { toast('Ссылка скопирована — отправьте её соседям'); }, function () { $('invite').select(); toast('Выделите и скопируйте ссылку'); });
      };
      // Данные дома сохраняются сами — ушли с экрана, не нажав «Сохранить», ничего не пропадёт.
      var saved = JSON.stringify(infoBody());
      function infoBody() { var b = {}; INFO_FIELDS.forEach(function (f) { b[f[0]] = $('f_' + f[0]).value.trim() || undefined; }); return b; }
      function saveInfo(btn) {
        var body = infoBody();
        var json = JSON.stringify(body);
        if (!btn && json === saved) return Promise.resolve();
        var done = btn ? busy(btn, 'Сохраняю…') : function () {};
        return api('PUT', '/api/houses/' + h.id + '/info', body).then(function (res) {
          saved = json;
          clearErrors();
          var info = (res.house && res.house.info) || {};
          $('infoStatus').textContent = '✓ Сохранено' + (info.updatedAt ? ' ' + when(info.updatedAt) : '');
          if (btn) { haptic('success'); track('app_house_info'); toast('Данные дома сохранены — они попадут в заявления соседей'); }
        }).catch(function (e) { showErrors(e, { ukInn: 'f_ukInn', ukEmail: 'f_ukEmail', adsPhone: 'f_adsPhone' }); }).then(done);
      }
      each('[data-info]', function (el) { el.addEventListener('change', function () { saveInfo(null); }); });
      $('saveInfo').onclick = function () { saveInfo($('saveInfo')); };
      $('remove').onclick = function () {
        if (!confirm('Убрать «' + h.address + '» из вашего списка? Дела по этому адресу сохранятся.')) return;
        api('DELETE', '/api/me/houses/' + h.id).then(function () { toast('Адрес убран'); home(); }).catch(function (e) { toast(e.message); });
      };
    }).catch(function (e) { showError(e.message, function () { renderHouse(id); }); });
  }

  // ---------- сообщить о проблеме ----------
  function renderReport(houseId) {
    // Список адресов всегда свежий: его могли только что изменить на другом экране.
    loadMe().then(function () {
      if (!me.houses.length) { location.hash = '#addhouse/report'; return; }
      var preset = me.houses.filter(function (h) { return h.id === houseId; })[0];
      var st = { houseId: preset ? preset.id : me.houses.length === 1 ? me.houses[0].id : null, service: null };
      var html = backLink('Главная', '') + '<h1>Что случилось?</h1>';
      html += '<label>Где</label><div class="chips" id="houses">' + me.houses.map(function (h) {
        return '<button class="chip' + (st.houseId === h.id ? ' on' : '') + '" data-id="' + h.id + '">📍 ' + esc(h.address) + '</button>';
      }).join('') + '</div>' +
        '<p class="hint warn" id="whereHint" hidden>👆 Выберите адрес, где случилось</p>';
      html += '<label>Что</label><div class="grid" id="services">' + me.services.map(function (s) {
        return '<button class="tile" data-key="' + s.key + '" aria-label="' + esc(s.button) + '">' + (SERVICE_ICON[s.key] || '') + '<span>' + esc(s.button) + '</span></button>';
      }).join('') + '</div><p class="desc" id="serviceDesc" hidden></p>';
      html += '<div id="details" hidden>' +
        '<div id="extra"></div>' +
        '<section class="sheet"><h2>📞 Аварийная служба</h2><p id="adsHint" class="muted"></p>' +
        '<label><input type="radio" name="ev" value="ads" checked> Дозвонились — есть номер заявки</label>' +
        '<label><input type="radio" name="ev" value="written"> Написали обращение (Госуслуги Дом, ГИС ЖКХ)</label>' +
        '<label><input type="radio" name="ev" value="self"> Не дозвонились — докажу актом с соседями</label>' +
        '<div id="numberBox"><label for="number" id="numberLabel">Номер заявки</label><input id="number" maxlength="60"></div>' +
        '<label for="started" id="startedLabel">Когда позвонили в аварийную службу</label><input id="started" type="datetime-local" value="' + localNow() + '">' +
        '<p class="muted hint" id="startedHint"></p>' +
        '</section>' +
        '<div class="actions"><button class="btn primary" id="submit">Записать</button></div></div>';
      root.innerHTML = html;
      bindBack();

      function evidence() { return root.querySelector('input[name=ev]:checked').value; }
      function refreshEvidence() {
        var ev = evidence();
        $('numberBox').hidden = ev === 'self';
        $('numberLabel').textContent = ev === 'written' ? 'Номер обращения' : 'Номер заявки';
        // По закону нарушение считается с момента сообщения в аварийную службу — поэтому спрашиваем время звонка.
        if (ev === 'ads') {
          $('startedLabel').textContent = 'Когда позвонили в аварийную службу';
          $('startedHint').textContent = 'По закону нарушение считается с момента звонка — укажите время звонка.';
        } else if (ev === 'written') {
          $('startedLabel').textContent = 'Когда отправили обращение';
          $('startedHint').textContent = 'По закону нарушение считается с момента обращения.';
        } else {
          $('startedLabel').textContent = START_LABEL[st.service] || 'Когда отключили';
          $('startedHint').textContent = 'Время подтвердит акт с соседями — его подготовлю после.';
        }
      }

      function refresh() {
        each('#houses .chip', function (b) { b.classList.toggle('on', Number(b.getAttribute('data-id')) === st.houseId); });
        each('#services .tile', function (b) { b.classList.toggle('on', b.getAttribute('data-key') === st.service); });
        $('whereHint').hidden = !(st.service && !st.houseId);
        $('serviceDesc').hidden = !st.service;
        if (st.service) $('serviceDesc').innerHTML = nb(SERVICE_DESC[st.service] || '');
        var wasHidden = $('details').hidden;
        $('details').hidden = !(st.houseId && st.service);
        // Продолжение формы ниже экрана — прокручиваем, чтобы было видно, что делать дальше.
        if (wasHidden && !$('details').hidden) setTimeout(function () { $('details').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
        if (!st.service) return;
        var s = me.services.filter(function (x) { return x.key === st.service; })[0];
        var h = me.houses.filter(function (x) { return x.id === st.houseId; })[0];
        var extra = '';
        if (st.service === 'hot_water_off') {
          extra = '<label><input type="checkbox" id="planned"> Отключили по плану (летом, с объявлением)</label>' +
            '<p class="muted hint" id="plannedHint" hidden>Плановое летнее отключение законно — снижения платы за него не будет. Отключили дольше объявленного или без объявления — снимите галочку.</p>';
        }
        if (st.service === 'electricity_off') {
          extra = '<label for="variant">В доме есть лифт или больше 9 этажей?</label><select id="variant"><option value="one_source">Нет или не знаю</option><option value="two_sources">Да</option></select>' +
            '<p class="muted hint">У таких домов обычно два ввода электричества, и без света можно быть не больше 2 часов в месяц, у остальных — 24 часа. Не знаете — посчитаю по минимуму, УК уточнит.</p>';
        }
        if (s && s.kind !== 'interruption') {
          extra = (st.service === 'heating_temp' ? '<label for="corner">Комната</label><select id="corner"><option value="0">Обычная — норма +18 °C</option><option value="1">Угловая (две стены на улицу) — норма +20 °C</option></select>' : '') +
            '<label for="temp">🌡 Сколько градусов показал термометр</label><input id="temp" inputmode="decimal" placeholder="Например: 16">' +
            '<p class="muted hint">' + (st.service === 'heating_temp' ? 'Меряйте в центре комнаты, на высоте около 1 м, вдали от окон и батарей.' : 'Меряйте воду из крана после того, как она стечёт 3 минуты.') + '</p>';
        }
        // Межсезонье: если отопление ещё не включали по графику, денег не будет — говорим сразу.
        var m = new Date().getMonth() + 1;
        if ((st.service === 'heating_temp' || st.service === 'heating_off') && m >= 5 && m <= 9) {
          extra += '<p class="note">Сейчас межсезонье. Если отопление в городе ещё не включали по графику, снижения платы не будет — проверьте объявление УК.</p>';
        }
        $('extra').innerHTML = extra ? '<section class="sheet">' + extra + '</section>' : '';
        if ($('planned')) $('planned').onchange = function () { $('plannedHint').hidden = !$('planned').checked; };
        var phone = h && h.info && h.info.adsPhone;
        $('adsHint').innerHTML = phone && telHref(phone)
          ? 'Позвоните: <a href="' + esc(telHref(phone)) + '">' + esc(phone) + '</a>. Скажите адрес и что случилось, запишите номер заявки — это главное доказательство.'
          : 'Телефон есть в квитанции. Скажите адрес и что случилось, запишите номер заявки — это главное доказательство.';
        refreshEvidence();
      }
      each('#houses .chip', function (b) { b.onclick = function () { st.houseId = Number(b.getAttribute('data-id')); refresh(); }; });
      each('#services .tile', function (b) { b.onclick = function () { st.service = b.getAttribute('data-key'); refresh(); }; });
      each('input[name=ev]', function (r) { r.onchange = refreshEvidence; });
      refresh();

      $('submit').onclick = function () {
        var ev = evidence();
        var body = {
          houseId: st.houseId,
          service: st.service,
          evidence: ev,
          number: $('number').value.trim() || null,
          startedAt: $('started').value ? new Date($('started').value).toISOString() : null,
          temp: $('temp') ? $('temp').value.trim() : undefined,
          corner: $('corner') ? $('corner').value === '1' : false,
          variant: $('variant') ? $('variant').value : undefined,
          planned: $('planned') ? $('planned').checked : false
        };
        if (!body.startedAt) { showErrors(fieldErr('started', 'Укажите дату и время')); return; }
        if (ev !== 'self' && !body.number) { showErrors(fieldErr('number', ev === 'written' ? 'Впишите номер обращения' : 'Впишите номер заявки или выберите «Не дозвонились»')); return; }
        if ($('temp') && !body.temp) { showErrors(fieldErr('temp', 'Впишите, сколько градусов показал термометр')); return; }
        var done = busy($('submit'), 'Записываю…');
        api('POST', '/api/report', body).then(function (r) {
          haptic('success');
          track('app_report');
          // Честно говорим, что произошло: новое дело, уже записанное или присоединение к соседям.
          if (r.outcome === 'existing') toast('Это у вас уже записано — открыл ваше дело.' + (r.numberSaved ? ' Номер заявки добавил.' : ''));
          else if (r.outcome === 'joined') toast('Соседи уже сообщили об этом — вы присоединились к их делу.' + (r.numberSaved ? ' Ваш номер заявки сохранён.' : ''));
          else toast(r.neighbours > 0 && r.botConnected ? 'Записал. Спрошу соседей в сети: «у вас тоже?»' : 'Записал. Позовите соседей — вместе проще доказать.');
          location.hash = '#case/' + r.caseId;
        }).catch(function (e) { showErrors(e); }).then(done);
      };
    }).catch(function (e) { showError(e.message, function () { renderReport(houseId); }); });
  }

  // ---------- дело ----------
  function renderCase(id, focusShare) {
    root.innerHTML = '<p class="state">Загружаю…</p>';
    api('GET', '/api/cases/' + id).then(function (data) {
      var c = data.case;
      var hint = data.executorHint;
      // Получатель из карточки дома — если заявление ещё не выдавали (выданное не переписываем задним числом).
      if (hint && c.status === 'ended' && !(c.claim && c.claim.executor)) {
        c.claim = c.claim || {};
        c.claim.executor = hint.name;
        c.claim.executorInn = c.claim.executorInn || hint.inn || '';
        c.claim.executorType = hint.type;
      }
      var person = data.personHint;
      if (person && !(c.claim && c.claim.fio)) {
        c.claim = c.claim || {};
        c.claim.fio = person.fio || '';
        c.claim.flat = c.claim.flat || person.flat || '';
        c.claim.account = c.claim.account || person.account || '';
      }
      c.savedPersonal = !!data.savedPersonal;
      c.contacts = data.houseContacts || {};
      c.signer = data.actSigner;
      var open = c.status === 'tracking' || c.status === 'ended' || c.status === 'claim_ready';
      var temp = c.kind !== 'interruption';

      var html = backLink('Главная', '');
      html += '<h1>' + (SERVICE_ICON[c.service] || '') + ' ' + esc(c.serviceButton || c.serviceTitle) + '</h1>';
      html += '<p class="muted">' + esc(c.address) + ' · ' + esc(c.statusTitle) + (c.demo ? ' <span class="demo-tag">демо-данные</span>' : '') + '</p>';

      if (c.status === 'tracking') {
        html += '<section class="sheet"><h2>' + esc(END_TITLE[c.service] || 'Починили?') + '</h2><label for="ended">Когда</label><input id="ended" type="datetime-local" value="' + localNow() + '">' +
          '<div class="actions"><button class="btn primary" id="endBtn">' + esc(END_BUTTON[c.service] || '✅ Починили — посчитать деньги') + '</button></div>' +
          '<p class="muted hint">' + (c.evidence === 'ads' ? 'Позвоните в аварийную службу и скажите, что починили, — так фиксируется время окончания.' : c.evidence === 'written' ? 'Допишите в обращение, когда починили.' : 'Запишите время — оно попадёт в заявление.') + '</p></section>';
        if (temp) {
          html += '<section class="sheet"><h2>🌡 Новый замер</h2><p class="muted hint">' + (c.service === 'heating_temp' ? 'Холодно' : 'Вода еле тёплая') + ' несколько дней — меряйте хотя бы раз в день: каждый замер — ещё одно доказательство.</p>' +
            '<div class="row2"><div><label for="newTemp">Градусы</label><input id="newTemp" inputmode="decimal" placeholder="Например: 16"></div>' +
            '<div><label for="newTempAt">Когда</label><input id="newTempAt" type="datetime-local" value="' + localNow() + '"></div></div>' +
            '<div class="actions"><button class="btn" id="addReading">Записать замер</button></div></section>';
        }
      }
      if (c.status === 'ended' || c.status === 'closed') {
        html += '<div class="actions"><button class="btn" id="reopen">↩️ Ещё не починили — вернуть в отслеживание</button></div>';
      }

      html += moneySection(c);
      if (c.endedAt && (c.status === 'ended' || c.status === 'claim_ready' || c.status === 'refused')) html += claimForm(c);
      if (c.status === 'claim_ready') html += nextSteps(c);
      if (c.status === 'refused') html += escalationSection(c);
      if (c.status === 'refunded') html += refundedSection(c);
      if (open && (c.evidence === 'self' || c.inspection === 'no_show' || (c.act && c.act.mine))) html += actSection(c);
      html += factsSection(c);

      html += '<div class="actions">';
      if (open) html += '<button class="btn" id="share">👥 Позвать соседей</button>';
      html += '<button class="linklike danger-link" id="deleteCase">🗑 Удалить дело</button></div>';
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

  /** Деньги: расчёт, плата из квитанции и сумма — в одном месте, сумма видна рядом с полем. */
  function moneySection(c) {
    if (!c.months.length) return '';
    var html = '<section class="sheet" id="money"><h2>Деньги</h2>';
    if (c.status === 'tracking') html += '<p class="muted">Пока не починили — считаю на сейчас: сумма растёт с каждым часом.</p>';
    html += '<ul class="formula">';
    c.months.forEach(function (m) {
      if (c.months.length > 1) html += '<li class="month">' + esc(monthTitle(m.month)) + '</li>';
      m.lines.forEach(function (l) { html += '<li>' + nb(l) + '</li>'; });
    });
    html += '</ul>';
    var paid = c.months.filter(function (m) { return m.percent > 0; });
    if (c.endedAt && paid.length && c.status !== 'refunded' && c.status !== 'closed') {
      paid.forEach(function (m) {
        var val = m.bill || m.billHint;
        html += '<label for="bill_' + m.month + '">Сколько начислено за ' + esc(BILL_NAME[c.service] || 'эту услугу') + ' за ' + esc(monthTitle(m.month)) + ', ₽</label>' +
          '<input id="bill_' + m.month + '" data-month="' + m.month + '" class="bill" inputmode="decimal" placeholder="Строка этой услуги в квитанции" value="' + (val ? String(val).replace('.', ',') : '') + '">' +
          (!m.bill && m.billHint ? '<p class="muted hint">Подставил из вашего другого дела за этот месяц — проверьте.</p>' : '');
      });
    }
    html += '<p class="total" id="liveTotal"' + (c.estimate > 0 ? '' : ' hidden') + '>Положено ≈ ' + rub(c.estimate) + '</p>' +
      '<p class="muted hint" id="liveNote"></p>' +
      '<p class="source muted">Источник: <a href="' + esc(c.basisUrl) + '" data-ext>' + esc(c.basis) + ' к ПП РФ № 354</a>. Итог считает УК.</p></section>';
    return html;
  }

  /** «Что записано»: факты, замеры и исправление времени. */
  function factsSection(c) {
    var canEditReadings = c.status === 'tracking' || c.status === 'ended' || c.status === 'closed';
    var startLabel = c.evidence === 'ads' ? 'Начало (звонок)' : c.evidence === 'written' ? 'Начало (обращение)' : 'Начало';
    var html = '<section class="sheet"><h2>Что записано</h2><dl class="facts">' +
      '<dt>' + startLabel + '</dt><dd class="num">' + esc(when(c.startedAt, c.tz)) + '</dd>' +
      '<dt>Окончание</dt><dd class="num">' + (c.endedAt ? esc(when(c.endedAt, c.tz)) : 'ещё не починили') + '</dd>' +
      '<dt>Доказательство</dt><dd>' + esc(evidenceText(c)) + '</dd>' +
      (c.readings.length ? '<dt>Замеры</dt><dd class="num">' + c.readings.map(function (r) {
        return '<span class="reading">' + esc(when(r.at, c.tz)) + ': +' + String(r.tempC).replace('.', ',') + '&nbsp;°C' +
          (canEditReadings ? ' <button class="reading-del" data-reading="' + r.id + '" aria-label="Удалить замер">✕</button>' : '') + '</span>';
      }).join('') + '</dd>' : '') +
      (c.neighbours > 0 ? '<dt>Соседи</dt><dd>' + c.neighbours + '</dd>' : '') +
      (c.inspection ? '<dt>Проверка</dt><dd>' + esc(INSPECTION[c.inspection] || '') + '</dd>' : '') +
      (c.act ? '<dt>Акт</dt><dd>' + esc(ACT_STATUS[c.act.status] || '') + '</dd>' : '') +
      (c.photos > 0 ? '<dt>Фото</dt><dd class="num">' + c.photos + '</dd>' : '') +
      '</dl>';
    if (c.status !== 'refunded') {
      html += '<button class="linklike" id="editTimes">✏️ Исправить время</button>' +
        '<div id="timesBox" hidden><label for="editStart">' + startLabel + '</label><input id="editStart" type="datetime-local" value="' + toLocalInput(c.startedAt) + '">' +
        (c.endedAt ? '<label for="editEnd">Окончание</label><input id="editEnd" type="datetime-local" value="' + toLocalInput(c.endedAt) + '">' : '') +
        '<p class="muted hint">Меняется только в вашем деле, у соседей время остаётся прежним.</p>' +
        '<div class="actions"><button class="btn primary" id="saveTimes">Сохранить время</button></div></div>';
    }
    return html + '</section>';
  }

  /** Акт с соседями: доказательство, если нет номера заявки или УК не пришла на замер. */
  function actSection(c) {
    var a = c.act;
    var claimExists = c.status === 'claim_ready' || c.status === 'refused' || c.status === 'refunded';
    var html = '<section class="sheet"><h2>📄 Акт с соседями <small>доказательство</small></h2>';
    if (a && a.status === 'signed') {
      return html + '<p>✅ Акт подписан ' + (a.chair ? 'жителями и председателем совета дома' : 'жителями') + '. ' + (claimExists ? 'Он указан в приложениях к заявлению — приложите его копию.' : 'Он попадёт в приложения к заявлению.') + '</p>' +
        '<div class="actions"><button class="btn" id="actPdf">📄 Акт (PDF)</button></div>' + (a.initiator ? '<button class="linklike" id="actUnsigned">Снять отметку «подписан»</button>' : '') + '</section>';
    }
    html += '<p class="muted hint">Акт доказывает, что услуги не было. Распечатайте его и попросите расписаться двух и более соседей и председателя совета дома. Потом акт прикладывают к заявлению.</p>';
    if (a && a.mine) {
      var s = c.signer || {};
      html += '<p>Вы в акте: <b>' + esc(s.fio || '') + '</b>' + (s.flat ? ', кв. ' + esc(s.flat) : '') + ' <button class="linklike" id="actEdit">✏️ Исправить</button></p>' +
        '<div id="actEditBox" hidden><label for="actFio">Ваши ФИО</label><input id="actFio" autocomplete="name" value="' + esc(s.fio || '') + '">' +
        '<label for="actFlat">Квартира</label><input id="actFlat" maxlength="10" value="' + esc(s.flat || '') + '">' +
        '<div class="actions"><button class="btn" id="actSave">Сохранить и скачать акт</button></div></div>' +
        '<div class="actions"><button class="btn" id="actPdf">📄 Акт для подписи (PDF)</button></div>';
      if (a.initiator) {
        html += '<label><input type="checkbox" id="actChair"> Председатель совета дома тоже подписал</label>' +
          '<p class="muted hint">Совета дома нет или председатель отказался — галочку не ставьте, но всё равно отметьте «Соседи подписали»: подписи соседей тоже доказательство.</p>' +
          '<div class="actions"><button class="btn primary" id="actSigned">✅ Соседи подписали — акт готов</button></div>';
      }
      return html + '</section>';
    }
    var cl = c.claim || {};
    return html + '<p class="muted hint">Фамилия и имя обязательны: без них подпись в акте не засчитают.</p>' +
      '<label for="actFio">Ваши ФИО</label><input id="actFio" autocomplete="name" value="' + esc(cl.fio || '') + '">' +
      '<label for="actFlat">Квартира</label><input id="actFlat" maxlength="10" value="' + esc(cl.flat || '') + '">' +
      '<div class="actions"><button class="btn primary" id="actPdf">📄 Получить акт для подписи (PDF)</button></div></section>';
  }

  function claimForm(c) {
    var cl = c.claim || {};
    var opt = function (v, t) { return '<option value="' + v + '"' + (cl.executorType === v ? ' selected' : '') + '>' + t + '</option>'; };
    var s = c.signer;
    var mismatch = s && s.signed && cl.fio && (cl.fio.trim() !== (s.fio || '').trim() || (cl.flat || '') !== (s.flat || ''));
    return '<section class="sheet"><h2>Заявление на перерасчёт</h2>' +
      '<p class="muted hint">💰 Заявление — требование вернуть деньги. Подписываете вы. Акт с соседями, если есть, прикладывается к нему.</p>' +
      '<label for="executor">Кому подаёте — кому платите за эту услугу</label><input id="executor" autocomplete="off" value="' + esc(cl.executor || '') + '" placeholder="Например: ООО «УК Пример»">' +
      '<p class="muted hint">В квитанции найдите строку этой услуги — рядом указан получатель платежа. За тепло и горячую воду часто платят ресурсоснабжающей организации (например, «Теплосеть»), за остальное — УК. Не уверены — пишите УК.</p>' +
      '<label for="etype">Кто это</label><select id="etype">' + opt('uk', 'УК или ТСЖ') + opt('rso', 'Ресурсоснабжающая организация') + opt('rop', 'Вывоз мусора (региональный оператор)') + opt('unknown', 'Не знаю') + '</select>' +
      '<label for="inn">ИНН получателя</label><input id="inn" inputmode="numeric" value="' + esc(cl.executorInn || '') + '" placeholder="10 цифр из квитанции">' +
      '<label for="fio">Ваши ФИО</label><input id="fio" autocomplete="name" value="' + esc(cl.fio || '') + '">' +
      (mismatch ? '<p class="note warn">В подписанном акте вы — ' + esc(s.fio) + (s.flat ? ', кв. ' + esc(s.flat) : '') + '. В заявлении должно быть так же.</p>' : '') +
      '<div class="row2"><div><label for="flat">Квартира</label><input id="flat" value="' + esc(cl.flat || '') + '"></div>' +
      '<div><label for="account">Лицевой счёт</label><input id="account" value="' + esc(cl.account || '') + '"></div></div>' +
      '<p class="muted hint">Пустые поля можно вписать от руки после печати.</p>' +
      '<label><input type="checkbox" id="remember"' + (c.savedPersonal ? ' checked' : '') + '> Запомнить ФИО, квартиру и лицевой счёт для следующих заявлений по этому адресу</label>' +
      '<div class="actions"><button class="btn primary" id="pdf">📄 ' + (c.status === 'ended' ? 'Скачать заявление (PDF)' : 'Скачать заявление ещё раз') + '</button>' +
      '<button class="btn" id="scan" type="button">📷 Заполнить из QR квитанции</button></div>' +
      '<p class="muted hint">Подавать тому, кому адресовано заявление: лично (два экземпляра) или через «Госуслуги Дом» / ГИС ЖКХ с PDF во вложении.</p>' +
      '</section>';
  }

  /** Куда нести заявление — той организации, что в шапке, а не всегда в УК. */
  function whereToSubmit(c) {
    var cl = c.claim || {};
    var k = c.contacts || {};
    var toUk = cl.executorType === 'uk' || (k.ukName && cl.executor && cl.executor.trim() === k.ukName.trim());
    var who = cl.executor ? esc(cl.executor) : 'исполнителю';
    var parts = [];
    if (toUk && k.ukAddress) parts.push('адрес: ' + esc(k.ukAddress));
    if (toUk && k.ukEmail) parts.push('почта: <a href="mailto:' + esc(k.ukEmail) + '">' + esc(k.ukEmail) + '</a>');
    return '<p><b>1. Подайте заявление ' + who + '.</b> Лично — два экземпляра, на своём попросите отметку о приёме. Или через «Госуслуги Дом» / ГИС ЖКХ — PDF во вложении.' +
      (parts.length ? ' ' + parts.join(', ') + '.' : (cl.executor ? ' Адрес и почту ищите в квитанции — рядом с получателем платежа.' : ' Получатель в шапке не указан — впишите его от руки: кому платите за эту услугу по квитанции.')) + '</p>';
  }

  function submittedForm(c) {
    var cl = c.claim || {};
    if (cl.submittedAt) {
      return '<p class="done">✓ Подано ' + esc(day(cl.submittedAt, c.tz)) + (cl.incomingNumber ? ', вх. № ' + esc(cl.incomingNumber) : '') + ' <button class="linklike" id="subEdit">Изменить</button></p>' +
        '<div id="subBox" hidden>' + submittedFields(cl, c) + '</div>';
    }
    return submittedFields(cl, c);
  }
  function submittedFields(cl, c) {
    return '<div class="row2"><div><label for="submittedAt">Когда подали</label><input id="submittedAt" type="date" max="' + today() + '" value="' + (cl.submittedAt ? toLocalInput(cl.submittedAt).slice(0, 10) : '') + '"></div>' +
      '<div><label for="incoming">Входящий номер</label><input id="incoming" maxlength="40" value="' + esc(cl.incomingNumber || '') + '" placeholder="Если дали"></div></div>' +
      '<div class="actions"><button class="btn" id="saveSubmitted">Сохранить</button></div>';
  }

  /** «Не сделали» можно отметить, только когда пришла квитанция за следующий месяц после подачи. */
  function receiptReadyMonth(c) {
    var cl = c.claim || {};
    var base = cl.submittedAt || cl.createdAt || new Date().toISOString();
    return nextMonth(monthKeyOf(base));
  }

  function nextSteps(c) {
    var ready = receiptReadyMonth(c);
    var early = monthKeyOf(new Date().toISOString()) < ready;
    var cl = c.claim || {};
    var base = cl.submittedAt || cl.createdAt || new Date().toISOString();
    return '<section class="sheet"><h2>Что дальше</h2>' + whereToSubmit(c) +
      '<p><b>2. Отметьте, когда подали</b> — дата и входящий номер попадут в документы, если деньги не вернут.</p>' + submittedForm(c) +
      '<p class="step3"><b>3. Проверьте квитанцию за ' + esc(monthTitle(monthKeyOf(base))) + '</b> (придёт в начале следующего месяца) и отметьте, сделали ли перерасчёт.</p>' +
      '<label for="refundAmount">Сколько вернули по квитанции, ₽ (если знаете)</label><input id="refundAmount" inputmode="decimal" placeholder="Например: 115,20">' +
      '<div class="actions"><button class="btn primary" id="refundYes">✅ Перерасчёт сделали</button>' +
      '<button class="btn" id="refundNo"' + (early ? ' disabled' : '') + '>❌ Не сделали</button></div>' +
      (early ? '<p class="muted hint">«Не сделали» можно отметить, когда придёт квитанция — не раньше начала ' + esc(MONTHS_GEN[Number(ready.split('-')[1]) - 1]) + '.</p>' : '') +
      '</section>';
  }

  function escalationButtons(c) {
    return '<div class="actions stack">' +
      '<button class="btn" data-esc="fine">💸 Требование: перерасчёт и штраф 50%</button>' +
      '<button class="btn" data-esc="gji">🏛 Жалоба в жилищную инспекцию</button>' +
      '<button class="btn" data-esc="ozpp">⚖️ Заявление в общество защиты прав потребителей</button></div>' +
      (c.estimate > 0 && c.estimate < 1000 ? '<p class="muted hint">Общество защиты прав потребителей идёт в суд. При сумме меньше 1 000 ₽ это обычно не стоит усилий — начните с требования и жалобы, или объединитесь с соседями.</p>' : '');
  }

  /** Перерасчёт не сделали: документы, чтобы довести дело до денег. */
  function escalationSection(c) {
    var cl = c.claim || {};
    return '<section class="sheet"><h2>Перерасчёт не сделали — что дальше</h2>' +
      '<p class="muted hint">Сначала — требование к исполнителю: за нарушение порядка расчёта положен штраф 50%. Не помогло — жалоба в жилищную инспекцию.</p>' +
      (cl.submittedAt ? '' : '<p class="note">Укажите, когда подали заявление, — дата попадёт в документы.</p>' + submittedForm(c)) +
      escalationButtons(c) +
      '<h3>Всё-таки вернули?</h3><label for="refundAmount">Сколько вернули, ₽</label><input id="refundAmount" inputmode="decimal" placeholder="Например: 115,20">' +
      '<div class="actions"><button class="btn" id="refundYes">✅ Отметить, что вернули</button></div></section>';
  }

  function refundedSection(c) {
    var partial = c.refundAmount && c.estimate > 0 && c.refundAmount < c.estimate * 0.9;
    return '<section class="sheet"><h2>✅ Перерасчёт получен</h2>' +
      (c.refundAmount ? '<p class="total">Вернули ' + rub(c.refundAmount) + '</p>' : '<p>Сумма не указана — впишите её ниже, чтобы она попала в итог «Вернули».</p>') +
      (partial ? '<p class="muted hint">По расчёту положено ≈ ' + rub(c.estimate) + '. Остальное можно потребовать:</p>' + escalationButtons(c) : '') +
      '<details class="more"' + (c.refundAmount ? '' : ' open') + '><summary>Исправить сумму или снять отметку</summary>' +
      '<label for="refundAmount">Сколько вернули, ₽</label><input id="refundAmount" inputmode="decimal" value="' + (c.refundAmount ? String(c.refundAmount).replace('.', ',') : '') + '">' +
      '<div class="actions"><button class="btn" id="refundYes">Сохранить сумму</button></div>' +
      '<button class="linklike" id="refundUndo">Снять отметку «вернули»</button></details>' +
      '<div class="actions"><button class="btn" id="pdf">📄 Заявление (PDF)</button></div></section>';
  }

  function formValues() {
    var v = function (id) { var el = $(id); return el ? el.value.trim() : undefined; };
    var bills = {};
    each('.bill', function (el) { bills[el.getAttribute('data-month')] = el.value.trim(); });
    return { executor: v('executor'), executorInn: v('inn'), executorType: v('etype'), fio: v('fio'), flat: v('flat'), account: v('account'), bills: bills, remember: $('remember') ? $('remember').checked : undefined };
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

    // Сумма в рублях — сразу, пока житель вписывает начисление из квитанции.
    function liveTotal() {
      var t = $('liveTotal');
      if (!t) return;
      var sum = 0;
      var missing = [];
      c.months.forEach(function (m) {
        if (m.percent <= 0) return;
        var inp = $('bill_' + m.month);
        var bill = inp ? parseMoney(inp.value) : m.bill;
        if (bill > 0) sum += Math.round(bill * m.percent) / 100;
        else missing.push(monthTitle(m.month));
      });
      t.hidden = !(sum > 0);
      t.textContent = 'Положено ≈ ' + rub(Math.round(sum * 100) / 100) + (sum > 0 && missing.length ? ' — пока без ' + missing.join(', ') : '');
      var note = $('liveNote');
      if (note) {
        var anyInputs = !!root.querySelector('.bill');
        note.textContent = anyInputs && missing.length ? (sum > 0 ? 'Впишите плату за ' + missing.join(', ') + ' — сумма будет больше.' : 'Впишите плату из квитанции — покажу сумму в рублях.') : '';
        note.hidden = !note.textContent;
      }
    }
    each('.bill', function (el) { el.addEventListener('input', liveTotal); });
    liveTotal();

    var endBtn = $('endBtn');
    if (endBtn) endBtn.onclick = function () {
      if (!$('ended').value) { showErrors(fieldErr('ended', 'Укажите дату и время')); return; }
      var done = busy(endBtn, 'Считаю…');
      api('POST', '/api/cases/' + c.id + '/end', { endedAt: new Date($('ended').value).toISOString() }).then(function () {
        haptic('success');
        track('app_end');
        toast('Записал — ниже расчёт денег');
        renderCase(c.id);
      }).catch(function (e) { showErrors(e.fields ? e : fieldErr('ended', e.message)); done(); });
    };

    var readingBtn = $('addReading');
    if (readingBtn) readingBtn.onclick = function () {
      if (!$('newTemp').value.trim()) { showErrors(fieldErr('newTemp', 'Впишите, сколько градусов показал термометр')); return; }
      var done = busy(readingBtn, 'Записываю…');
      api('POST', '/api/cases/' + c.id + '/readings', { temp: $('newTemp').value.trim(), at: new Date($('newTempAt').value).toISOString() }).then(function (r) {
        haptic('success');
        toast(r.note || 'Замер записан');
        renderCase(c.id);
      }).catch(function (e) { showErrors(e); done(); });
    };
    each('.reading-del', function (b) {
      b.onclick = function () {
        if (!confirm('Удалить этот замер?')) return;
        api('DELETE', '/api/cases/' + c.id + '/readings/' + b.getAttribute('data-reading')).then(function () { toast('Замер удалён'); renderCase(c.id); }).catch(function (e) { toast(e.message); });
      };
    });

    var editBtn = $('editTimes');
    if (editBtn) editBtn.onclick = function () { $('timesBox').hidden = !$('timesBox').hidden; };
    var saveTimes = $('saveTimes');
    if (saveTimes) saveTimes.onclick = function () {
      var body = { startedAt: $('editStart').value ? new Date($('editStart').value).toISOString() : null };
      if ($('editEnd')) body.endedAt = $('editEnd').value ? new Date($('editEnd').value).toISOString() : null;
      var done = busy(saveTimes, 'Сохраняю…');
      api('PATCH', '/api/cases/' + c.id + '/times', body).then(function () {
        haptic('success');
        toast(c.endedAt ? 'Время исправлено — расчёт пересчитан' : 'Время исправлено');
        renderCase(c.id);
      }).catch(function (e) { showErrors(e); done(); });
    };

    var reopenBtn = $('reopen');
    if (reopenBtn) reopenBtn.onclick = function () {
      var done = busy(reopenBtn, 'Возвращаю…');
      api('POST', '/api/cases/' + c.id + '/reopen').then(function () {
        toast('Вернул в отслеживание — отметьте, когда действительно починят');
        renderCase(c.id);
      }).catch(function (e) { toast(e.message); done(); });
    };

    var delBtn = $('deleteCase');
    if (delBtn) delBtn.onclick = function () {
      var extra = c.status === 'refunded' && c.refundAmount ? ' Сумма ' + rub(c.refundAmount) + ' уйдёт из итога «Вернули».' : '';
      if (!confirm('Удалить это дело вместе с расчётом и заявлением? Отменить будет нельзя.' + extra)) return;
      api('DELETE', '/api/cases/' + c.id).then(function () { toast('Дело удалено'); home(); }).catch(function (e) { toast(e.message); });
    };

    function refund(action) {
      var amount = $('refundAmount') ? $('refundAmount').value.trim() : '';
      var n = parseMoney(amount);
      // Сумма сильно больше расчёта — скорее опечатка: переспрашиваем, прежде чем она уйдёт в итог.
      if (action === 'yes' && n !== null && c.estimate > 0 && n > Math.max(c.estimate * 3, c.estimate + 500)) {
        if (!confirm('Вы вписали ' + rub(n) + ', а по расчёту положено ≈ ' + rub(c.estimate) + '. Всё верно?')) return;
      }
      return api('POST', '/api/cases/' + c.id + '/receipt', { action: action, amount: amount }).then(function () {
        haptic('success');
        track('app_refund_' + action);
        toast(action === 'yes' ? (n ? 'Отлично! Записал: вернули ' + rub(n) : 'Записал, что вернули. Сумму можно вписать позже') : action === 'no' ? 'Понял. Ниже — документы, чтобы довести дело до денег' : 'Отметку сняли');
        renderCase(c.id);
      }).catch(function (e) { showErrors(e); });
    }
    if ($('refundYes')) $('refundYes').onclick = function () { refund('yes'); };
    if ($('refundNo')) $('refundNo').onclick = function () { refund('no'); };
    if ($('refundUndo')) $('refundUndo').onclick = function () { refund('undo'); };

    if ($('subEdit')) $('subEdit').onclick = function () { $('subBox').hidden = !$('subBox').hidden; };
    if ($('saveSubmitted')) $('saveSubmitted').onclick = function () {
      var btn = $('saveSubmitted');
      if (!$('submittedAt').value) { showErrors(fieldErr('submittedAt', 'Укажите дату подачи')); return; }
      var done = busy(btn, 'Сохраняю…');
      api('POST', '/api/cases/' + c.id + '/submitted', { date: $('submittedAt').value + 'T12:00:00', number: $('incoming').value.trim() || undefined }).then(function () {
        toast('Записал дату подачи');
        renderCase(c.id);
      }).catch(function (e) { showErrors(e); done(); });
    };

    each('[data-esc]', function (b) {
      b.onclick = function () {
        var done = busy(b, 'Готовлю документ…');
        api('POST', '/api/cases/' + c.id + '/escalation-link', { kind: b.getAttribute('data-esc') }).then(function (r) {
          track('app_escalation');
          return download(r.url, r.fileName).then(function () { toast('Документ скачивается — впишите пустые поля и отправьте'); });
        }).catch(function (e) { toast(e.message); }).then(done);
      };
    });

    var pdfBtn = $('pdf');
    if (pdfBtn) pdfBtn.onclick = function () {
      var done = busy(pdfBtn, 'Готовлю PDF…');
      (c.status === 'refunded' ? Promise.resolve() : save()).then(function () {
        clearErrors();
        return api('POST', '/api/cases/' + c.id + '/pdf-link');
      }).then(function (r) {
        track('app_pdf');
        return download(r.url, r.fileName).then(function () {
          toast('Заявление скачивается');
          // Статус дела сменился на «заявление готово» — показываем, что делать дальше.
          if (c.status === 'ended') setTimeout(function () { renderCase(c.id); }, 1200);
        });
      }).catch(function (e) { showErrors(e); }).then(done);
    };

    function getAct(fio, flat, btn, after) {
      var done = busy(btn, 'Готовлю акт…');
      api('POST', '/api/cases/' + c.id + '/act', { fio: fio, flat: flat || undefined }).then(function (r) {
        track('app_act');
        return download(r.url, r.fileName).then(function () {
          toast(c.act && c.act.status === 'signed' ? 'Акт скачивается' : 'Акт скачивается — распечатайте и соберите подписи');
          if (after) setTimeout(function () { renderCase(c.id); }, 1200);
        });
      }).catch(function (e) { showErrors(e, { fio: 'actFio' }); }).then(done);
    }
    function actFioValid() {
      var fio = $('actFio').value.trim();
      if (fio.split(/\s+/).length < 2 || /\d/.test(fio)) { showErrors(fieldErr('actFio', 'Фамилия и имя, например «Иванова Анна Петровна»')); return null; }
      return fio;
    }
    var actBtn = $('actPdf');
    if (actBtn) actBtn.onclick = function () {
      if (c.act && c.act.mine) { getAct((c.signer && c.signer.fio) || 'не указано', c.signer && c.signer.flat, actBtn, false); return; }
      var fio = actFioValid();
      if (fio) getAct(fio, $('actFlat').value.trim(), actBtn, true);
    };
    if ($('actEdit')) $('actEdit').onclick = function () { $('actEditBox').hidden = !$('actEditBox').hidden; };
    if ($('actSave')) $('actSave').onclick = function () {
      var fio = actFioValid();
      if (fio) getAct(fio, $('actFlat').value.trim(), $('actSave'), true);
    };

    var signedBtn = $('actSigned');
    if (signedBtn) signedBtn.onclick = function () {
      var done = busy(signedBtn, 'Сохраняю…');
      api('POST', '/api/cases/' + c.id + '/act/signed', { chair: $('actChair').checked }).then(function () {
        haptic('success');
        track('app_act_signed');
        toast('Акт подписан — он попадёт в ваше заявление');
        renderCase(c.id);
      }).catch(function (e) { toast(e.message); done(); });
    };
    var unsignBtn = $('actUnsigned');
    if (unsignBtn) unsignBtn.onclick = function () {
      api('POST', '/api/cases/' + c.id + '/act/unsigned').then(function () { toast('Отметку сняли'); renderCase(c.id); }).catch(function (e) { toast(e.message); });
    };

    var scanBtn = $('scan');
    if (scanBtn) scanBtn.onclick = function () {
      // Сканер — функция самого MAX: в обычном браузере его нет.
      if (!WebApp || !WebApp.openCodeReader || !initData) { toast('Сканер QR работает только в приложении MAX. Здесь впишите данные из квитанции вручную.'); return; }
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
        if (r.mid && WebApp && WebApp.shareMaxContent && initData) {
          // Бот уже прислал карточку в диалог; пересылаем её в домовой чат через нативный экран MAX.
          return Promise.resolve(WebApp.shareMaxContent({ mid: r.mid, chatType: 'DIALOG' })).then(function () { haptic('success'); });
        }
        if (r.link) return shareLink(r.link, r.text);
        toast(r.mid ? 'Карточка в чате с ботом — перешлите её соседям' : 'Бот не подключён — в демо-режиме ссылку для соседей не создать');
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
    if ((m = /^#report(?:\/(\d+))?$/.exec(h))) return renderReport(m[1] ? Number(m[1]) : null);
    renderHome();
  }

  if (!initData && !DEMO_USER) {
    root.innerHTML = '<h1>Вернём</h1><p>Это мини-приложение открывается из бота «Вернём» в MAX — кнопка «Открыть приложение» в меню бота.</p>';
    return;
  }
  window.addEventListener('hashchange', route);
  root.addEventListener('input', function (ev) {
    var el = ev.target;
    if (!el || !el.getAttribute || !el.getAttribute('aria-invalid')) return;
    el.removeAttribute('aria-invalid');
    var n = el.nextElementSibling;
    if (n && n.className === 'field-error') n.parentNode.removeChild(n);
  });
  var share = /^share_(\d+)$/.exec(startParam);
  var house = /^house_(\d+)$/.exec(startParam);
  if (share) { history.replaceState(null, '', '#case/' + share[1]); renderCase(Number(share[1]), true); }
  else if (house) { history.replaceState(null, '', '#house/' + house[1]); renderHouse(Number(house[1])); }
  else if (startParam === 'report') { history.replaceState(null, '', '#report'); renderReport(); }
  else route();
})();
