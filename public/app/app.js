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

  /** Линейные иконки 24×24, цвет — от текста: на всех телефонах одинаковые, в отличие от эмодзи. */
  var DROP = '<path d="M12 3.5s-6 6.8-6 10.8a6 6 0 0 0 12 0c0-4-6-10.8-6-10.8z"/>';
  // «Нет воды» — перечёркнутая капля и у горячей, и у холодной: отличает подпись («пар» мелко читался как «ő»).
  var ICON_PATHS = {
    hot_water_off: DROP + '<path d="M4 4l16 16"/>',
    hot_water_temp: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 17.5v-4"/>',
    heating_temp: '<path d="M12 3v18"/><path d="M4.2 7.5l15.6 9"/><path d="M19.8 7.5l-15.6 9"/><path d="M9.5 4.5 12 6l2.5-1.5"/><path d="M9.5 19.5 12 18l2.5 1.5"/>',
    heating_off: '<rect x="3.5" y="5" width="17" height="12" rx="2"/><path d="M8 5v12"/><path d="M12 5v12"/><path d="M16 5v12"/><path d="M6 17v3"/><path d="M18 17v3"/>',
    cold_water_off: DROP + '<path d="M4 4l16 16"/>',
    electricity_off: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    gas_off: '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-5 1-8.5z"/>',
    sewerage_off: '<path d="M6 3h4v8H6z"/><path d="M4.5 11h15"/><path d="M5.5 11c.5 3.5 3 6 7 6s6-2.5 6.5-6"/><path d="M10 16.5 9 21h7l-1-4.2"/>',
    waste_off: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    alert: '<path d="M12 4 2.5 20h19L12 4z"/><path d="M12 10v4.5"/><path d="M12 17.5h.01"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    home: '<path d="M3 11 12 4l9 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    check: '<path d="M5 12l5 5L20 7"/>',
    right: '<path d="M9 5l7 7-7 7"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M12 10v7"/><path d="M9 14l3 3 3-3"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14a6 6 0 0 1 3.5 6"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'
  };
  function icon(name, cls) { return '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICON_PATHS[name] || '') + '</svg>'; }
  /** Что значит каждая плитка — чтобы «Холодно в квартире» не путали с «Нет отопления». */
  var SERVICE_DESC = {
    hot_water_off: 'Из крана с горячей водой вода не идёт или идёт только холодная.',
    hot_water_temp: 'Горячая вода есть, но холоднее +57 °C (ночью — холоднее +55 °C).',
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
    // Первый замер записывается на это время — поэтому спрашиваем, когда мерили, как и в боте.
    hot_water_temp: 'Когда измерили температуру воды',
    heating_temp: 'Когда измерили температуру в комнате',
    sewerage_off: 'Когда начался засор',
    waste_off: 'С какого дня не вывозят мусор'
  };
  /** Кнопка «починили» — словами жителя, без «посчитать деньги»: её не должны нажимать раньше времени. */
  var END_NAME = {
    hot_water_off: 'Воду дали', cold_water_off: 'Воду дали', electricity_off: 'Свет дали', gas_off: 'Газ дали',
    heating_off: 'Отопление дали', sewerage_off: 'Канализацию починили', waste_off: 'Мусор вывезли',
    heating_temp: 'Стало тепло', hot_water_temp: 'Вода снова горячая'
  };
  var END_TITLE = {
    hot_water_off: 'Когда дадут воду — отметьте здесь', cold_water_off: 'Когда дадут воду — отметьте здесь',
    electricity_off: 'Когда дадут свет — отметьте здесь', gas_off: 'Когда дадут газ — отметьте здесь',
    heating_off: 'Когда дадут отопление — отметьте здесь', sewerage_off: 'Когда починят канализацию — отметьте здесь',
    waste_off: 'Когда вывезут мусор — отметьте здесь', heating_temp: 'Когда станет тепло — отметьте здесь',
    hot_water_temp: 'Когда вода станет горячей — отметьте здесь'
  };
  function endName(c) { return END_NAME[c.service] || 'Починили'; }
  /** «света не было» — для фраз в середине предложения. */
  function lackNow(c) { var t = LACK_NOW[c.service]; return t ? t.charAt(0).toLowerCase() + t.slice(1) : 'услуги нет'; }
  function lackWas(c) { var t = LACK_WAS[c.service]; return t ? t.charAt(0).toLowerCase() + t.slice(1) : 'услуги не было'; }
  /** Заголовок блока «Воду дали?» — вопрос: рядом поле «Когда дали», и «Когда дадут» над ним сбивало. */
  var END_ASK = {
    hot_water_off: 'Воду дали?', cold_water_off: 'Воду дали?', electricity_off: 'Свет дали?', gas_off: 'Газ дали?',
    heating_off: 'Отопление дали?', sewerage_off: 'Канализацию починили?', waste_off: 'Мусор вывезли?',
    heating_temp: 'Стало тепло?', hot_water_temp: 'Вода снова горячая?'
  };
  /** «Ещё не …» — вернуть дело в отслеживание словами этой услуги: у мусора «не починили» не подходит. */
  var NOT_YET = {
    hot_water_off: 'Воду ещё не дали', cold_water_off: 'Воду ещё не дали', electricity_off: 'Свет ещё не дали', gas_off: 'Газ ещё не дали',
    heating_off: 'Отопление ещё не дали', sewerage_off: 'Ещё не починили', waste_off: 'Ещё не вывезли',
    heating_temp: 'Ещё холодно', hot_water_temp: 'Вода ещё не горячая'
  };
  function notYet(c) { return NOT_YET[c.service] || 'Ещё не починили'; }
  /** Подпись поля времени в блоке «когда дадут»: чтобы не вписали, когда обещали. */
  var END_WHEN = {
    hot_water_off: 'Когда дали воду', cold_water_off: 'Когда дали воду', electricity_off: 'Когда дали свет', gas_off: 'Когда дали газ',
    heating_off: 'Когда дали отопление', sewerage_off: 'Когда починили канализацию', waste_off: 'Когда вывезли мусор',
    heating_temp: 'Когда стало тепло', hot_water_temp: 'Когда вода стала горячей'
  };
  var LACK_NOW = {
    hot_water_off: 'Горячей воды нет', cold_water_off: 'Холодной воды нет', electricity_off: 'Света нет', gas_off: 'Газа нет',
    heating_off: 'Отопления нет', sewerage_off: 'Канализация не работает', waste_off: 'Мусор не вывозят',
    heating_temp: 'Холодно', hot_water_temp: 'Вода еле тёплая'
  };
  var LACK_WAS = {
    hot_water_off: 'Горячей воды не было', cold_water_off: 'Холодной воды не было', electricity_off: 'Света не было', gas_off: 'Газа не было',
    heating_off: 'Отопления не было', sewerage_off: 'Канализация не работала', waste_off: 'Мусор не вывозили',
    heating_temp: 'Холодно было', hot_water_temp: 'Вода была еле тёплой'
  };
  var TONE = { tracking: 'open', ended: 'action', claim_ready: 'action', refunded: 'money', refused: 'open', closed: '' };
  /** Как услуга называется в квитанции — для вопроса «сколько начислено за …». */
  var BILL_NAME = {
    hot_water_off: 'горячую воду', hot_water_temp: 'горячую воду', heating_temp: 'отопление', heating_off: 'отопление',
    cold_water_off: 'холодную воду', electricity_off: 'электричество', gas_off: 'газ', sewerage_off: 'водоотведение', waste_off: 'вывоз мусора'
  };
  var MONTHS_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
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
  /** Сумма как на сервере: «1 250,50», «1.250,50», «1250.5»; иначе null. */
  function parseMoney(s) {
    var t = String(s || '').toLowerCase().replace(/руб\.?|р\.?|₽/g, '').replace(/[\s\u00a0]/g, '');
    if (t.indexOf(',') >= 0 && t.indexOf('.') >= 0) t = t.replace(/\./g, '');
    t = t.replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    var v = Number(t);
    return v > 0 && v <= 100000 ? v : null;
  }
  /** Снижение платы — вниз до копеек, как в заявлении (оценка снизу). */
  function refundOf(bill, percent) { return Math.floor(Math.round(bill * 100) * Math.min(100, percent) / 100 + 1e-9) / 100; }
  /** Рубли за часы, когда горячая вода была ниже +40 °C, — как на сервере. */
  function coldAmount(month, hours, ct) {
    if (!ct || !(hours >= 1)) return 0;
    var p = month.split('-').map(Number);
    var monthHours = new Date(p[0], p[1], 0).getDate() * 24;
    return Math.floor(ct.volume * Math.min(1, hours / monthHours) * Math.max(0, ct.hot - ct.cold) * 100 + 1e-9) / 100;
  }
  function fmtHours(h) {
    var min = Math.round(h * 60), d = Math.floor(min / 1440), hh = Math.floor((min % 1440) / 60), mm = min % 60;
    var parts = [];
    if (d) parts.push(d + '\u00a0' + plural(d, ['сутки', 'суток', 'суток']));
    if (hh) parts.push(hh + '\u00a0ч');
    if (mm && !d) parts.push(mm + '\u00a0мин');
    return parts.join(' ') || '0\u00a0мин';
  }
  function num(s) { var t = String(s || '').replace(/\s/g, '').replace(',', '.'); return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null; }
  function fmtTemp(t) { return (t < 0 ? '−' : '+') + String(Math.abs(t)).replace('.', ',') + '\u00a0°C'; }
  /** Вызовы моста вне MAX возвращают отклонённый promise («транспорт недоступен») — не шумим в консоли. */
  function quiet(r) { if (r && typeof r.catch === 'function') r.catch(function () {}); return r; }
  function haptic(type) { try { WebApp && quiet(WebApp.HapticFeedback.notificationOccurred(type)); } catch (e) { /* не везде есть */ } }
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
          err.status = r.status;
          throw err;
        }
        return data;
      });
    }, function () {
      throw new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
    });
  }

  function busy(btn, text) {
    // Сохраняем разметку целиком: на кнопке может быть иконка.
    var old = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = text;
    return function () { btn.disabled = false; btn.innerHTML = old; };
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
    var fields = (e && e.fields) || {};
    var marked = [];
    Object.keys(fields).forEach(function (k) {
      var el = $((map && map[k]) || k);
      if (!el) return;
      for (var d = el.closest && el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
      el.setAttribute('aria-invalid', 'true');
      var p = document.createElement('p');
      p.className = 'field-error';
      p.innerHTML = nb(fields[k]);
      el.insertAdjacentElement('afterend', p);
      marked.push(el);
    });
    // К той ошибке, что выше на экране: иначе верхняя остаётся за кадром.
    marked.sort(function (a, b) { return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1; });
    var first = marked[0] || null;
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      try { first.focus({ preventScroll: true }); } catch (x) { first.focus(); }
    }
    haptic('error');
    if (!first || Object.keys(fields).length > 1) toast(e && e.message ? e.message : 'Что-то пошло не так. Попробуйте ещё раз.');
  }
  function fieldErr(id, message) { var f = {}; f[id] = message; return { message: message, fields: f }; }

  function showError(message, retry) {
    root.innerHTML = '<p class="state error">' + esc(message) + '</p><div class="actions">' + (retry ? '<button class="btn" id="retry">Повторить</button>' : '') +
      '<button class="btn" id="goHome">На главную</button></div>';
    if (retry) $('retry').onclick = retry;
    $('goHome').onclick = function () { go(''); };
  }

  /** Скачать файл по ссылке: в MAX — нативно, в браузере — переходом (ответ с attachment не уводит со страницы). */
  function download(url, fileName) {
    if (WebApp && WebApp.downloadFile && initData) return Promise.resolve(WebApp.downloadFile(url, fileName));
    // В браузере — через blob: если ссылка устарела, покажем ошибку, а не страницу с JSON.
    return fetch(url).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (d) { throw new Error(d.error || 'Не удалось скачать файл'); });
      return r.blob();
    }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName || 'документ.pdf';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.parentNode.removeChild(a); }, 2000);
    });
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
      if (fn) { WebApp.BackButton.onClick(fn); quiet(WebApp.BackButton.show()); } else quiet(WebApp.BackButton.hide());
    } catch (e) { /* старый клиент */ }
  }
  /** Переход «назад» без новой записи в истории: иначе системное «назад» вернёт в дело, из которого ушли. */
  function go(hash) {
    var h = String(hash || '').replace(/^#/, '');
    location.replace(location.pathname + location.search + '#' + h);
  }
  function home() { go(''); }
  function backLink(text, hash) {
    setBack(function () { go(hash); });
    return '<button class="back" data-go="' + esc(hash || '') + '">' + icon('back') + esc(text) + '</button>';
  }
  function bindBack() { each('[data-go]', function (b) { b.onclick = function () { go(b.getAttribute('data-go')); }; }); }

  /** Заголовок шага формы: номер в кружке (у пройденного — галочка) и название. */
  function stepHead(n, html, id) {
    return '<div class="step-h"' + (id ? ' id="' + id + '"' : '') + '><span class="step-n"><span class="t">' + n + '</span>' + icon('check') + '</span>' + html + '</div>';
  }

  function loadMe() { return api('GET', '/api/me').then(function (m) { me = m; return m; }); }

  // ---------- главная ----------
  function renderHome() {
    setBack(null);
    root.innerHTML = '<p class="state">Загружаю…</p>';
    Promise.all([loadMe(), api('GET', '/api/cases')]).then(function (res) {
      var cases = res[1].cases;
      var pending = cases.filter(function (c) { return c.status === 'claim_ready'; }).reduce(function (s, c) {
        return s + c.estimate + (c.extraFlats || []).reduce(function (x, f) { return x + f.estimate; }, 0);
      }, 0);
      var isDemo = !!DEMO_USER || cases.some(function (c) { return c.demo; });
      var html = '<div class="top"><h1 class="brand">Вернём</h1>' + (isDemo ? '<span class="pill">демо</span>' : '') + '</div>' +
        '<p class="lead">Отключали воду, свет или тепло? По закону плату должны снизить. Помогу вернуть эти деньги.</p>';
      var reportBtn = '<button class="btn primary big" id="report">' + icon('alert') + 'Сообщить о проблеме</button>';

      var housesHtml = '<h2 class="section">Мои адреса</h2>' +
        (me.houses.length ? '<ul class="houses">' + me.houses.map(houseRow).join('') + '</ul>' : '<p class="muted">Добавьте адрес — я буду сообщать, если у соседей что-то отключат.</p>') +
        '<button class="btn wide" id="addHouse">' + icon('plus') + 'Добавить адрес</button>';

      var casesHtml = '';
      var hero = '';
      if (cases.length) {
        // Сверху — то, что требует действий; закрытые дела — в архиве.
        var done = function (c) { return (c.status === 'refunded' && !refundedLess(c)) || c.status === 'closed'; };
        var active = cases.filter(function (c) { return !done(c); });
        var archive = cases.filter(done);
        // В демо — по порядку: сначала демо 1, потом демо 2.
        active.sort(function (a, b) { return a.demo && b.demo ? demoRank(a) - demoRank(b) : 0; });
        var archRefund = archive.reduce(function (s, c) { return s + (c.status === 'refunded' && c.refundAmount ? c.refundAmount : 0); }, 0);
        var lessCases = cases.filter(refundedLess);
        var less = lessCases.length;
        pending = Math.round(pending * 100) / 100;
        // Главная цифра — сколько уже вернули; если пока ничего — сколько положено по готовым заявлениям.
        if (me.refunded > 0 || pending > 0) {
          var got = me.refunded > 0;
          hero = '<section class="sheet hero"><p class="hero-label">' + (got ? 'Вам уже вернули' : 'Положено по заявлениям') + '</p>' +
            '<p class="hero-sum">' + (got ? rub(me.refunded) : '≈ ' + rub(pending)) + '</p>' +
            (got && pending > 0 ? '<ul class="ledger"><li><span class="label">Положено по заявлениям</span><span class="dots"></span><span class="sum">≈ ' + rub(pending) + '</span></li></ul>' : '') +
            // Недоплату показываем отдельной суммой: в «ждём по готовым заявлениям» она не входит.
            (less === 1
              ? '<p class="hero-note">Ещё ≈ ' + rub(shortfall(lessCases[0])) + ' недоплатили в деле «' + esc(lessCases[0].serviceButton) + ', ' + esc(period(lessCases[0])) + '» — можно потребовать.</p>'
              : less ? '<p class="hero-note">Ещё ≈ ' + rub(lessCases.reduce(function (s, x) { return s + shortfall(x); }, 0)) + ' недоплатили по ' + less + ' делам — можно потребовать.</p>' : '') +
            '</section>';
        }
        casesHtml = '<div class="section-row"><h2>Мои дела</h2>' + (active.length ? '<span class="muted">' + active.length + ' ' + plural(active.length, ['открытое', 'открытых', 'открытых']) + '</span>' : '') + '</div>' +
          (active.length ? '<ul class="cases">' + active.map(caseRow).join('') + '</ul>' : '<p class="muted">Открытых дел нет.</p>') +
          (archive.length ? '<details class="archive"><summary><span>Архив: ' + archive.length + ' ' + plural(archive.length, ['дело', 'дела', 'дел']) + (archRefund > 0 ? ' · вернули ' + rub(archRefund) : '') + '</span>' + icon('down') + '</summary>' +
            '<ul class="cases">' + archive.map(caseRow).join('') + '</ul></details>' : '');
      }

      var howHtml = '<details class="sheet how"' + (cases.length ? '' : ' open') + '><summary><span>Как это работает — 4 шага</span>' + icon('down') + '</summary><ol class="steps">' +
        '<li><b>Отключили или холодно</b> — нажмите «Сообщить о проблеме» и позвоните в аварийную службу: номер заявки — главное доказательство. Не дозвонились — помогу собрать акт с соседями.</li>' +
        '<li><b>Починили</b> — отметьте это, я посчитаю, сколько положено вернуть по закону.</li>' +
        '<li><b>Заявление</b> — скачайте его и отнесите в организацию, которой платите за эту услугу (она указана вверху заявления).</li>' +
        '<li><b>Квитанция</b> — через месяц проверьте, сделали ли перерасчёт. Не сделали — подготовлю требование выплатить вам штраф 50% и жалобу в жилищную инспекцию.</li>' +
        '</ol></details>';

      // Новому жителю сначала — как это работает; вернувшемуся — его деньги и дела.
      html += cases.length ? hero + reportBtn + howHtml + casesHtml + housesHtml : reportBtn + howHtml + housesHtml;
      html += '<footer><p>Расчёт по Приложению № 1 к ПП РФ № 354, нормы проверены ' + esc(me.normsCheckedAt.split('-').reverse().join('.')) +
        '. Сумма примерная — точную считает УК.</p>' +
        (cases.length || me.houses.length ? '<button id="delme">Удалить все мои данные</button><div id="delBox"></div>' : '') + '</footer>';
      root.innerHTML = html;
      $('report').onclick = function () { location.hash = me.houses.length ? '#report' : '#addhouse/report'; };
      $('addHouse').onclick = function () { location.hash = '#addhouse'; };
      each('.case', function (el) { el.onclick = function () { location.hash = '#case/' + el.getAttribute('data-id'); }; });
      // Внутри карточки — ссылка «позвонить»: нажатие на неё не открывает карточку дома.
      each('.house', function (el) { el.onclick = function (e) { if (!e.target.closest('a')) location.hash = '#house/' + el.getAttribute('data-id'); }; });
      if ($('delme')) $('delme').onclick = function () { askDeleteAll(cases.length); };
    }).catch(function (e) { showError(e.message, renderHome); });
  }

  function houseRow(h) {
    var i = h.info || {};
    var tel = telHref(i.adsPhone);
    var where = [h.entrance ? 'подъезд ' + h.entrance : '', h.flat ? 'кв. ' + h.flat : ''].filter(Boolean).join(', ');
    var uk = i.ukName ? i.ukName : infoFilled(i) ? 'данные дома заполнены не полностью' : 'нет данных из квитанции — нажмите, чтобы заполнить';
    var phone = i.adsPhone ? icon('phone') + 'Аварийная: ' + esc(i.adsPhone) : '';
    return '<li><div class="house" data-id="' + h.id + '" role="button" tabindex="0">' +
      '<span class="house-head"><span class="ic">' + icon('home') + '</span><span class="house-main">' +
      '<span class="title">' + esc(h.address) + '</span>' +
      '<span class="meta">' + esc((where ? where + ' · ' : '') + uk) + '</span>' +
      '<span class="meta">' + esc(cap(membersText(h.members))) + '</span></span></span>' +
      (phone ? (tel ? '<a class="phone-btn" href="' + esc(tel) + '">' + phone + '</a>' : '<span class="phone-btn">' + phone + '</span>') : '') +
      '</div></li>';
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function infoFilled(i) { return Object.keys(i || {}).some(function (k) { return k !== 'updatedAt' && k !== 'updatedBy' && i[k]; }); }
  function membersText(n) { return n > 1 ? 'здесь ' + n + ' ' + plural(n, ['житель', 'жителя', 'жителей']) + ' дома' : 'из соседей здесь пока только вы'; }

  /** Недоплата по делу, где вернули меньше положенного. */
  function shortfall(c) { return Math.round((c.estimate - (c.refundAmount || 0)) * 100) / 100; }
  function refundedLess(c) { return c.status === 'refunded' && c.refundAmount && c.estimate > 0 && c.refundAmount < c.estimate * 0.9; }
  function caseRow(c) {
    var st = caseStage(c);
    var total = c.estimate + (c.extraFlats || []).reduce(function (x, f) { return x + f.estimate; }, 0);
    // «вернули 60 ₽», а не просто «60 ₽»: рядом у других дел «≈ 120 ₽» — это ещё положено.
    var sum = c.status === 'refunded' ? (c.refundAmount ? 'вернули ' + rub(c.refundAmount) : '') : total > 0 ? '≈ ' + rub(Math.round(total * 100) / 100) : '';
    // Открытое дело — «Сейчас: что сделать»; закрытое — чем закончилось.
    var line = st.finished ? c.statusTitle : 'Сейчас: ' + st.now;
    return '<li><button class="case" data-id="' + c.id + '" data-tone="' + st.tone + '">' +
      '<span class="case-head"><span class="ic tone-' + (st.tone || 'plain') + '">' + icon(c.service) + '</span>' +
      '<span class="case-main"><span class="title">' + esc(c.serviceButton || c.serviceTitle) + '</span>' +
      '<span class="meta">' + esc(c.address) + ' · ' + esc(period(c)) + '</span></span>' +
      (sum ? '<span class="amount">' + esc(sum) + '</span>' : '') + '</span>' +
      (st.done ? bar(st.done) : '') +
      '<span class="case-now"><span class="status">' + (c.demo ? '<span class="demo-tag">' + demoLabel(c) + '</span>' : '') + esc(line) + '</span>' + icon('right') + '</span>' +
      '</button></li>';
  }
  function bar(done) {
    var s = '';
    for (var k = 1; k <= 4; k++) s += '<span' + (k <= done ? ' class="on"' : '') + '></span>';
    return '<span class="bar" aria-hidden="true">' + s + '</span>';
  }
  /** Срок дела коротко: «с 24.09, 21:00» или «21.09 — 24.09». */
  function period(c) {
    var d = function (iso) { return when(iso, c.tz).split(',')[0]; };
    var t = function (iso) { return when(iso, c.tz).split(', ')[1]; };
    if (c.endedAt && d(c.startedAt) === d(c.endedAt)) return d(c.startedAt) + ', ' + t(c.startedAt) + '–' + t(c.endedAt);
    // «с 25.09, 15:46» — время не уезжает на новую строку отдельно от даты.
    return c.endedAt ? d(c.startedAt) + ' — ' + d(c.endedAt) : 'с ' + when(c.startedAt, c.tz).replace(', ', ', ');
  }
  /**
   * Где дело на пути «Сообщили → Починили → Заявление → Квитанция» (done — сколько шагов пройдено)
   * и что жителю сделать сейчас. tone — цвет: open — ждёт жителя, action — следующий шаг, money — деньги.
   */
  function caseStage(c) {
    var cl = c.claim || {};
    // Номера нет и акт не подписан — первым делом акт: так же, как в блоке «Сейчас» на экране дела.
    var needAct = needActFirst(c);
    if (c.status === 'tracking') {
      var t = (END_TITLE[c.service] || 'Когда починят — отметьте здесь').replace(' — отметьте здесь', '');
      return { done: 1, tone: 'open', now: needAct ? 'подпишите акт с соседями' : 'отметьте, ' + t.charAt(0).toLowerCase() + t.slice(1) };
    }
    if (needAct) return { done: c.status === 'claim_ready' && cl.submittedAt ? 3 : 2, tone: 'open', now: 'подпишите акт с соседями' };
    if (c.status === 'ended') return { done: 2, tone: 'action', now: 'скачайте заявление' };
    if (c.status === 'claim_ready') {
      if (c.claimOutdated) return { done: 2, tone: 'action', now: 'скачайте новое заявление' };
      if (cl.submittedAt) return { done: 3, tone: 'action', now: 'ждём квитанцию за ' + monthTitle(monthKeyOf(cl.submittedAt)) };
      return { done: 2, tone: 'action', now: 'подайте заявление' };
    }
    if (c.status === 'refused') return { done: 3, tone: 'open', now: 'потребуйте штраф 50% или пожалуйтесь в инспекцию' };
    if (c.status === 'refunded') return refundedLess(c) ? { done: 3, tone: 'open', now: 'можно потребовать остальное' } : { done: 4, tone: 'money', finished: true };
    return { done: 0, tone: '', finished: true };
  }

  /** Открытое дело без номера заявки и без подписанного акта: главное действие — акт с соседями. */
  function needActFirst(c) {
    var open = c.status === 'tracking' || c.status === 'ended' || c.status === 'claim_ready';
    if (!(open && c.evidence === 'self' && !(c.act && c.act.status === 'signed'))) return false;
    // Пока перерыв в пределах допустимого, денег нет — бегать за подписями рано: сначала «Воду дали?», акт — ниже.
    if (c.status === 'tracking') return c.months.some(function (m) { return m.percent > 0 || m.coldTariffHours >= 1; });
    return true;
  }

  /** Какое это демо: 1 — с номером заявки, 2 — без номера (акт с соседями). */
  function demoRank(c) { var l = demoLabel(c); return l === 'демо 1' ? 1 : l === 'демо 2' ? 2 : 3; }
  function demoLabel(c) {
    // Архивное «вернули меньше» помечено в демо-данных; сняли отметку «вернули» — оно всё равно «демо 3».
    if (c.demoKind === 3) return 'демо 3';
    return (c.startEvidence || c.evidence) === 'self' ? 'демо 2' : 'демо 1';
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
  /** «Садовая 10 кв 15» → «Садовая 10»: квартира — не часть адреса дома. */
  function stripFlat(t) { return String(t).replace(/(?:^|[\s,])(?:квартира|кв)\.?\s*№?\s*\d+[а-яa-z]?/i, '').replace(/[\s,]+$/, '').trim(); }
  function normCity(s) { return String(s).toLowerCase().replace(/ё/g, 'е').replace(/^\s*(г\.|гор\.|город)\s*/, '').replace(/\s+/g, ' ').trim(); }

  function renderAddHouse(next) {
    if (!me) { loadMe().then(function () { renderAddHouse(next); }).catch(function (e) { toast(e.message); }); return; }
    var cities = me.cities || [];
    // Свой город подставляем сразу; новому жителю — выбрать кнопкой: подставленная «Москва» незаметно
    // записала бы дом не в тот город.
    var cityName = (me.myCities && me.myCities[0]) || '';
    // Пришли из формы «Что случилось?» кнопкой «+ Другой» — «Назад» ведёт обратно в форму (выбор проблемы сохранён).
    var backToReport = next === 'report' && me.houses.length > 0;
    var html = backLink('Назад', backToReport ? '#report' : '') + '<h1>Добавить адрес</h1>' +
      (next === 'report' ? '<p class="note">' + (backToReport ? 'Добавьте адрес — потом вернёмся к проблеме.' : 'Сначала добавьте адрес — потом сразу перейдём к проблеме.') + '</p>' : '') +
      stepHead(1, 'Город', 'cityStep') + '<div id="cityBox"></div>' +
      stepHead(2, '<label for="q">Улица и номер дома</label>') +
      '<div class="search">' + icon('search') + '<input id="q" autocomplete="off" placeholder="Например: Садовая 10"></div>' +
      '<p class="muted hint" id="searchHint">Выберите свой дом из списка — так вы будете вместе с соседями. Нет в списке — добавьте его.</p>' +
      '<ul class="results" id="results"></ul>' +
      '<div id="pick" hidden><p class="picked-card" id="picked"></p>' +
      stepHead(3, 'Подъезд и квартира <small>можно позже</small>') +
      '<div class="row2"><div><label for="entrance">Подъезд</label><input id="entrance" maxlength="4" placeholder="2 или 2А"></div>' +
      '<div><label for="flat">Квартира</label><input id="flat" maxlength="10" placeholder="Например 15"></div></div>' +
      '<p class="muted hint">Квартира нужна только для ваших заявлений — соседи её не видят.</p>' +
      '<div class="actions"><button class="btn primary big" id="add">Добавить адрес</button></div></div>';
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
        box.innerHTML = '<div class="picked-row"><span class="picked">' + esc(cityName) + '</span><button class="linklike" id="cityChange">Изменить</button></div>';
        $('cityStep').classList.add('done');
        $('cityChange').onclick = function () { cityName = ''; q.value = ''; drawCity(); $('cityQ').focus(); };
        q.disabled = false;
        q.placeholder = 'Например: Садовая 10';
        q.oninput();
        return;
      }
      box.innerHTML = '<div class="chips">' + cities.slice(0, 6).map(function (c) { return '<button class="chip" data-city="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>' +
        '<input id="cityQ" autocomplete="off" placeholder="Другой город — начните вводить">' +
        '<ul class="results" id="cityResults"></ul>';
      $('cityStep').classList.remove('done');
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
      if (check && check.suggestion && found.indexOf(check.suggestion) < 0) items.push('<li><button class="result" data-city="' + esc(check.suggestion) + '">Возможно, «' + esc(check.suggestion) + '»?</button></li>');
      if (check && check.inList && found.indexOf(check.name) < 0) found = [check.name].concat(found);
      found.forEach(function (c) { items.push('<li><button class="result" data-city="' + esc(c) + '">' + esc(c) + '</button></li>'); });
      // Похоже на опечатку («Масква») — не предлагаем завести «новый город».
      if (check && check.name && !check.inList && !check.suggestion) items.push('<li><button class="result new" data-city="' + esc(check.name) + '">' + icon('plus') + 'Другой город: «' + esc(check.name) + '»</button></li>');
      if (check && !check.name && typed && !items.length) items.push('<li class="muted">' + (check.latin ? 'Напишите город по-русски, например «Москва»' : 'Напишите название полностью — хотя бы четыре буквы') + '</li>');
      if (check && check.name && !check.inList && !check.suggestion) items.push('<li class="muted small">Этого города пока нет в справочнике — ничего страшного, добавьте его. Проверьте только, что название написано верно.</li>');
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
      if (text.length < 2 || /^\d+$/.test(text)) { $('results').innerHTML = /^\d+$/.test(text) ? '<li class="muted">Добавьте название улицы, например «Садовая 10»</li>' : ''; return; }
      timer = setTimeout(function () {
        api('GET', '/api/houses/search?q=' + encodeURIComponent(text) + '&city=' + encodeURIComponent(cityName)).then(function (r) {
          var items = r.houses.map(function (h) {
            return '<li><button class="result" data-id="' + h.id + '" data-address="' + esc(h.address) + '">' + icon('home') + '<span><b>' + esc(h.address) + '</b>' +
              (me.houses.some(function (x) { return x.id === h.id; }) ? '<small>уже в вашем списке</small>'
                : h.members ? '<small>уже здесь: ' + h.members + ' ' + plural(h.members, ['житель', 'жителя', 'жителей']) + '</small>' : '') + '</span></button></li>';
          });
          // Дом с таким адресом уже в списке — «добавить новый» только запутает.
          if (/\d/.test(text) && !r.exactId) {
            // «кв 15» — не часть дома: в названии кнопки её нет, квартира уйдёт в своё поле.
            items.push('<li><button class="result new" data-new="1">' + icon('plus') + 'Добавить дом «' + esc(cityName + ', ' + stripFlat(text)) + '»</button></li>');
            if (!r.houses.length) items.push('<li class="muted small">Дома ещё нет в списке — значит, вы первые из соседей. Добавьте его: следующие найдут дом по этому адресу.</li>');
          }
          // Дома нет в списке — хватает подсказки «вы первые», общая «выберите из списка» её только повторяет.
          $('searchHint').hidden = !r.houses.length && /\d/.test(text) && !r.exactId;
          $('results').innerHTML = items.join('') || '<li class="muted">Добавьте номер дома</li>';
          Array.prototype.forEach.call($('results').querySelectorAll('.result'), function (b) {
            b.onclick = function () {
              chosen = b.getAttribute('data-new') ? { address: text, city: cityName, label: cityName + ', ' + text } : { houseId: Number(b.getAttribute('data-id')), label: b.getAttribute('data-address') };
              // «Садовая 10 кв 15» — квартиру переносим в своё поле, в адрес дома она не входит.
              var fm = /(?:^|[\s,])(?:квартира|кв)\.?\s*№?\s*(\d+[а-яa-z]?)/i.exec(text);
              if (fm && !$('flat').value) $('flat').value = fm[1].toUpperCase();
              if (fm && chosen.label) chosen.label = chosen.label.replace(fm[0], '').trim();
              $('picked').innerHTML = icon('home') + '<span>' + esc(chosen.label) + '</span>';
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
        toast(r.already ? (r.entranceChanged ? 'Этот адрес уже был в списке — подъезд обновил' : 'Этот адрес уже есть в вашем списке') : next === 'report' ? 'Адрес добавлен' : 'Адрес добавлен. Если что-то отключат — нажмите «Сообщить о проблеме»');
        go(next === 'report' ? '#report/' + r.house.id : '');
      }).catch(function (e) { showErrors(e); }).then(done);
    };
  }

  // ---------- карточка дома: данные из квитанции ----------
  var INFO_FIELDS = [
    ['ukName', 'Ваша управляющая компания (УК или ТСЖ, как в квитанции)', 'Например: ООО «УК Пример»'],
    ['ukInn', 'ИНН УК', '10 цифр из квитанции', 'numeric'],
    ['adsPhone', 'Телефон аварийной службы', 'Например: +7 495 123-45-67', 'tel'],
    ['ukEmail', 'Почта УК — туда можно отправить заявление', 'Например: uk@example.ru', 'email'],
    ['ukAddress', 'Адрес УК — впишу его в заявление', 'Город, улица, дом, офис'],
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
      var html = backLink('Главная', '') +
        '<div class="case-title"><span class="ic big">' + icon('home') + '</span><div><h1>' + esc(h.address) + '</h1>' +
        '<p class="muted">' + (h.members > 1 ? 'Здесь уже ' + h.members + ' ' + plural(h.members, ['житель', 'жителя', 'жителей']) + ' этого дома, вместе с вами' : 'Из соседей здесь пока только вы') + '</p></div></div>' +
        '<button class="btn primary big" id="reportHere">' + icon('alert') + 'Сообщить о проблеме здесь</button>';

      html += '<section class="sheet"><h2>Я в этом доме</h2>' +
        '<div class="row2"><div><label for="entrance">Подъезд</label><input id="entrance" maxlength="4" placeholder="2 или 2А" value="' + esc(h.entrance || '') + '"></div>' +
        '<div><label for="flat">Квартира</label><input id="flat" maxlength="10" value="' + esc(h.flat || '') + '"></div></div>' +
        '<label for="account">Лицевой счёт (из квитанции)</label><input id="account" maxlength="40" value="' + esc(h.account || '') + '">' +
        '<p class="muted hint">Квартиру и счёт видите только вы — они нужны для ваших заявлений.</p>' +
        // Флажок слева — как «Запомнить ФИО…» в заявлении.
        '<label class="check-row" for="notify"><input type="checkbox" id="notify"' + (h.notify ? ' checked' : '') + '><span>Сообщать, если у соседей что-то отключат</span></label>' +
        (h.inviteLink ? '<button class="btn wide" id="copy">' + icon('users') + 'Позвать соседей — скопировать ссылку</button>' +
          '<input readonly id="invite" hidden value="' + esc(h.inviteLink) + '" aria-label="Ссылка для соседей">' +
          (h.members > 1 ? '' : '<p class="muted hint">Когда что-то отключат, я спрошу соседей «у вас тоже?» — вместе проще доказать.</p>') : '') +
        '</section>';

      html += '<section class="sheet"><h2>Данные дома <small>из квитанции</small></h2>' +
        '<p class="muted">Один раз на весь дом — попадут в ваши заявления и заявления соседей. Их видят и могут поправить все жители дома, поэтому сверяйте с квитанцией (или с <a href="' + GIS_HOUSES + '" data-ext>ГИС ЖКХ</a>).</p>' +
        // Главное — три поля; остальное свёрнуто, чтобы форма не пугала.
        INFO_FIELDS.slice(0, 3).map(infoField).join('') +
        '<details class="more"' + (INFO_FIELDS.slice(3).some(function (f) { return i[f[0]]; }) ? ' open' : '') + '><summary>Ещё: почта и адрес УК, поставщики, жилинспекция</summary>' +
        INFO_FIELDS.slice(3).map(infoField).join('') + '</details>' +
        // Три кнопки вместо списка: так проще попасть пальцем. Список остаётся скрытым — из него читает сохранение.
        '<p class="q" id="twoPowerQ">В доме есть лифт или больше 9 этажей?</p><div class="seg" role="group" aria-labelledby="twoPowerQ">' +
        [['1', 'Да'], ['0', 'Нет'], ['', 'Не знаю']].map(function (o) {
          var cur = i.twoPowerSources === true ? '1' : i.twoPowerSources === false ? '0' : '';
          return '<button type="button" data-power="' + o[0] + '" aria-pressed="' + (cur === o[0]) + '"' + (cur === o[0] ? ' class="on"' : '') + '>' + o[1] + '</button>';
        }).join('') + '</div>' +
        '<select id="twoPower" hidden><option value=""' + (i.twoPowerSources === undefined ? ' selected' : '') + '>Не знаю</option><option value="1"' + (i.twoPowerSources === true ? ' selected' : '') + '>Да</option><option value="0"' + (i.twoPowerSources === false ? ' selected' : '') + '>Нет</option></select>' +
        '<p class="muted hint">От этого зависит, сколько часов без света допустимо: у таких домов обычно два ввода электричества — без света можно быть не больше 2 часов в месяц, у остальных — 24 часа в месяц. Один ответ на весь дом.</p>' +
        '<p class="muted hint" id="infoStatus">' + (i.updatedAt ? 'Сохранено ' + esc(when(i.updatedAt)) + '. ' : '') + 'Изменения сохраняются сами, когда вы переходите к следующему полю.</p></section>';

      html += '<div class="bottom"><button class="linklike danger-link" id="remove">Убрать адрес из моего списка</button></div>';
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
      $('notify').onchange = function () { patch({ notify: $('notify').checked }); };
      if ($('copy')) $('copy').onclick = function () {
        var link = $('invite').value;
        // Буфер обмена недоступен (старый WebView) — показываем ссылку, чтобы скопировать вручную.
        (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () { toast('Ссылка скопирована — отправьте её соседям'); }, function () { $('invite').hidden = false; $('invite').select(); toast('Выделите и скопируйте ссылку'); });
      };
      each('[data-power]', function (b) {
        b.onclick = function () {
          $('twoPower').value = b.getAttribute('data-power');
          each('[data-power]', function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
          saveInfo(null, 'Сохранено. Дела «Нет света» по этому дому пересчитаны.');
        };
      });
      // Данные дома сохраняются сами — ушли с экрана, не нажав «Сохранить», ничего не пропадёт.
      var saved = JSON.stringify(infoBody());
      function infoBody() {
        var b = {};
        INFO_FIELDS.forEach(function (f) { b[f[0]] = $('f_' + f[0]).value.trim() || undefined; });
        b.twoPowerSources = $('twoPower').value === '' ? null : $('twoPower').value === '1';
        return b;
      }
      // Ответы приходят не по порядку: старый «сохранено» не должен стирать свежую ошибку.
      var infoSeq = 0;
      function saveInfo(btn, okText) {
        var body = infoBody();
        var json = JSON.stringify(body);
        if (!btn && json === saved) return Promise.resolve();
        var done = btn ? busy(btn, 'Сохраняю…') : function () {};
        var mine = ++infoSeq;
        return api('PUT', '/api/houses/' + h.id + '/info', body).then(function (res) {
          saved = json;
          if (mine !== infoSeq) return;
          clearErrors();
          var info = (res.house && res.house.info) || {};
          $('infoStatus').textContent = '✓ Сохранено' + (info.updatedAt ? ' ' + when(info.updatedAt) : '') + '. Эти данные попадут в ваши заявления и заявления соседей.';
          // Как в «Я в этом доме»: всплывающее «Сохранено» на каждое сохранение, а не только строка внизу.
          if (btn) { haptic('success'); track('app_house_info'); toast('Данные дома сохранены — они попадут в ваши заявления и заявления соседей'); } else toast(okText || 'Сохранено');
        }).catch(function (e) {
          if (mine !== infoSeq) return;
          // Сервер сохраняет верные поля, а поле с ошибкой оставляет прежним. Следующее изменение сохраняем
          // в любом случае — даже если житель вернул прежнее значение (иначе предупреждение так и висело бы).
          saved = null;
          $('infoStatus').textContent = e.fields ? '⚠️ Остальное сохранено, а поле с ошибкой — нет: исправьте его.' : '⚠️ Не сохранено: ' + e.message;
          showErrors(e, { ukInn: 'f_ukInn', ukEmail: 'f_ukEmail', adsPhone: 'f_adsPhone' });
        }).then(done);
      }
      each('[data-info]', function (el) { el.addEventListener('change', function () { saveInfo(null); }); });
      $('twoPower').addEventListener('change', function () { saveInfo(null); });
      $('remove').onclick = function () {
        if (!confirm('Убрать «' + h.address + '» из вашего списка? Дела по этому адресу сохранятся.')) return;
        api('DELETE', '/api/me/houses/' + h.id).then(function () { toast('Адрес убран'); home(); }).catch(function (e) { toast(e.message); });
      };
    }).catch(function (e) { showError(e.message, e.status === 404 ? null : function () { renderHouse(id); }); });
  }

  // ---------- сообщить о проблеме ----------
  /** Выбранная проблема на время «+ Другой»: добавили адрес — вернулись в форму, выбирать заново не нужно. */
  var reportDraft = null;
  function renderReport(houseId) {
    root.innerHTML = '<p class="state">Загружаю…</p>';
    // Список адресов всегда свежий: его могли только что изменить на другом экране.
    loadMe().then(function () {
      if (!me.houses.length) { go('#addhouse/report'); return; }
      var preset = me.houses.filter(function (h) { return h.id === houseId; })[0];
      var draft = reportDraft;
      reportDraft = null;
      var st = { houseId: preset ? preset.id : me.houses.length === 1 ? me.houses[0].id : null, service: draft ? draft.service : null };
      var html = backLink('Главная', '') + '<h1>Что случилось?</h1>';
      html += stepHead(1, 'Где') + '<div class="chips" id="houses">' + me.houses.map(function (h) {
        return '<button class="chip' + (st.houseId === h.id ? ' on' : '') + '" data-id="' + h.id + '">' + icon('check', 'i-on') + esc(h.address) + '</button>';
      }).join('') + '<button class="chip add" type="button" id="otherHouse">' + icon('plus') + 'Другой</button></div>' +
        '<p class="hint warn" id="whereHint" hidden>Выберите адрес, где случилось</p>';
      html += stepHead(2, 'Что') + '<div class="grid" id="services">' + me.services.map(function (s) {
        return '<button class="tile" data-key="' + s.key + '" aria-label="' + esc(s.button) + '"><span class="badge">' + icon('check') + '</span>' + icon(s.key) + '<span>' + esc(s.button) + '</span></button>';
      }).join('') + '</div><p class="desc" id="serviceDesc" hidden></p>';
      var opt = function (v, text, checked) {
        return '<div class="opt' + (checked ? ' on' : '') + '" data-ev="' + v + '"><label><input type="radio" name="ev" value="' + v + '"' + (checked ? ' checked' : '') + '><span>' + text + '</span></label><div class="opt-slot"></div></div>';
      };
      html += '<div id="details" hidden>' +
        '<div id="extra"></div>' +
        '<div id="adsBox">' + stepHead(3, '<span id="adsTitle">Позвоните в аварийную службу</span>') +
        '<section class="sheet"><p id="adsHint" class="muted"></p><a class="phone-btn" id="adsPhone" hidden></a>' +
        // Ничего не отмечено заранее: житель, который ещё не звонил, не должен видеть «Дозвонились».
        '<p class="sub-h">Сначала позвоните. Потом отметьте, что получилось:</p><div class="opts">' +
        opt('ads', '<span id="evAdsText">Дозвонились — есть номер заявки</span>') +
        opt('written', 'Написали в «Госуслуги Дом» — есть номер обращения') +
        opt('self', 'Номера нет (не дозвонились или не назвали) — докажу актом с соседями') +
        '</div>' +
        '<div id="numberBox" hidden><label for="number" id="numberLabel">Номер заявки</label><input id="number" maxlength="60"></div>' +
        '</section></div>' +
        '<div id="whenBox">' + stepHead(4, '<label for="started" id="startedLabel">Когда позвонили в аварийную службу</label>') +
        '<div class="chips time-chips" id="startChips"><button class="chip" type="button" data-ago="0">Только что</button><button class="chip" type="button" data-ago="60">1 ч назад</button>' +
        '<button class="chip" type="button" data-ago="180">3 ч назад</button><button class="chip" type="button" data-ago="1440">Сутки назад</button>' +
        '<button class="chip" type="button" data-ago="2880">2 дня назад</button><button class="chip" type="button" data-ago="10080">Неделю назад</button></div>' +
        '<input id="started" type="datetime-local" max="' + localNow() + '" aria-describedby="startedHint">' +
        '<p class="muted hint" id="startedHint"></p><div id="whenExtra"></div></div>' +
        '<div class="actions" id="submitBox"><button class="btn primary big" id="submit">Записать проблему</button></div></div>';
      root.innerHTML = html;
      bindBack();

      function evidence() { var r = root.querySelector('input[name=ev]:checked'); return r ? r.value : null; }
      /** Плановое отключение — дальше заполнять нечего; вариант звонка не выбран — время спрашивать рано. */
      function layout() {
        var planned = !!($('planned') && $('planned').checked);
        var ev = evidence();
        var wasHidden = $('whenBox').hidden;
        $('adsBox').hidden = planned;
        $('whenBox').hidden = planned || !ev;
        $('submitBox').hidden = planned || !ev;
        if (wasHidden && !$('whenBox').hidden && ev) setTimeout(function () { $('whenBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 50);
      }
      function refreshEvidence() {
        var ev = evidence();
        var waste = st.service === 'waste_off';
        $('evAdsText').textContent = waste ? 'Дозвонились оператору — назвали номер обращения' : 'Дозвонились — есть номер заявки';
        layout();
        if (!ev) return;
        // Сменили вариант — прежняя ошибка про номер больше не относится к делу.
        if ($('number').getAttribute('aria-invalid')) clearErrors();
        $('numberBox').hidden = ev === 'self';
        each('.opt', function (o) { o.classList.toggle('on', o.getAttribute('data-ev') === ev); });
        var slot = root.querySelector('.opt[data-ev="' + ev + '"] .opt-slot');
        if (slot && ev !== 'self') slot.appendChild($('numberBox'));
        $('numberLabel').textContent = ev === 'written' || waste ? 'Номер обращения' : 'Номер заявки';
        // По закону нарушение считается с момента сообщения в аварийную службу — поэтому спрашиваем время звонка.
        if (ev === 'ads') {
          $('startedLabel').textContent = waste ? 'Когда позвонили оператору' : 'Когда позвонили в аварийную службу';
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
        each('#houses .chip[data-id]', function (b) { b.classList.toggle('on', Number(b.getAttribute('data-id')) === st.houseId); });
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
          // Ссылка «на главную» — отдельной строкой: внутри абзаца высокая кнопка раздвигала строки.
          extra = '<label><input type="checkbox" id="planned"> Отключили по плану (летом, с объявлением)</label>' +
            '<div id="plannedHint" hidden><p class="muted hint">Плановое летнее отключение законно — снижения платы за него не будет, записывать нечего. Отключили дольше объявленного или без объявления — снимите галочку.</p>' +
            '<button type="button" class="linklike" id="plannedHome">Вернуться на главную</button></div>';
        }
        if (st.service === 'electricity_off') {
          // Ответ про лифт — один на дом. Уже есть в карточке дома — показываем его, а не кнопки:
          // иначе «Нет» в форме спорило бы с «Да» в карточке.
          var two = h && h.info ? h.info.twoPowerSources : undefined;
          if (two === true || two === false) {
            extra = '<p class="q">' + (two ? 'В доме есть лифт или больше 9 этажей' : 'В доме нет лифта и не больше 9 этажей') + ' — так записано в карточке дома.</p>' +
              '<p class="muted hint">Поэтому без света допустимо не больше ' + (two ? '2 часов' : '24 часов') + ' в месяц. Ответ неверный — исправьте его в карточке дома («Мои адреса»).</p>' +
              '<input type="hidden" id="variant" value="">';
          } else {
            extra = '<p class="q" id="variantQ">В доме есть лифт или больше 9 этажей?</p><div class="seg" role="group" aria-labelledby="variantQ">' +
              [['two_sources', 'Да'], ['one_source', 'Нет'], ['', 'Не знаю']].map(function (o) {
                return '<button type="button" data-variant="' + o[0] + '" aria-pressed="' + (o[0] === '') + '"' + (o[0] === '' ? ' class="on"' : '') + '>' + o[1] + '</button>';
              }).join('') + '</div>' +
              '<input type="hidden" id="variant" value="">' +
              '<p class="muted hint">У таких домов обычно два ввода электричества, и без света можно быть не больше 2 часов в месяц, у остальных — 24 часа в месяц. Ответ запишу в карточку дома — он один на всех соседей. ' +
              'Не знаете — посчитаю так, будто допустимо 24 часа: сумма выйдет меньше, зато её не оспорят.</p>';
          }
        }
        // Замер (градусы, комната) — рядом со временем замера, в шаге 4, а не над звонком.
        var tempHtml = '';
        if (s && s.kind !== 'interruption') {
          tempHtml = (st.service === 'heating_temp' ? '<label for="corner">Комната</label><select id="corner"><option value="0">Обычная — норма +18 °C</option><option value="1">Угловая (две стены на улицу) — норма +20 °C</option></select>' : '') +
            '<label for="temp">Сколько градусов показал термометр</label><input id="temp" inputmode="decimal" placeholder="' + (st.service === 'heating_temp' ? 'Например: 16' : 'Например: 45') + '">' +
            '<p class="muted hint">' + (st.service === 'heating_temp' ? 'Меряйте в центре комнаты, на высоте около 1 м, вдали от окон и батарей.' : 'Меряйте воду из крана после того, как она стечёт 3 минуты.') + '</p>';
        }
        // Межсезонье: если отопление ещё не включали по графику, денег не будет — говорим сразу.
        var m = new Date().getMonth() + 1;
        if ((st.service === 'heating_temp' || st.service === 'heating_off') && m >= 5 && m <= 9) {
          extra += '<p class="note">Сейчас межсезонье. Если отопление в городе ещё не включали по графику, снижения платы не будет — проверьте объявление УК.</p>';
        }
        $('extra').innerHTML = extra ? '<section class="sheet">' + extra + '</section>' : '';
        $('whenExtra').innerHTML = tempHtml;
        // Плановое отключение — денег не будет: дальше заполнять нечего.
        function plannedView() {
          var on = !!($('planned') && $('planned').checked);
          if ($('plannedHint')) $('plannedHint').hidden = !on;
          layout();
        }
        if ($('planned')) $('planned').onchange = plannedView;
        if ($('plannedHome')) $('plannedHome').onclick = home;
        each('[data-variant]', function (b) {
          b.onclick = function () {
            $('variant').value = b.getAttribute('data-variant');
            each('[data-variant]', function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
          };
        });
        plannedView();
        var phone = h && h.info && h.info.adsPhone;
        var waste = st.service === 'waste_off';
        // Газ — не аварийка УК, а газовая служба: 104.
        var gas = st.service === 'gas_off';
        $('adsTitle').textContent = waste ? 'Позвоните оператору по вывозу мусора' : gas ? 'Позвоните в аварийную газовую службу' : 'Позвоните в аварийную службу';
        // Телефон аварийной службы — отдельной большой кнопкой; у мусора свой оператор, его телефон в квитанции.
        var pb = $('adsPhone');
        pb.hidden = gas ? false : !phone || waste;
        if (gas) {
          pb.innerHTML = icon('phone') + '104';
          pb.setAttribute('href', 'tel:104');
        } else if (phone && !waste) {
          pb.innerHTML = icon('phone') + esc(phone);
          if (telHref(phone)) pb.setAttribute('href', telHref(phone)); else pb.removeAttribute('href');
        }
        $('adsHint').innerHTML = gas
          ? 'Аварийная газовая служба — 104 (с мобильного тоже) или телефон из квитанции за газ. Скажите адрес и что случилось. Запишите номер заявки — это главное доказательство.'
          : waste
          ? 'Телефон регионального оператора по вывозу мусора — в квитанции. Запишите номер обращения — это главное доказательство.'
          : (phone ? '' : 'Телефон аварийной службы есть в квитанции. ') + 'Скажите адрес и что случилось. Запишите номер заявки и кто её принял — диспетчер обязан назвать себя. Номер — главное доказательство.';
        refreshEvidence();
      }
      each('#houses .chip[data-id]', function (b) { b.onclick = function () { st.houseId = Number(b.getAttribute('data-id')); refresh(); }; });
      $('otherHouse').onclick = function () { reportDraft = { service: st.service }; location.hash = '#addhouse/report'; };
      each('#services .tile', function (b) {
        b.onclick = function () {
          st.service = b.getAttribute('data-key');
          refresh();
          // Адрес не выбран — продолжение формы не появится: показываем, почему, там, где выбирать.
          if (!st.houseId) $('whereHint').scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
      });
      each('input[name=ev]', function (r) { r.onchange = refreshEvidence; });
      // Быстрый выбор времени: подставляем в поле, дальше его можно поправить руками.
      each('#startChips .chip', function (b) {
        b.onclick = function () {
          $('started').value = toLocalInput(new Date(Date.now() - Number(b.getAttribute('data-ago')) * 60000).toISOString());
          each('#startChips .chip', function (x) { x.classList.toggle('on', x === b); });
          if ($('started').getAttribute('aria-invalid')) clearErrors();
        };
      });
      $('started').oninput = function () { each('#startChips .chip', function (x) { x.classList.remove('on'); }); };
      refresh();

      $('submit').onclick = function () {
        var ev = evidence();
        if (!ev) return;
        var body = {
          houseId: st.houseId,
          service: st.service,
          evidence: ev,
          number: $('number').value.trim() || null,
          startedAt: $('started').value ? new Date($('started').value).toISOString() : null,
          temp: $('temp') ? $('temp').value.trim() : undefined,
          corner: $('corner') ? $('corner').value === '1' : false,
          // «Не знаю» и ответ из карточки дома — без варианта: сервер возьмёт ответ дома или строгий лимит 24 ч.
          variant: $('variant') && $('variant').value ? $('variant').value : undefined,
          planned: $('planned') ? $('planned').checked : false
        };
        // Все ошибки формы — сразу, а не по одной за нажатие.
        var errs = {};
        if (!body.startedAt) errs.started = 'Выберите время кнопкой выше или впишите своё';
        if (ev !== 'self' && !body.number) errs.number = ev === 'written' ? 'Впишите номер обращения' : 'Впишите номер заявки или выберите «Номера нет»';
        if ($('temp') && !body.temp) errs.temp = 'Впишите, сколько градусов показал термометр';
        if (Object.keys(errs).length) { showErrors({ message: 'Заполните отмеченные поля', fields: errs }); return; }
        // Больше месяца — чаще всего опечатка в дате. Не запрещаем, но переспрашиваем.
        if (Date.now() - new Date(body.startedAt).getTime() > 31 * 24 * 3600000 &&
          !confirm('Начало — ' + new Date(body.startedAt).toLocaleDateString('ru-RU') + ', больше месяца назад. Всё верно?')) return;
        var done = busy($('submit'), 'Записываю…');
        api('POST', '/api/report', body).then(function (r) {
          haptic('success');
          track('app_report');
          // Честно говорим, что произошло: новое дело, уже записанное или присоединение к соседям.
          if (r.outcome === 'existing') toast(r.numberSaved ? 'Номер добавлен в ваше дело' + (r.readingSaved ? ', замер тоже' : '') + '. Время начала осталось прежним — чтобы считать со звонка, в деле нажмите «Исправить время».' : r.readingSaved ? 'Замер добавлен в ваше дело' : 'Это у вас уже записано — открыл дело');
          else if (r.outcome === 'joined') toast('Соседи уже сообщили об этом — вы присоединились к их делу.' + (r.numberSaved ? ' Ваш номер заявки сохранён.' : ''));
          else toast(!r.botConnected ? 'Записал.' : r.neighbours > 0 ? 'Записал. Спрошу соседей в сети: «у вас тоже?»' : 'Записал. Позовите соседей — вместе проще доказать.');
          // Без записи в истории: «назад» из дела ведёт на главную, а не обратно в форму.
          location.replace(location.pathname + location.search + '#case/' + r.caseId);
        }).catch(function (e) { showErrors(e); }).then(done);
      };
    }).catch(function (e) { showError(e.message, function () { renderReport(houseId); }); });
  }

  // ---------- дело ----------
  /** soft — перерисовать после автосохранения: без «Загружаю…», с открытыми блоками, полем в фокусе и прокруткой. */
  function renderCase(id, focusShare, openFlats, soft) {
    if (!soft) root.innerHTML = '<p class="state">Загружаю…</p>';
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
      c.botConnected = data.botConnected !== false;
      c.signer = data.actSigner;
      var open = c.status === 'tracking' || c.status === 'ended' || c.status === 'claim_ready';
      var temp = c.kind !== 'interruption';

      var st = caseStage(c);
      var html = backLink('Главная', '');
      html += '<div class="case-title"><span class="ic big tone-' + (st.tone || 'plain') + '">' + icon(c.service) + '</span><div>' +
        '<h1>' + esc(c.serviceButton || c.serviceTitle) + '</h1>' +
        '<p class="muted">' + esc(c.address) + ' · ' + esc(period(c)) + '</p></div></div>';
      // Путь дела из 4 шагов; у закрытого «без денег» пути нет — вместо него объяснение.
      html += c.status === 'closed'
        ? '<p class="note">' + esc(c.statusTitle) + (c.service === 'electricity_off' && (c.contacts || {}).twoPowerSources == null ? '. Если в доме есть лифт или больше 9 этажей — отметьте это в карточке дома: тогда допустимо только 2 часа, и расчёт изменится.' : '') + '</p>'
        : stepper(c, st);
      if (c.demo) html += demoNote(c);

      // Номер получили позже начала, акта нет: время до звонка ничем не подтверждено.
      var lateNumber = open && c.startEvidence === 'self' && c.evidence !== 'self' && !(c.act && c.act.status === 'signed');
      if (lateNumber) html += warn('Номер заявки получен позже начала отключения. Проще всего — нажмите «Исправить время» ниже и поставьте время звонка. Считать с самого начала отключения можно, только если соседи подпишут акт (ниже).');
      // Главное действие — в блоке «Сейчас» наверху. Нет доказательства — сначала акт.
      var actFirst = needActFirst(c);
      // Сначала акт — предупреждение о новом заявлении не наверху, а в «Потом»: скачивать его стоит уже с подписанным актом.
      if (c.claimOutdated && !actFirst && c.status !== 'claim_ready') {
        html += '<div class="note"><div><p>Данные заявления изменились (плата, время, акт или получатель) — скачайте его заново и подайте новое. Отметку о подаче поставите снова.</p>' +
          '<div class="actions"><button class="btn" id="pdfOutdated">' + icon('doc') + 'Скачать новое заявление</button></div></div></div>';
      }
      if (actFirst) html += actSection(c, true);
      if (c.status === 'refused') html += escalationSection(c);
      if (c.status === 'refunded') html += refundedSection(c);
      if (c.status === 'claim_ready') html += nextSteps(c, actFirst);
      if (c.status === 'tracking') {
        html += endBlock(c, !actFirst);
        if (temp) html += readingBlock(c);
      }
      // Заявление ещё не скачано: плата, сумма и форма — одним блоком, по порядку.
      html += c.status === 'ended' ? claimForm(c, actFirst ? 'card' : 'now') : moneySection(c);
      if (!actFirst && open && (c.evidence === 'self' || lateNumber || c.inspection === 'no_show' || (c.act && c.act.mine))) html += actSection(c, false);
      html += factsSection(c);
      // Заявление уже выдано — его данные свёрнуты под «Исправить данные заявления».
      if (c.endedAt && (c.status === 'claim_ready' || c.status === 'refused')) html += claimForm(c, 'fold');

      html += '<div class="bottom">' + (open ? '<button class="btn" id="share">' + icon('users') + 'Позвать соседей</button>' : '') +
        '<button class="linklike danger-link" id="deleteCase">Удалить дело</button></div>';
      var keep = soft ? keepState() : null;
      root.innerHTML = html;
      bindBack();
      bindCase(c);
      if (keep) restoreState(keep);
      if (focusShare) { var s = $('share'); if (s) s.focus(); }
      // Добавили квартиру — её заявление должно быть на виду, а не в двух свёрнутых блоках.
      if (openFlats) {
        each('#claimBox, #claimMore, #xfBox', function (d) { d.open = true; });
        if ($('xfBox')) $('xfBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }).catch(function (e) { showError(e.message, e.status === 404 ? null : function () { renderCase(id); }); });
  }

  /** Что было на экране до мягкой перерисовки: открытые блоки, поле в фокусе с набранным текстом, прокрутка. */
  function keepState() {
    var a = document.activeElement;
    var st = { y: window.scrollY, open: [] };
    each('details[id]', function (d) { if (d.open) st.open.push(d.id); });
    if (a && a.id && root.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) { st.focus = a.id; st.value = a.value; }
    return st;
  }
  function restoreState(st) {
    st.open.forEach(function (id) { if ($(id)) $(id).open = true; });
    var el = st.focus && $(st.focus);
    if (el) {
      if (el.value !== st.value) { el.value = st.value; el.dispatchEvent(new Event('input', { bubbles: true })); }
      try { el.focus({ preventScroll: true }); } catch (x) { el.focus(); }
    }
    window.scrollTo(0, st.y);
  }

  /** Демо: что это за случай и что нажать дальше. Плашка нейтральная — не путается с жёлтым блоком «Сейчас». */
  function demoNote(c) {
    var t = '';
    if (c.evidence === 'self' && c.status === 'tracking') {
      t = '<b>Демо 2: не дозвонились — номера заявки нет.</b> Доказательство — акт с соседями: двое соседей (демо) уже в нём. ' +
        (c.act && c.act.status === 'signed' ? 'Акт подписан — отметьте «' + esc(endName(c)) + '», и он попадёт в заявление.' : 'Нажмите ниже «Да, с председателем» или «Да, без председателя», потом «' + esc(endName(c)) + '» — акт попадёт в заявление.');
    } else if (refundedLess(c)) {
      t = '<b>Демо 3: УК вернула меньше положенного.</b> Ниже — документы, чтобы потребовать остальное.';
    } else if (c.demoKind === 3 && c.status !== 'refunded') {
      // Сняли отметку «вернули» — это всё ещё демо 3, а не «демо 1».
      t = '<b>Демо 3: пример, где вернули меньше положенного.</b> Нажмите ниже «Перерасчёт сделали» и впишите, например, 60 ₽ — появятся документы, чтобы потребовать остальное.';
    } else if (c.status === 'ended') {
      t = '<b>Демо:</b> впишите любую плату из квитанции, например 600, и нажмите «Скачать заявление».';
    } else if (c.evidence === 'ads' && c.status === 'claim_ready' && c.claim && c.claim.submittedAt && !c.claimOutdated) {
      t = '<b>Демо 1: заявление подано.</b> Дальше ждём квитанцию. Что делать, если вернут меньше, — в деле «демо 3» на главной.';
    } else if (c.evidence === 'ads' && c.status === 'claim_ready') {
      t = '<b>Демо 1: дозвонились — есть номер заявки.</b> Этого достаточно: заявление готово. Ниже — что с ним делать.';
    }
    return t ? '<div class="note demo"><div><p>' + t + '</p></div></div>' : '';
  }

  /** Предупреждение: значок и текст; extra — кнопки под текстом. */
  function warn(text, extra) {
    return '<div class="note warn">' + icon('alert') + '<div><p>' + text + '</p>' + (extra || '') + '</div></div>';
  }

  /** Путь дела: «Сообщили → Воду дали → Заявление → Квитанция». */
  function stepper(c, st) {
    // Пока воду не дали, шаг — вопрос: «Воду дали» рядом с «воды нет» сбивает с толку.
    // «Записали», а не «Сообщили»: без номера заявки сообщить никуда не удалось.
    var names = ['Записали', st.done >= 2 ? endName(c) : endName(c) + '?', 'Заявление', 'Квитанция'];
    return '<ol class="stepper">' + names.map(function (n, i) {
      var k = i + 1;
      // Сейчас главное — акт (его нет среди 4 шагов): текущий шаг не подсвечиваем, чтобы не спорил с блоком «Сейчас».
      var cur = !needActFirst(c) && k === st.done + 1;
      var cls = k <= st.done ? 'st-done' : cur ? 'st-cur tone-' + st.tone : '';
      return '<li class="' + cls + '"' + (cur ? ' aria-current="step"' : '') + '><span class="dot">' + (k <= st.done ? icon('check') : k) + '</span>' + esc(n) + '</li>';
    }).join('') + '</ol>';
  }

  /** «Воду дали? Отметьте время»: время кнопками и зелёная кнопка. now — это главное действие дела. */
  function endBlock(c, now) {
    var title = (END_ASK[c.service] || 'Починили?') + ' Отметьте время';
    var hint = c.service === 'waste_off' ? 'Запишите, когда вывезли, — время попадёт в заявление.'
      : c.evidence === 'ads' ? 'Позвоните в аварийную службу и скажите, что ' + endName(c).toLowerCase() + ', — так фиксируется время окончания.'
        : c.evidence === 'written' ? 'Допишите в обращение, когда починили.' : 'Запишите время — оно попадёт в заявление.';
    return '<section class="' + (now ? 'now' : 'sheet') + '">' + (now ? '<p class="kicker">Сейчас</p>' : '') + '<h2>' + esc(title) + '</h2>' +
      '<label for="ended">' + esc(END_WHEN[c.service] || 'Когда починили') + '</label>' +
      timeChips('endChips', [[0, 'Только что'], [60, '1 ч назад'], [180, '3 ч назад'], [1440, 'Сутки назад']]) +
      '<input id="ended" type="datetime-local" max="' + localNow() + '">' +
      // Зелёная — только когда это главное действие; при «сначала акт» не перетягивает внимание с акта.
      '<div class="actions"><button class="btn big' + (now ? ' go' : '') + '" id="endBtn">' + icon('check') + esc(endName(c)) + '</button></div>' +
      '<p class="muted hint">' + hint + '</p></section>';
  }

  function readingBlock(c) {
    return '<section class="sheet"><h2>Новый замер</h2><p class="muted">' + (c.service === 'heating_temp' ? 'Холодно' : 'Вода еле тёплая') + ' несколько дней — меряйте хотя бы раз в день: каждый замер — ещё одно доказательство.</p>' +
      '<div class="row2"><div><label for="newTemp">Градусы</label><input id="newTemp" inputmode="decimal" placeholder="Например: 16"></div>' +
      '<div><label for="newTempAt">Когда</label><input id="newTempAt" type="datetime-local" value="' + localNow() + '"></div></div>' +
      '<div class="actions"><button class="btn" id="addReading">Записать замер</button></div></section>';
  }

  function evidenceText(c) {
    if (c.evidence === 'ads' && c.adsNumber) return (c.service === 'waste_off' ? 'обращение № ' : 'заявка № ') + c.adsNumber + (c.role === 'neighbour' ? ' (по дому)' : '');
    if (c.evidence === 'written') return 'обращение' + (c.adsNumber ? ' № ' + c.adsNumber : '');
    return c.act && c.act.status === 'signed' ? 'акт с соседями' : c.service === 'waste_off' ? 'без номера обращения' : 'без номера заявки';
  }

  /** Плата из квитанции (и тарифы для «холодных» часов): здесь — пока заявление не выдано, потом — в «Исправить данные заявления». */
  function claimMoneyInputs(c) {
    if (!c.endedAt || c.status === 'refunded' || c.status === 'closed') return '';
    var html = '';
    c.months.filter(function (m) { return m.percent > 0; }).forEach(function (m) {
      var val = m.bill || m.billHint;
      var mp = m.month.split('-');
      var what = BILL_NAME[c.service] || 'эту услугу';
      html += '<label for="bill_' + m.month + '">Сколько начислено за ' + esc(what) + ' в ' + MONTHS_PREP[Number(mp[1]) - 1] + ' ' + mp[0] + ', ₽</label>' +
        '<input id="bill_' + m.month + '" data-month="' + m.month + '" class="bill" inputmode="decimal" placeholder="Сумма по этой услуге" value="' + (val ? String(val).replace('.', ',') : '') + '">' +
        (!m.bill && m.billHint ? '<p class="muted hint">Подставил из вашего другого дела за этот месяц — проверьте.</p>'
          : '<p class="muted hint">Если в квитанции несколько строк про ' + esc(what) + ' — сложите их.</p>');
    });
    c.months.filter(function (m) { return m.coldTariffHours >= 1; }).forEach(function (m) {
      var ct = (c.claim && c.claim.coldTariff && c.claim.coldTariff[m.month]) || {};
      var mp = m.month.split('-');
      html += '<div class="cold-box"><p class="hint">В ' + MONTHS_PREP[Number(mp[1]) - 1] + ' ' + mp[0] + ' горячая вода была ниже +40&nbsp;°C ' + fmtHours(m.coldTariffHours) +
        ' — за эти часы горячая вода оплачивается как холодная. Чтобы посчитать разницу в рублях, впишите из квитанции (необязательно):</p>' +
        '<label for="ct_vol_' + m.month + '">Горячей воды за месяц, м³</label><input id="ct_vol_' + m.month + '" class="ct" data-month="' + m.month + '" data-k="volume" inputmode="decimal" placeholder="Например: 3,5" value="' + (ct.volume ? String(ct.volume).replace('.', ',') : '') + '">' +
        '<div class="row2"><div><label for="ct_hot_' + m.month + '">Тариф горячей, ₽/м³</label><input id="ct_hot_' + m.month + '" class="ct" data-month="' + m.month + '" data-k="hot" inputmode="decimal" placeholder="Например: 250" value="' + (ct.hot ? String(ct.hot).replace('.', ',') : '') + '"></div>' +
        '<div><label for="ct_cold_' + m.month + '">Тариф холодной, ₽/м³</label><input id="ct_cold_' + m.month + '" class="ct" data-month="' + m.month + '" data-k="cold" inputmode="decimal" placeholder="Например: 55" value="' + (ct.cold ? String(ct.cold).replace('.', ',') : '') + '"></div></div>' +
        '<p class="muted hint">Считаю, как если бы вода расходовалась равномерно, — это оценка. Точную сумму пересчитает УК или поставщик.</p></div>';
    });
    return html;
  }

  /** Деньги: крупная сумма, одна фраза и расклад «начислено × снижение = вернуть». */
  function moneySection(c) {
    if (!c.months.length) return '';
    return '<section class="sheet money" id="money">' + moneyInner(c) + '</section>';
  }
  function moneyInner(c) {
    var paid = c.months.filter(function (m) { return m.percent > 0; });
    var cold = c.months.some(function (m) { return m.coldTariffHours >= 1; });
    var claimStage = c.endedAt && c.status !== 'closed' && c.status !== 'refunded';
    var html = '';
    if (claimStage && (paid.length || cold)) {
      // Пока платы нет — ни подписи без суммы, ни «0 ₽»: вместо них заголовок «Деньги».
      // Другие квартиры в доме — сумма по всем, как на карточке на главной, и расклад по квартирам.
      var xf = c.extraFlats || [];
      var total = Math.round((c.estimate + xf.reduce(function (s, f) { return s + f.estimate; }, 0)) * 100) / 100;
      html += '<h2 id="moneyH"' + (total > 0 ? ' hidden' : '') + '>Деньги</h2>' +
        '<div id="heroBox"' + (total > 0 ? '' : ' hidden') + '><p class="hero-label">Положено вернуть' + (xf.length ? ' по ' + (xf.length + 1) + ' квартирам' : '') + '</p><p class="hero-sum" id="liveTotal">≈ ' + rub(total) + '</p>' +
        (xf.length ? '<p class="hero-note">' + ((c.claim || {}).flat ? 'кв. ' + esc(c.claim.flat) : 'ваша квартира') + ' — <span id="xfOwn">' + (c.estimate > 0 ? '≈ ' + rub(c.estimate) : 'плата не вписана') + '</span>; ' +
          xf.map(function (f) { return 'кв. ' + esc(f.flat) + ' — ≈ ' + rub(f.estimate); }).join('; ') + '</p>' : '') + '</div>';
    } else {
      html += '<h2>Деньги</h2>';
    }
    // Часы ниже +40 °C подробно объясняет блок с тарифами ниже — ту же мысль второй раз не пишем.
    if (!(c.status === 'ended' && !paid.length && cold)) html += '<p class="money-summary">' + summaryHtml(moneySummary(c)) + '</p>';
    if (c.status === 'tracking' && (paid.length || cold)) html += '<p class="muted hint">Рубли посчитаю, когда отметите «' + esc(endName(c)) + '» и впишете данные из квитанции.</p>';
    if (c.status === 'ended') html += claimMoneyInputs(c);
    if (c.endedAt && paid.length && c.status !== 'closed') {
      // Другие квартиры в деле — расклад ниже только по своей: подписываем, по какой.
      var xfOwn = (c.extraFlats || []).length ? '<li class="month">' + ((c.claim || {}).flat ? 'Кв. ' + esc(c.claim.flat) : 'Ваша квартира') + '</li>' : '';
      html += '<ul class="ledger">' + xfOwn + paid.map(function (m) {
        var bill = m.bill;
        return (paid.length > 1 ? '<li class="month">' + esc(cap(monthTitle(m.month))) + '</li>' : '') +
          (c.status === 'ended' ? '' : '<li><span class="label">Начислено за ' + esc(BILL_NAME[c.service] || 'услугу') + '</span><span class="dots"></span><span class="sum" id="bv_' + m.month + '">' + (bill ? rub(bill) : '—') + '</span></li>') +
          '<li><span class="label">Снижение</span><span class="dots"></span><span class="sum">× ' + pct(m.percent) + '</span></li>' +
          // Деньги уже вернули — это строка расчёта («положено»), а не призыв «вернуть».
          '<li class="strong"><span class="label">' + (c.status === 'refunded' ? 'Положено' : 'Вернуть') + '</span><span class="dots"></span><span class="sum money-t" id="ret_' + m.month + '">' + (bill ? rub(refundOf(bill, m.percent)) : '—') + '</span></li>';
      }).join('') + '</ul>';
    }
    html += '<p class="muted hint" id="liveNote"></p>' +
      '<details class="more"><summary>Как посчитано</summary><ul class="formula">' +
      c.months.map(function (m) {
        return (c.months.length > 1 ? '<li class="month">' + esc(monthTitle(m.month)) + '</li>' : '') + screenLines(m).map(function (l) { return '<li>' + nb(plainLine(l, c)) + '</li>'; }).join('');
      }).join('') + '</ul>' +
      '<p class="source muted">Источник: <a href="' + esc(c.basisUrl) + '" data-ext>' + esc(c.basis) + ' к ПП РФ № 354</a>. Итог считает УК.</p></details>';
    return html;
  }
  /** Строка про один долгий перерыв на сумму не влияет — на экране её не показываем (в заявлении она остаётся). */
  function screenLine(l) { return !/^Продолжительность одного перерыва/.test(l); }
  /** Строки «Как посчитано» на экране. Снижения по замерам пока нет — вместо «0,01 × 0,15% = 0%» одна понятная фраза. */
  function screenLines(m) {
    var ls = m.lines.filter(screenLine);
    var formula = /^(Часов ниже нормы|Сумма отклонений|[\d,]+ × )/;
    if (m.percent === 0 && !(m.coldTariffHours >= 1) && ls.some(function (l) { return formula.test(l); })) {
      ls = ls.filter(function (l) { return !formula.test(l); }).concat(['Пока снижения нет — ниже нормы было слишком недолго.']);
    }
    return ls;
  }
  /** «Часов ниже нормы: 3,01. Сумма отклонений: 9,03» — по-человечески. */
  function plainLine(l, c) {
    // Свет: откуда 2 или 24 часа — из ответа про лифт в карточке дома.
    if (c && c.service === 'electricity_off') {
      var two = (c.contacts || {}).twoPowerSources;
      var why = two === true ? 'в доме есть лифт или больше 9 этажей — так в карточке дома'
        : two === false ? 'в доме нет лифта и не больше 9 этажей — так в карточке дома' : 'ответа про лифт в карточке дома нет — считаю по строгому лимиту';
      l = l.replace(/Допустимо: (\d+) ч в месяц\./, 'Допустимо: $1 ч в месяц (' + why + ').');
    }
    return l.replace(/^Часов ниже нормы: ([\d,]+)\. Сумма отклонений: ([\d,]+) \(по каждому часу: на сколько градусов ниже нормы\)\./, 'Ниже нормы было $1 ч; если сложить, на сколько градусов было холоднее в каждый час, выйдет $2.');
  }

  /** Фраза о деньгах с выделенными сроком и процентом. */
  function summaryHtml(text) {
    return nb(text)
      .replace(/(\d+\u00a0(?:сутки|суток|ч|мин)(?: \d+\u00a0(?:ч|мин))?)/g, '<b>$1</b>')
      .replace(/(\d+(?:,\d+)?%)/g, '<b class="pct">$1</b>');
  }

  function pct(p) { return String(Math.round(p * 100) / 100).replace('.', ',') + '%'; }
  /** Главное о деньгах одной фразой: сколько не было услуги и на сколько снизить плату. */
  function moneySummary(c) {
    // До минуты, как на сервере: секунды в сохранённом времени не должны превращать «4 суток» в «3 суток 23 ч».
    var toMin = function (d) { return Math.floor(d.getTime() / 60000) * 60000; };
    var hours = (toMin(c.endedAt ? new Date(c.endedAt) : new Date()) - toMin(new Date(c.startedAt))) / 3600000;
    var paid = c.months.filter(function (m) { return m.percent > 0; });
    var cold = c.months.some(function (m) { return m.coldTariffHours >= 1; });
    // Температура: деньги зависят от замеров, а не от того, сколько прошло времени.
    if (c.kind !== 'interruption') {
      if (!paid.length) return cold ? 'Вода была холоднее +40 °C — за эти часы горячую воду должны посчитать по цене холодной.' : c.endedAt ? 'По замерам снижения платы не набралось.' : 'Пока по замерам снижения не набралось. Меряйте дальше: каждый замер ниже нормы — доказательство.';
      return 'По замерам плату ' + (paid.length === 1 ? 'за ' + monthTitle(paid[0].month) + ' ' : '') + 'должны снизить' + (paid.length === 1 ? ' на ' + pct(paid[0].percent) : ': ' + paid.map(function (m) { return 'за ' + monthTitle(m.month) + ' — на ' + pct(m.percent); }).join(', ')) +
        (c.endedAt ? '.' : '. Меряйте дальше — каждый замер ниже нормы добавляет.');
    }
    var what = c.endedAt ? (LACK_WAS[c.service] || 'Услуги не было') + ' ' + fmtHours(hours) : (LACK_NOW[c.service] || 'Услуги нет') + ' уже ' + fmtHours(hours);
    if (!paid.length) {
      return c.endedAt ? what + ' — это в пределах допустимого, снижения платы не положено.' : what + '. Пока это в пределах допустимого — если ' + (c.service === 'waste_off' ? 'не вывезут' : 'не починят') + ' дольше, начнут считаться деньги.';
    }
    // Не первое отключение за месяц: допустимые часы уже потрачены раньше — иначе «3 ч из 8» и вдруг проценты.
    var withPrev = paid.length === 1 && paid[0].lines.some(function (l) { return /предыдущ/.test(l); });
    var cut = withPrev
      ? 'вместе с прошлым отключением в этом месяце допустимое время уже превышено: плату за ' + monthTitle(paid[0].month) + ' должны снизить ещё на ' + pct(paid[0].percent)
      : paid.length === 1
        ? 'плату за ' + monthTitle(paid[0].month) + ' должны снизить на ' + pct(paid[0].percent)
        : 'плату должны снизить: ' + paid.map(function (m) { return 'за ' + monthTitle(m.month) + ' — на ' + pct(m.percent); }).join(', ');
    return what + ' — ' + cut + (c.endedAt ? '.' : c.service === 'waste_off' ? '. С каждыми сутками — больше.' : '. С каждым часом — больше.');
  }

  /** Кнопки быстрого выбора времени: [минут назад, подпись]. */
  function timeChips(id, list) {
    return '<div class="chips time-chips" id="' + id + '">' + list.map(function (x) {
      return '<button class="chip" type="button" data-ago="' + x[0] + '">' + esc(x[1]) + '</button>';
    }).join('') + '</div>';
  }
  function bindTimeChips(chipsId, inputId) {
    each('#' + chipsId + ' .chip', function (b) {
      b.onclick = function () {
        $(inputId).value = toLocalInput(new Date(Date.now() - Number(b.getAttribute('data-ago')) * 60000).toISOString());
        each('#' + chipsId + ' .chip', function (x) { x.classList.toggle('on', x === b); });
        if ($(inputId).getAttribute('aria-invalid')) clearErrors();
      };
    });
    if ($(inputId)) $(inputId).addEventListener('input', function () { each('#' + chipsId + ' .chip', function (x) { x.classList.remove('on'); }); });
  }

  /** «Что записано»: факты, замеры и исправление времени. */
  function factsSection(c) {
    var canEditReadings = c.status === 'tracking' || c.status === 'ended' || c.status === 'closed';
    var se = c.startEvidence || c.evidence;
    // Для номера заявки часы считаются со звонка, а не с отключения — так и подписываем, чтобы не путали.
    // Подпись короткая (длинная ломала колонку на узком экране), а с чего считаем — рядом со временем.
    var startLabel = se === 'ads' || se === 'written' ? 'Считаем с' : 'Началось';
    var startFrom = se === 'ads' ? (c.service === 'waste_off' ? ' — звонок оператору' : ' — звонок в аварийную') : se === 'written' ? ' — обращение' : '';
    var startLocked = !!(c.act && c.act.status === 'signed');
    var editStartLabel = se === 'ads' ? (c.service === 'waste_off' ? 'Время звонка оператору' : 'Время звонка в аварийную') : se === 'written' ? 'Время обращения' : 'Когда началось';
    var endLabel = cap((END_WHEN[c.service] || 'Когда починили').replace(/^Когда /, ''));
    var cl = c.claim || {};
    var html = '<section class="sheet"><h2>Что записано</h2><dl class="facts">' +
      '<dt>' + startLabel + '</dt><dd class="num">' + esc(when(c.startedAt, c.tz) + startFrom) + '</dd>' +
      '<dt>' + esc(endLabel) + '</dt><dd class="num">' + (c.endedAt ? esc(when(c.endedAt, c.tz)) : c.service === 'waste_off' ? 'пока нет' : 'ещё нет') + '</dd>' +
      '<dt>Доказательство</dt><dd>' + esc(evidenceText(c)) + (c.act && c.act.status !== 'signed' ? ' · акт ждёт подписей' : '') + '</dd>' +
      (cl.executor && (c.status === 'claim_ready' || c.status === 'refused' || c.status === 'refunded') ? '<dt>Получатель</dt><dd>' + esc(cl.executor) + '</dd>' : '') +
      (c.readings.length ? '<dt>Замеры</dt><dd class="num">' + c.readings.map(function (r) {
        return '<span class="reading">' + esc(when(r.at, c.tz)) + ': ' + esc(fmtTemp(r.tempC)) +
          (canEditReadings ? ' <button class="reading-del" data-reading="' + r.id + '" aria-label="Удалить замер">✕</button>' : '') + '</span>';
      }).join('') + '</dd>' : '') +
      (c.neighbours > 0 ? '<dt>Соседи</dt><dd>' + c.neighbours + '</dd>' : '') +
      (c.inspection ? '<dt>Проверка</dt><dd>' + esc(INSPECTION[c.inspection] || '') + '</dd>' : '') +
      (c.photos > 0 ? '<dt>Фото</dt><dd class="num">' + c.photos + '</dd>' : '') +
      '</dl>';
    if (c.status !== 'refunded') {
      html += '<button class="linklike" id="editTimes">Исправить время</button>' +
        '<div id="timesBox" hidden><label for="editStart">' + editStartLabel + '</label><input id="editStart" type="datetime-local" value="' + toLocalInput(c.startedAt) + '"' + (startLocked ? ' readonly aria-describedby="startLockedHint"' : '') + '>' +
        // Подписанный акт закрепляет начало — говорим сразу, а не после «Сохранить».
        (startLocked ? '<p class="muted hint" id="startLockedHint">Начало записано в подписанном акте — здесь его не изменить.' + (c.act.initiator ? ' Чтобы исправить, снимите отметку «подписан» в блоке акта и подпишите исправленный акт.' : '') + '</p>' : '') +
        (c.endedAt ? '<label for="editEnd">' + esc(endLabel) + '</label><input id="editEnd" type="datetime-local" value="' + toLocalInput(c.endedAt) + '">' : '') +
        '<p class="muted hint">Меняется только в вашем деле, у соседей время остаётся прежним.</p>' +
        '<div class="actions"><button class="btn primary" id="saveTimes">Сохранить время</button></div></div>';
    }
    if (c.status === 'ended' || c.status === 'closed') html += '<p><button class="linklike" id="reopen">' + esc(notYet(c)) + ' — вернуть в отслеживание</button></p>';
    return html + '</section>';
  }

  /** Акт с соседями: доказательство, если нет номера заявки или УК не пришла на замер. now — главное действие дела. */
  function actSection(c, now) {
    var a = c.act;
    var claimExists = c.status === 'claim_ready' || c.status === 'refused' || c.status === 'refunded';
    if (a && a.status === 'signed') {
      return '<section class="sheet"><h2>Акт с соседями <small>доказательство</small></h2>' +
        '<p class="done">' + icon('check') + 'Акт подписан ' + (a.chair ? 'жителями и председателем совета дома' : 'жителями') + '.</p>' +
        '<p>' + (claimExists ? 'Он указан в приложениях к заявлению — приложите его копию.' : 'Он попадёт в приложения к заявлению.') + '</p>' +
        '<div class="actions"><button class="btn" id="actPdf">' + icon('doc') + 'Акт (PDF)</button></div>' + (a.initiator ? '<button class="linklike" id="actUnsigned">Снять отметку «подписан»</button>' : '') + '</section>';
    }
    // Пока не починили, акт фиксирует то, что есть сейчас: «вода еле тёплая», а не «была».
    var nowT = c.status === 'tracking';
    var what = c.service === 'heating_temp' ? (nowT ? 'в квартире холодно' : 'в квартире было холодно')
      : c.service === 'hot_water_temp' ? (nowT ? 'вода еле тёплая' : 'вода была еле тёплой')
        : c.service === 'waste_off' ? (nowT ? 'мусор не вывозят' : 'мусор не вывозили') : nowT ? lackNow(c) : lackWas(c);
    var intro = now
      ? '<p>' + (c.service === 'waste_off' ? 'Номера обращения нет' : 'Номера заявки нет') + ' — акт докажет, что ' + what + '. Нужны подписи двух жителей — вы и хотя бы один сосед — и председателя совета дома, если он есть.</p>'
      : '<p>Акт доказывает, что ' + what + '. Распечатайте его: нужны подписи двух жителей — вы и хотя бы один сосед — и председателя совета дома, если он есть. Потом акт прикладывают к заявлению.</p>';
    var inner;
    if (a && a.mine) {
      var s = c.signer || {};
      inner = '<div class="inner">' +
        (a.residents > 1 ? '<p class="muted">' + (c.demo
          ? 'В акте вы и ещё ' + (a.residents - 1) + ' ' + plural(a.residents - 1, ['сосед', 'соседа', 'соседей']) + ' (демо). Распечатайте — расписаться на бумаге нужно всем.'
          : 'В акте уже вы и ещё ' + (a.residents - 1) + ' ' + plural(a.residents - 1, ['сосед', 'соседа', 'соседей']) + ' — они откликнулись в боте, их строки есть в PDF. Расписаться на бумаге нужно всем, и им тоже.') + '</p>' : '') +
        '<p class="strong">' + esc(s.fio || '') + (s.flat ? ', кв. ' + esc(s.flat) : '') + ' (вы)</p>' +
        '<button class="linklike" id="actEdit">Исправить</button>' +
        '<div id="actEditBox" hidden><label for="actFio">Ваши ФИО</label><input id="actFio" autocomplete="name" value="' + esc(s.fio || '') + '">' +
        '<label for="actFlat">Квартира</label><input id="actFlat" maxlength="10" value="' + esc(s.flat || '') + '">' +
        '<div class="actions"><button class="btn" id="actSave">Сохранить и скачать акт</button></div></div></div>' +
        '<div class="actions"><button class="btn" id="actPdf">' + icon('doc') + 'Акт для подписи (PDF)</button></div>';
      if (a.initiator) {
        inner += '<p class="sub-h">Подписали на бумаге вы и хотя бы один сосед?</p>' +
          '<div class="actions stack"><button class="btn" id="actSigned" data-chair="1">Да, с председателем</button>' +
          '<button class="btn" id="actSignedNoChair" data-chair="0">Да, без председателя</button></div>';
      }
    } else {
      var cl = c.claim || {};
      inner = '<p class="muted hint">Фамилия и имя обязательны: без них подпись в акте не засчитают.</p>' +
        '<label for="actFio">Ваши ФИО</label><input id="actFio" autocomplete="name" value="' + esc(cl.fio || '') + '">' +
        '<label for="actFlat">Квартира</label><input id="actFlat" maxlength="10" value="' + esc(cl.flat || '') + '">' +
        '<div class="actions"><button class="btn primary" id="actPdf">' + icon('doc') + 'Получить акт для подписи (PDF)</button></div>';
    }
    if (now && !c.demo) inner += '<p class="muted hint">Дозвонились позже — на главной нажмите «Сообщить о проблеме», выберите тот же адрес и проблему, отметьте «Дозвонились» и впишите номер: он добавится в это дело.</p>';
    return now
      ? '<section class="now"><p class="kicker">Сейчас</p><h2>Подпишите акт с соседями</h2>' + intro + inner + '</section>'
      : '<section class="sheet"><h2>Акт с соседями <small>доказательство</small></h2>' + intro + inner + '</section>';
  }

  /** Форма заявления. mode: now — главное действие (блок «Сейчас»), card — обычная карточка, fold — свёрнута после выдачи. */
  function claimForm(c, mode) {
    var cl = c.claim || {};
    // Вывоз мусора оплачивают региональному оператору, а не УК.
    // Получатель неизвестен — не подставляем «УК» молча: шапка заявления тогда нейтральная.
    if (!cl.executorType) cl.executorType = c.service === 'waste_off' ? 'rop' : cl.executor ? 'uk' : 'unknown';
    var opt = function (v, t) { return '<option value="' + v + '"' + (cl.executorType === v ? ' selected' : '') + '>' + t + '</option>'; };
    var s = c.signer;
    var mismatch = s && s.signed && cl.fio && (cl.fio.trim() !== (s.fio || '').trim() || (cl.flat || '') !== (s.flat || ''));
    var body = '<label for="executor">Кому подаёте — кому платите за эту услугу</label><input id="executor" autocomplete="off" value="' + esc(cl.executor || '') + '" placeholder="Название из квитанции">' +
      '<p class="muted hint">' + executorHint(c) + '</p>' +
      // Тип получателя — сразу под названием: от него зависит шапка заявления.
      '<label for="etype">Это УК или поставщик?</label><select id="etype">' + opt('uk', 'УК или ТСЖ') + opt('rso', 'Поставщик (Теплосеть, Водоканал, энергосбыт, газ)') + opt('rop', 'Вывоз мусора (региональный оператор)') + opt('unknown', 'Не знаю') + '</select>' +
      '<label for="fio">Ваши ФИО полностью</label><input id="fio" autocomplete="name" value="' + esc(cl.fio || '') + '" placeholder="Фамилия Имя Отчество">' +
      (mismatch ? '<p class="note warn">В подписанном акте вы — ' + esc(s.fio) + (s.flat ? ', кв. ' + esc(s.flat) : '') + '. В заявлении должно быть так же.</p>' : '') +
      '<div class="row2"><div><label for="flat">Квартира</label><input id="flat" value="' + esc(cl.flat || '') + '"></div>' +
      '<div><label for="account">Лицевой счёт</label><input id="account" value="' + esc(cl.account || '') + '"></div></div>' +
      '<label><input type="checkbox" id="remember"' + (c.savedPersonal ? ' checked' : '') + '> Запомнить ФИО, квартиру и лицевой счёт для следующих заявлений</label>' +
      '<details class="more" id="claimMore"><summary>Дополнительно (можно не заполнять)</summary>' +
      '<label for="inn">ИНН получателя</label><input id="inn" inputmode="numeric" value="' + esc(cl.executorInn || '') + '" placeholder="10 цифр из квитанции">' +
      (c.evidence === 'ads' && c.ownNumber
        ? '<label for="adsOperator">Кто принял заявку</label><input id="adsOperator" maxlength="80" value="' + esc(cl.adsOperator || '') + '" placeholder="ФИО или номер диспетчера">' +
          '<p class="muted hint">Диспетчер обязан назвать себя. Запомнили — впишите, это попадёт в заявление.</p>'
        : '') +
      '<div class="actions"><button class="btn" id="scan" type="button">' + icon('camera') + 'Заполнить из QR квитанции</button></div>' +
      extraFlatsBlock(c) +
      '</details>' +
      // Подсказка — у кнопки, а не вторым серым абзацем перед первым полем.
      '<p class="muted hint">Пустые поля можно вписать от руки после печати. Всё, что вы вписали, сохраняется само.</p>' +
      '<p class="muted hint" id="claimStatus"></p>' +
      '<div class="actions"><button class="btn' + (mode === 'fold' ? '' : ' primary big') + '" id="pdf">' + icon('doc') + 'Скачать заявление (PDF)</button></div>';
    if (mode === 'fold') {
      return '<details class="sheet fold" id="claimBox"><summary><span>Исправить данные заявления</span>' + icon('down') + '</summary>' + claimMoneyInputs(c) + body + '</details>';
    }
    // Заявление ещё не скачано: сначала плата и сумма, потом данные для шапки и «Скачать» — всё в одном блоке.
    // Поле платы есть, только если плату снижают в процентах; у «холодных» часов горячей воды — необязательные тарифы.
    var billAsked = c.months.some(function (m) { return m.percent > 0; });
    return (mode === 'now' ? '<section class="now tone-action" id="money"><p class="kicker">Сейчас</p><h2>' + (billAsked ? 'Впишите плату и скачайте заявление' : 'Скачайте заявление') + '</h2>' : '<section class="sheet" id="money"><h2>Заявление на перерасчёт</h2>') +
      (c.months.length ? '<div class="money">' + moneyInner(c).replace('<h2 id="moneyH"', '<h3 id="moneyH"').replace('>Деньги</h2>', '>Деньги</h3>') + '</div><div class="hr"></div>' : '') +
      '<p class="muted">Заявление — требование вернуть деньги. Подписываете вы. Акт с соседями, если есть, прикладывается к нему.</p>' +
      body + '</section>';
  }

  /**
   * Подсказка к получателю. За мусор, газ и свет обычно платят напрямую поставщику — «укажите УК» там было бы
   * неверным советом: пусть лучше впишут от руки из квитанции.
   */
  function executorHint(c) {
    if (c.service === 'waste_off') return 'Название регионального оператора — в квитанции за вывоз мусора. Не нашли — оставьте пустым и впишите от руки.';
    if (c.service === 'gas_off' || c.service === 'electricity_off') return 'Название — в квитанции за ' + (c.service === 'gas_off' ? 'газ' : 'электричество') + '. Не нашли — оставьте пустым и впишите от руки.';
    return 'Название — в квитанции, рядом со строкой этой услуги. Не знаете — укажите вашу управляющую компанию.';
  }

  /** Вторая (третья…) квартира в этом же доме: у каждой — своё заявление со своим счётом и платой. */
  function extraFlatsBlock(c) {
    var list = c.extraFlats || [];
    var paid = c.months.filter(function (m) { return m.percent > 0; });
    var html = '<details class="more" id="xfBox"' + (list.length ? ' open' : '') + '><summary>Ещё квартира в этом доме?</summary>' +
      '<p class="muted hint">По каждой квартире — своё заявление: с её лицевым счётом и платой из её квитанции. Всё остальное — как в заявлении выше.</p>';
    list.forEach(function (f, i) {
      html += '<div class="xf-row"><span><b>кв. ' + esc(f.flat) + '</b>' + (f.estimate > 0 ? ' · ≈ ' + rub(f.estimate) : '') + '</span>' +
        '<span><button class="btn" data-xf-pdf="' + i + '">' + icon('doc') + 'Заявление</button> <button class="linklike danger-link" data-xf-del="' + i + '">Удалить</button></span></div>';
    });
    html += '<div class="row2"><div><label for="xf_flat_new">Квартира</label><input id="xf_flat_new" maxlength="10"></div>' +
      '<div><label for="xf_acc_new">Лицевой счёт</label><input id="xf_acc_new" maxlength="40"></div></div>' +
      paid.map(function (m) {
        return '<label for="xf_bill_new_' + m.month + '">Начислено по этой квартире за ' + esc(BILL_NAME[c.service] || 'услугу') + ' за ' + esc(monthTitle(m.month)) + ', ₽</label>' +
          '<input id="xf_bill_new_' + m.month + '" class="xf-bill" data-month="' + m.month + '" inputmode="decimal">';
      }).join('') +
      '<div class="actions"><button class="btn" id="xfAdd">' + icon('plus') + 'Добавить квартиру</button></div></details>';
    return html;
  }

  /** Шаг «Что дальше»: номер в кружке, заголовок и пояснение. kind: o — следующий, g — позже. */
  function nstep(n, title, text, kind) {
    return '<div class="nstep">' + (n ? '<span class="n' + (kind ? ' ' + kind : '') + '">' + n + '</span>' : '') +
      '<div><b>' + title + '</b>' + (text ? '<span class="muted">' + text + '</span>' : '') + '</div></div>';
  }

  /** Куда нести заявление — той организации, что в шапке, а не всегда в УК. */
  /** later — это карточка «Потом» под актом: скачивать новое заявление рано, кнопку не показываем. */
  function whereToSubmit(c, later) {
    var cl = c.claim || {};
    var k = c.contacts || {};
    var toUk = cl.executorType === 'uk' || (k.ukName && cl.executor && cl.executor.trim() === k.ukName.trim());
    var who = cl.executor ? esc(cl.executor) : 'в организацию, которой платите за эту услугу';
    var parts = [];
    if (toUk && k.ukAddress) parts.push('Адрес УК: ' + esc(k.ukAddress) + '.');
    if (toUk && k.ukEmail) parts.push('Почта УК: <a href="mailto:' + esc(k.ukEmail) + '">' + esc(k.ukEmail) + '</a>.');
    var flats = c.extraFlats || [];
    var own = cl.flat ? 'кв. ' + esc(cl.flat) : 'ваша квартира';
    // По каждой квартире — своё заявление и своя сумма: общая сумма не совпала бы ни с одним PDF.
    var what = flats.length
      ? 'заявления' + (cl.executor ? ' в ' + who : ' ' + who) + ': ' + [own + (c.estimate > 0 ? ' — ≈ ' + rub(c.estimate) : '')].concat(flats.map(function (f) { return 'кв. ' + esc(f.flat) + (f.estimate > 0 ? ' — ≈ ' + rub(f.estimate) : ''); })).join('; ')
      : 'заявление' + (c.estimate > 0 ? ' на ≈ ' + rub(c.estimate) : '') + ' ' + (cl.executor ? 'в ' + who : who);
    var text = 'Лично — два экземпляра, на своём попросите отметку о приёме. Или через «Госуслуги Дом» — приложите этот PDF к обращению.' +
      (c.act && c.act.status === 'signed' ? ' <b>Приложите копию акта с подписями соседей.</b>' : '') +
      (parts.length ? ' ' + parts.join(' ') : (cl.executor ? ' Адрес и почту ищите в квитанции — рядом с получателем платежа.' : ' Получатель в заявлении не указан — впишите от руки название из квитанции.'));
    // Заявление устарело — скачать новое прямо в этом шаге (одна кнопка, без отдельной плашки сверху).
    if (c.claimOutdated && later) return nstep(1, 'Подайте ' + what, text);
    if (c.claimOutdated) {
      return nstep(1, (flats.length ? 'Скачайте новые ' : 'Скачайте новое ') + what, 'Данные изменились (плата, время, акт или получатель) — старое заявление уже не подходит. ' + text) +
        '<div class="actions step-gap"><button class="btn primary" id="pdfOutdated">' + icon('doc') + 'Скачать новое заявление</button></div>';
    }
    return nstep(1, 'Подайте ' + what, text) +
      // Кнопка обычная, чтобы не отвлекать от шага «Отметьте, когда подали».
      '<div class="actions step-gap"><button class="btn" id="pdfTop">' + icon('doc') + (flats.length ? 'Заявление: ' + own : 'Скачать заявление (PDF)') + '</button>' +
      flats.map(function (f, i) { return '<button class="btn" data-xf-pdf="' + i + '">' + icon('doc') + 'Заявление: кв. ' + esc(f.flat) + '</button>'; }).join('') + '</div>';
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
      // Подпись короткая: длинная переносилась на две строки и сдвигала поле ниже соседнего.
      '<div><label for="incoming">Входящий номер</label><input id="incoming" maxlength="40" value="' + esc(cl.incomingNumber || '') + '" placeholder="Если есть"></div></div>' +
      '<p class="muted hint">Входящий номер ставят на вашем экземпляре вместе с отметкой о приёме.</p>' +
      '<p class="muted hint" id="subStatus"></p>' +
      // Сохраняется само — кнопка «Сохранить» рядом с «✓ Сохранено» только путала.
      '';
  }

  /** «Не сделали» можно отметить, только когда пришла квитанция за следующий месяц после подачи. */
  function receiptReadyMonth(c) {
    var cl = c.claim || {};
    var base = cl.submittedAt || cl.createdAt || new Date().toISOString();
    return nextMonth(monthKeyOf(base));
  }

  /** later — выше уже блок «Сейчас» (акт с соседями): тогда это обычная карточка «Потом», а не второй главный блок. */
  function nextSteps(c, later) {
    var ready = receiptReadyMonth(c);
    var early = monthKeyOf(new Date().toISOString()) < ready;
    var cl = c.claim || {};
    var base = cl.submittedAt || cl.createdAt || new Date().toISOString();
    var html = later ? '<section class="sheet"><p class="kicker">Потом</p>' : '<section class="now tone-action"><p class="kicker">Сейчас</p>';
    // Заявление устарело — поданное раньше уже не то: «Подано» не пишем, чтобы не спорило с «подайте новое».
    var submitted = cl.submittedAt && !c.claimOutdated;
    if (later && c.claimOutdated) html += '<p class="muted">Заявление нужно будет скачать заново — после подписи акта, чтобы акт вошёл в него.</p>';
    if (submitted) {
      // Подали — шаги 1–2 сделаны: одна строка вместо инструкции.
      html += '<p class="done">' + icon('check') + 'Подано ' + esc(day(cl.submittedAt, c.tz)) + (cl.incomingNumber ? ', вх. № ' + esc(cl.incomingNumber) : '') + ' <button class="linklike" id="subEdit">Изменить</button></p>' +
        '<div id="subBox" hidden>' + submittedFields(cl, c) + '</div><div class="hr"></div>';
    } else if (c.claimOutdated) {
      html += (cl.submittedAt ? '<p class="muted">Старое заявление подали ' + esc(day(cl.submittedAt, c.tz)) + (cl.incomingNumber ? ' (вх. № ' + esc(cl.incomingNumber) + ')' : '') + ' — оно уже не подходит.</p>' : '') +
        whereToSubmit(c, later) + '<div class="hr"></div>' +
        // Отметить подачу — уже для нового заявления, после скачивания.
        nstep(2, 'Отметьте, когда подадите новое', 'Поле для даты появится после скачивания.', 'g') + '<div class="hr"></div>';
    } else {
      html += whereToSubmit(c) + '<div class="hr"></div>' +
        nstep(2, 'Отметьте, когда подали', 'Дата и номер понадобятся, если деньги не вернут.', 'o') + submittedFields(cl, c) + '<div class="hr"></div>';
    }
    var num = submitted ? '' : 3;
    html += early
      ? nstep(num, 'В начале ' + esc(MONTHS_GEN[Number(ready.split('-')[1]) - 1]) + ' проверьте квитанцию', 'Посмотрите, уменьшили ли плату за ' + esc(monthTitle(monthKeyOf(base))) + '. Я напомню в чате, тогда и отметите здесь.', 'g')
      : nstep(num, 'Пришла квитанция за ' + esc(monthTitle(monthKeyOf(base))) + '?', 'Посмотрите, уменьшили ли плату, и отметьте:', 'o') +
        '<label for="refundAmount">Сколько вернули по квитанции, ₽ (если знаете)</label><input id="refundAmount" inputmode="decimal" placeholder="Например: 115,20">' +
        '<div class="actions"><button class="btn primary" id="refundYes">' + icon('check') + 'Перерасчёт сделали</button><button class="btn" id="refundNo">Не сделали</button></div>';
    return html + '</section>';
  }

  /** Суммы требования — как в документе (escalation.ts): положено по квитанциям минус вернули, штраф — половина. */
  function fineMoney(c) {
    var expected = 0, known = false;
    c.months.forEach(function (m) { if (m.percent > 0 && m.bill) { known = true; expected += refundOf(m.bill, m.percent); } });
    if (!known) return null;
    var excess = Math.max(0, Math.round((expected - (c.status === 'refunded' ? c.refundAmount || 0 : 0)) * 100) / 100);
    return excess > 0 ? { excess: excess, fine: Math.round(excess * 50) / 100 } : null;
  }
  function escalationButtons(c) {
    // Штраф 50% платят жителю (ч. 6 ст. 157 ЖК) — так и пишем, с суммами, иначе «штраф — это мне? сколько?».
    var fm = fineMoney(c);
    var fineText = c.status === 'refunded'
      ? (fm ? 'Требование: вернуть ещё ≈ ' + rub(fm.excess) + ' и выплатить вам штраф ≈ ' + rub(fm.fine) : 'Требование: вернуть остальное и выплатить вам штраф 50%')
      : (fm ? 'Требование: перерасчёт ≈ ' + rub(fm.excess) + ' и штраф вам ≈ ' + rub(fm.fine) : 'Требование: сделать перерасчёт и выплатить вам штраф 50%');
    return '<div class="actions stack">' +
      '<button class="btn" data-esc="fine">' + icon('doc') + esc(fineText) + '</button>' +
      '<button class="btn" data-esc="gji">' + icon('doc') + 'Жалоба в жилищную инспекцию</button>' +
      // Общество потребителей идёт в суд — при сумме меньше 1 000 ₽ это не стоит усилий, кнопку не показываем.
      (c.estimate >= 1000 ? '<button class="btn" data-esc="ozpp">' + icon('doc') + 'Заявление в общество защиты прав потребителей</button>' : '') + '</div>';
  }

  /** Перерасчёт не сделали: документы, чтобы довести дело до денег. */
  function escalationSection(c) {
    var cl = c.claim || {};
    return '<section class="now"><p class="kicker">Сейчас</p><h2>Перерасчёт не сделали — потребуйте</h2>' +
      '<p>Сначала — требование туда же, куда подавали заявление: за то, что не сделали перерасчёт, положен штраф 50%. Не помогло — жалоба в жилищную инспекцию.</p>' +
      (cl.submittedAt ? '' : '<p class="note">Укажите, когда подали заявление, — дата попадёт в документы.</p>') + submittedForm(c) +
      escalationButtons(c) +
      '<p class="sub-h">Всё-таки вернули?</p><label for="refundAmount">Сколько вернули, ₽</label><input id="refundAmount" inputmode="decimal" placeholder="Например: 115,20">' +
      '<div class="actions"><button class="btn" id="refundYes">' + icon('check') + 'Отметить, что вернули</button></div></section>';
  }

  function refundedSection(c) {
    var partial = c.refundAmount && c.estimate > 0 && c.refundAmount < c.estimate * 0.9;
    return '<section class="sheet hero">' +
      (c.refundAmount ? '<p class="hero-label">Вернули</p><p class="hero-sum">' + rub(c.refundAmount) + '</p>' : '<h2>Перерасчёт получен</h2><p>Сумма не указана — впишите её ниже, чтобы она попала в итог «Вернули».</p>') +
      (partial ? '<p class="hero-note">По расчёту положено ≈ ' + rub(c.estimate) + '. Остальное можно потребовать:</p>' +
        ((c.claim || {}).submittedAt ? '' : '<p class="note">Укажите, когда подали заявление, — дата попадёт в требование и жалобу.</p>') + submittedForm(c) +
        escalationButtons(c) : '') +
      '<details class="more"' + (c.refundAmount ? '' : ' open') + '><summary>Исправить сумму или снять отметку</summary>' +
      '<label for="refundAmount">Сколько вернули, ₽</label><input id="refundAmount" inputmode="decimal" value="' + (c.refundAmount ? String(c.refundAmount).replace('.', ',') : '') + '">' +
      '<div class="actions"><button class="btn" id="refundYes">Сохранить сумму</button></div>' +
      '<button class="linklike" id="refundUndo">Снять отметку «вернули»</button></details>' +
      '<div class="actions"><button class="btn" id="pdf">' + icon('doc') + 'Заявление (PDF)</button></div></section>';
  }

  function formValues() {
    var v = function (id) { var el = $(id); return el ? el.value.trim() : undefined; };
    var bills = {};
    each('.bill', function (el) { bills[el.getAttribute('data-month')] = el.value.trim(); });
    var coldTariff = {};
    each('.ct', function (el) {
      var m = el.getAttribute('data-month');
      coldTariff[m] = coldTariff[m] || {};
      coldTariff[m][el.getAttribute('data-k')] = el.value.trim();
    });
    return { coldTariff: coldTariff, adsOperator: $('adsOperator') ? v('adsOperator') : undefined, executor: v('executor'), executorInn: v('inn'), executorType: v('etype'), fio: v('fio'), flat: v('flat'), account: v('account'), bills: bills, remember: $('remember') ? $('remember').checked : undefined };
  }

  function bindCase(c) {
    each('a[data-ext]', openExternal);
    var dirty = false;
    each('input, select', function (el) {
      el.addEventListener('input', function () {
        if (!dirty && WebApp && WebApp.enableClosingConfirmation) try { quiet(WebApp.enableClosingConfirmation()); } catch (e) {}
        dirty = true;
      });
    });

    function save() {
      return api('PUT', '/api/cases/' + c.id + '/claim', formValues()).then(function (data) {
        dirty = false;
        try { WebApp && quiet(WebApp.disableClosingConfirmation()); } catch (e) {}
        return data;
      });
    }

    // Введённое сохраняется само — уйти с экрана, не нажав «Скачать», можно без потерь.
    var autoTimer = null;
    function autosave() {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(function () {
        if (!dirty || !$('pdf') || c.status === 'refunded') return;
        save().then(function (data) {
          clearErrors();
          // Сменили получателя или плату в уже скачанном заявлении — говорим сразу, а не при следующем открытии.
          var nc = (data && data.case) || {};
          var outdated = c.status === 'claim_ready' && !c.claimOutdated && nc.claimOutdated;
          // Получатель виден и наверху («Подайте … в …», «Что записано») — сменили его ещё раз, перерисовываем тоже.
          var recipient = c.status === 'claim_ready' && ((nc.claim || {}).executor || '') !== ((c.claim || {}).executor || '');
          if ($('claimStatus')) $('claimStatus').textContent = '✓ Сохранено';
          if (outdated || recipient) {
            toast('Сохранено. ' + innNote + (nc.claimOutdated ? 'Скачанное раньше заявление устарело — скачайте новое.' : ''));
            renderCase(c.id, false, false, true);
          } else if (innNote) toast(innNote + 'ИНН нового можно вписать в «Дополнительно».');
          innNote = '';
        }).catch(function (e) {
          if ($('claimStatus')) $('claimStatus').textContent = '⚠️ Не сохранено — исправьте поле с ошибкой';
          showErrors(e);
        });
      }, 700);
    }
    // ИНН относится к получателю: сменили получателя — прежний ИНН в заявлении оказался бы чужим.
    var innFor = $('executor') ? $('executor').value.trim() : '';
    // Сообщение про ИНН — вместе с «Сохранено» после автосохранения: два всплывающих подряд затирали друг друга.
    var innNote = '';
    if ($('inn')) $('inn').addEventListener('input', function () { innFor = $('executor').value.trim(); });
    if ($('executor')) $('executor').addEventListener('change', function () {
      var name = $('executor').value.trim();
      if ($('inn').value.trim() && name !== innFor) {
        $('inn').value = '';
        innNote = 'ИНН прежнего получателя убрал из заявления. ';
      }
      innFor = name;
    });
    each('#executor, #inn, #etype, #fio, #flat, #account, #adsOperator, #remember, .bill, .ct', function (el) {
      el.addEventListener('change', autosave);
    });
    each('.bill, .ct', function (el) { el.addEventListener('input', autosave); });

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
        if (bill > 0) sum += refundOf(bill, m.percent);
        else missing.push(monthTitle(m.month));
      });
      // Часы «по тарифу холодной воды»: объём и тарифы из квитанции.
      c.months.forEach(function (m) {
        if (!(m.coldTariffHours >= 1) || !$('ct_vol_' + m.month)) return;
        var ct = { volume: num($('ct_vol_' + m.month).value), hot: num($('ct_hot_' + m.month).value), cold: num($('ct_cold_' + m.month).value) };
        if (ct.volume && ct.hot && ct.cold) sum += coldAmount(m.month, m.coldTariffHours, ct);
      });
      // Своя квартира — по вписанной плате; другие квартиры — по их сохранённым заявлениям.
      if ($('xfOwn')) $('xfOwn').textContent = sum > 0 ? '≈ ' + rub(Math.round(sum * 100) / 100) : 'плата не вписана';
      sum += (c.extraFlats || []).reduce(function (s, f) { return s + f.estimate; }, 0);
      if ($('heroBox')) $('heroBox').hidden = !(sum > 0);
      if ($('moneyH')) $('moneyH').hidden = sum > 0;
      t.textContent = '≈ ' + rub(Math.round(sum * 100) / 100);
      // Расклад «начислено — вернуть» по месяцам — тоже сразу.
      c.months.forEach(function (m) {
        if (m.percent <= 0) return;
        var inp = $('bill_' + m.month);
        var bill = inp ? parseMoney(inp.value) : m.bill;
        if ($('bv_' + m.month)) $('bv_' + m.month).textContent = bill > 0 ? rub(bill) : '—';
        if ($('ret_' + m.month)) $('ret_' + m.month).textContent = bill > 0 ? rub(refundOf(bill, m.percent)) : '—';
      });
      var note = $('liveNote');
      if (note) {
        var anyInputs = !!root.querySelector('.bill');
        // Квитанции за текущий месяц ещё нет — подсказка в той же строке, а не второй подряд.
        var thisMonth = monthKeyOf(new Date().toISOString());
        var fresh = c.months.filter(function (m) { return m.percent > 0 && m.month >= thisMonth && $('bill_' + m.month) && !parseMoney($('bill_' + m.month).value); })[0];
        var prev = fresh ? ' (квитанции за ' + monthTitle(fresh.month).split(' ')[0] + ' ещё нет — возьмите прошлую)' : '';
        var firstBill = root.querySelector('.bill');
        var inFold = !!(firstBill && firstBill.closest('#claimBox'));
        note.textContent = !(anyInputs && missing.length) ? ''
          : inFold ? 'Впишите плату из квитанции в «Исправить данные заявления» ниже' + prev + ' и скачайте заявление заново — в нём появятся рубли.'
            : sum > 0 ? 'Впишите плату за ' + missing.join(', ') + prev + ' — сумма будет больше.' : 'Впишите сумму из квитанции' + prev + ': покажу рубли.';
        note.hidden = !note.textContent;
      }
    }
    each('.bill, .ct', function (el) { el.addEventListener('input', liveTotal); });

    // Другие квартиры в доме: добавить, скачать заявление, удалить.
    function saveFlats(list, errMap) {
      return api('PUT', '/api/cases/' + c.id + '/extra-flats', { flats: list })
        .then(function () { renderCase(c.id, false, true); return true; })
        .catch(function (e) { showErrors(e, errMap); return false; });
    }
    var baseFlats = (c.extraFlats || []).map(function (f) { return { flat: f.flat, account: f.account, bills: f.bills }; });
    if ($('xfAdd')) $('xfAdd').onclick = function () {
      var flat = $('xf_flat_new').value.trim();
      if (!flat) { showErrors(fieldErr('xf_flat_new', 'Впишите номер квартиры')); return; }
      var bills = {};
      each('.xf-bill', function (el) { if (el.value.trim()) bills[el.getAttribute('data-month')] = el.value.trim(); });
      var n = baseFlats.length;
      var map = {};
      map['xf_flat_' + n] = 'xf_flat_new';
      c.months.forEach(function (m) { map['xf_bill_' + n + '_' + m.month] = 'xf_bill_new_' + m.month; });
      saveFlats(baseFlats.concat([{ flat: flat, account: $('xf_acc_new').value.trim() || undefined, bills: bills }]), map).then(function (ok) { if (ok) toast('Квартира добавлена — скачайте заявление на неё'); });
    };
    each('[data-xf-del]', function (b) {
      b.onclick = function () {
        var i = Number(b.getAttribute('data-xf-del'));
        if (!confirm('Убрать кв. ' + baseFlats[i].flat + ' из этого дела?')) return;
        saveFlats(baseFlats.filter(function (_, j) { return j !== i; }));
      };
    });
    each('[data-xf-pdf]', function (b) {
      b.onclick = function () {
        var done = busy(b, 'Готовлю…');
        (dirty ? save() : Promise.resolve()).then(function () {
          return api('POST', '/api/cases/' + c.id + '/pdf-link', { extra: Number(b.getAttribute('data-xf-pdf')) });
        }).then(function (r) { return download(r.url, r.fileName).then(function () { toast('Заявление на эту квартиру скачивается'); setTimeout(function () { renderCase(c.id); }, 1200); }); })
          .catch(function (e) { toast(e.message); }).then(done);
      };
    });
    liveTotal();

    bindTimeChips('endChips', 'ended');
    var endBtn = $('endBtn');
    if (endBtn) endBtn.onclick = function () {
      if (!$('ended').value) { showErrors(fieldErr('ended', 'Выберите время кнопкой выше или впишите своё')); return; }
      var done = busy(endBtn, 'Считаю…');
      api('POST', '/api/cases/' + c.id + '/end', { endedAt: new Date($('ended').value).toISOString() }).then(function (r) {
        haptic('success');
        track('app_end');
        toast(r.case && r.case.status === 'closed' ? 'Записал. Это было в пределах допустимого — денег не положено' : 'Записал — посчитал, сколько положено');
        renderCase(c.id);
      }).catch(function (e) { showErrors(e.fields ? e : fieldErr('ended', e.message)); done(); });
    };

    var readingBtn = $('addReading');
    if (readingBtn) readingBtn.onclick = function () {
      var errs = {};
      if (!$('newTemp').value.trim()) errs.newTemp = 'Впишите, сколько градусов показал термометр';
      if (!$('newTempAt').value) errs.newTempAt = 'Укажите, когда измерили';
      if (Object.keys(errs).length) { showErrors({ message: 'Заполните отмеченные поля', fields: errs }); return; }
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
      if (!$('editStart').value) { showErrors(fieldErr('editStart', 'Укажите время начала')); return; }
      if ($('editEnd') && !$('editEnd').value) { showErrors(fieldErr('editEnd', 'Укажите время окончания' + ($('reopen') ? ' — или нажмите «' + notYet(c) + '» ниже' : ''))); return; }
      if ($('editStart').value === toLocalInput(c.startedAt) && (!$('editEnd') || $('editEnd').value === toLocalInput(c.endedAt))) {
        toast('Время не изменилось');
        $('timesBox').hidden = true;
        return;
      }
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
      (dirty && $('pdf') ? save().catch(function () {}) : Promise.resolve()).then(function () { return api('POST', '/api/cases/' + c.id + '/reopen'); }).then(function () {
        var t = (END_TITLE[c.service] || 'Когда починят — отметьте здесь').replace(' — отметьте здесь', '');
        toast('Вернул в отслеживание — отметьте, ' + t.charAt(0).toLowerCase() + t.slice(1) + '.');
        renderCase(c.id);
      }).catch(function (e) { toast(e.message); done(); });
    };

    var delBtn = $('deleteCase');
    if (delBtn) delBtn.onclick = function () {
      var extra = c.status === 'refunded' && c.refundAmount ? ' Сумма ' + rub(c.refundAmount) + ' уйдёт из итога «Вернули».' : '';
      var what = c.status === 'tracking' || c.status === 'ended' ? 'вместе с расчётом' : 'вместе с расчётом и заявлением';
      if (!confirm('Удалить это дело ' + what + '? Отменить будет нельзя.' + extra)) return;
      api('DELETE', '/api/cases/' + c.id).then(function () { toast('Дело удалено'); home(); }).catch(function (e) { toast(e.message); });
    };

    function refund(action) {
      var amount = $('refundAmount') ? $('refundAmount').value.trim() : '';
      var n = parseMoney(amount);
      // Сумма сильно больше расчёта — скорее опечатка: переспрашиваем, прежде чем она уйдёт в итог.
      if (action === 'yes' && n !== null && c.estimate > 0 && n > Math.max(c.estimate * 3, c.estimate + 500)) {
        if (!confirm('Вы вписали ' + rub(n) + ', а по расчёту положено ≈ ' + rub(c.estimate) + '. Всё верно?')) return;
      }
      return api('POST', '/api/cases/' + c.id + '/receipt', { action: action, amount: amount }).then(function () {
        haptic('success');
        track('app_refund_' + action);
        var partial = n && c.estimate > 0 && n < c.estimate * 0.9;
        toast(action === 'yes'
          ? (partial ? 'Записал: вернули ' + rub(n) + ' из ≈ ' + rub(c.estimate) + '. Остальное можно потребовать' : n ? 'Отлично! Записал: вернули ' + rub(n) : 'Записал, что вернули. Сумму можно вписать позже')
          : action === 'no' ? 'Понял. Документы, чтобы довести дело до денег, — вверху' : 'Отметку сняли');
        renderCase(c.id);
      }).catch(function (e) { showErrors(e); });
    }
    if ($('refundYes')) $('refundYes').onclick = function () { refund('yes'); };
    if ($('refundNo')) $('refundNo').onclick = function () { refund('no'); };
    if ($('refundUndo')) $('refundUndo').onclick = function () { refund('undo'); };

    if ($('subEdit')) $('subEdit').onclick = function () { $('subBox').hidden = !$('subBox').hidden; };
    var subTimer = null;
    function autoSubmitted() {
      clearTimeout(subTimer);
      subTimer = setTimeout(function () {
        if (!$('submittedAt')) return;
        var number = $('incoming').value.trim();
        if (!$('submittedAt').value) {
          if (number && $('subStatus')) $('subStatus').textContent = 'Укажите дату подачи — без неё номер не сохранится.';
          return;
        }
        api('POST', '/api/cases/' + c.id + '/submitted', { date: $('submittedAt').value + 'T12:00:00', number: number || undefined }).then(function () {
          clearErrors();
          var d = $('submittedAt').value.split('-');
          toast('Записал: подано ' + d[2] + '.' + d[1] + '.' + d[0] + (number ? ', вх. № ' + number : ''));
          // Шаги, полоса и статус меняются сразу, а не после перезагрузки.
          renderCase(c.id, false, false, true);
        }).catch(function (e) { showErrors(e); });
      }, 800);
    }
    each('#submittedAt, #incoming', function (el) { el.addEventListener('change', autoSubmitted); });

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
    if ($('pdfTop') && pdfBtn) $('pdfTop').onclick = function () { pdfBtn.onclick(null, $('pdfTop')); };
    if ($('pdfOutdated') && pdfBtn) $('pdfOutdated').onclick = function () { pdfBtn.onclick(null, $('pdfOutdated')); };
    if (pdfBtn) pdfBtn.onclick = function (_e, from) {
      var done = busy(from || pdfBtn, 'Готовлю PDF…');
      (c.status === 'refunded' ? Promise.resolve() : save()).then(function () {
        clearErrors();
        return api('POST', '/api/cases/' + c.id + '/pdf-link');
      }).then(function (r) {
        track('app_pdf');
        return download(r.url, r.fileName).then(function () {
          var noBill = c.status !== 'refunded' && c.months.some(function (m) { return m.percent > 0 && !parseMoney(($('bill_' + m.month) || {}).value || ''); });
          toast(noBill ? 'Заявление скачивается. Платы из квитанции нет — в нём только процент, без рублей' : 'Заявление скачивается');
          // Статус, получатель и «Что дальше» могли измениться — перерисовываем экран.
          setTimeout(function () { renderCase(c.id); }, 1200);
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

    each('#actSigned, #actSignedNoChair', function (signedBtn) {
      signedBtn.onclick = function () {
        var done = busy(signedBtn, 'Сохраняю…');
        api('POST', '/api/cases/' + c.id + '/act/signed', { chair: signedBtn.getAttribute('data-chair') === '1' }).then(function () {
          haptic('success');
          track('app_act_signed');
          toast('Акт подписан — он попадёт в ваше заявление');
          renderCase(c.id);
        }).catch(function (e) { toast(e.message); done(); });
      };
    });
    var unsignBtn = $('actUnsigned');
    if (unsignBtn) unsignBtn.onclick = function () {
      if (!confirm('Снять отметку «подписан»? Если вы уже скачали заявление с актом, его придётся скачать заново.')) return;
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
        innFor = $('executor').value.trim();
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
        toast(r.mid ? 'Карточка в чате с ботом — перешлите её соседям' : 'В демо бот не подключён. В MAX бот пришлёт карточку — перешлите её в чат дома, а соседям с этого адреса я сам напишу «у вас тоже?»');
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
