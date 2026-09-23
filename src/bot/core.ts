// Основной сценарий «Вернём»:
// что случилось → фиксация в АДС → отслеживание → «появилось?» → сумма из квитанции →
// расчёт → заявление (текст + PDF) → через месяц «перерасчёт пришёл?».
//
// Отдельные модули, которые действуют сами, без вопроса жителя:
//   house.ts    — сеть дома: уведомления соседям «у вас тоже?», подъезд, председатель;
//   acts.ts     — акт без исполнителя (п. 110(1)) и вопрос о проверке через 2 часа;
//   photos.ts   — фото к делу;
//   escalate.ts — требование о штрафе 50%, жалоба в ГЖИ, общество защиты прав потребителей.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, Evidence, ExecutorType, Incident, Participant, PhotoKind, ReminderKind } from '../db/db.ts';
import type { HeatingTempNorm, HotWaterTempNorm, Norms, ServiceKey } from '../calc/norms.ts';
import { SERVICE_ORDER } from '../calc/norms.ts';
import { fmtNum, fmtPercent, fmtRub, parseRubles, parseTemperature, plural } from '../calc/format.ts';
import { formatDuration, formatShort, hoursBetween, localParts, fromLocal, monthTitle, parseLocalInput, MS_HOUR } from '../calc/time.ts';
import { claimToPdf } from '../docs/pdf.ts';
import { refundAmount } from '../calc/engine.ts';
import { claimToText } from '../docs/claim.ts';
import type { ClaimDoc } from '../docs/claim.ts';
import {
  askAddressText,
  chooseAddress,
  flushAlerts,
  executorFromHouse,
  joinHouseByCode,
  onAddressButton,
  onAddressText,
  onAlertAnswer,
  onCityButton,
  onCityText,
  onEntranceButton,
  onEntranceText,
  onHouseButton,
  onHouseInfoSkip,
  onHouseInfoText,
  queueHouseAlerts,
  showAddresses,
} from './house.ts';
import { actButtons, inviteToAct, onActButton, onActLink, onActText, onInspection, remindInspection, scheduleInspectionCheck } from './acts.ts';
import { askPhoto, onPhoto, onPhotoPick } from './photos.ts';
import { onEscalate, showEscalation } from './escalate.ts';
import {
  STATUS_TITLE,
  billsOf,
  calcFor,
  claimDocFor,
  claimOf,
  estimate,
  hasMoney,
  loadCase,
} from '../services/cases.ts';
import type { CaseBundle } from '../services/cases.ts';
import type { BotConfig, Btn, Input, OutMessage, Outbox } from './types.ts';
import {
  ICON,
  SEND_HOWTO,
  TIME_HINT,
  actTemplate,
  app,
  backRow,
  cb,
  clean,
  howItWorks,
  link,
  mainMenu,
  relativeTime,
  serviceMenu,
  timeButtons,
} from './ui.ts';

export type Draft = {
  service: ServiceKey;
  houseId?: number;
  skipJoin?: boolean;
  hwChecked?: boolean;
  variant?: string;
  corner?: boolean;
  temp?: number;
  evidence?: Evidence;
  number?: string | null;
};

const MAX_TEXT = 3900;

export class Vernem {
  readonly db: Db;
  readonly norms: Norms;
  readonly out: Outbox;
  readonly cfg: BotConfig;
  readonly now: () => Date;

  constructor(db: Db, norms: Norms, out: Outbox, cfg: BotConfig, now: () => Date = () => new Date()) {
    this.db = db;
    this.norms = norms;
    this.out = out;
    this.cfg = cfg;
    this.now = now;
  }

  // =====================================================================
  // Вход
  // =====================================================================

  async handle(input: Input): Promise<void> {
    try {
      await this.route(input);
    } catch (err) {
      console.error('[bot] ошибка обработки', input.kind, err);
      if ('userId' in input && input.kind !== 'group_text') {
        this.db.setState(input.userId, 'idle');
        await this.safeSend(input.userId, {
          text: 'Что-то пошло не так, и я не смог выполнить действие. Данные случаев сохранены — попробуйте ещё раз или вернитесь в начало.',
          buttons: [[cb('⬅️ В начало', 'menu'), cb('📋 Мои случаи', 'cases')]],
        });
      }
    }
  }

  private async route(input: Input) {
    switch (input.kind) {
      case 'start':
        this.db.ensureUser(input.userId, input.name);
        this.db.track(input.userId, 'start', { payload: input.payload ?? null });
        return this.onStart(input.userId, input.payload ?? null);
      case 'text':
        this.db.ensureUser(input.userId, input.name);
        return this.onText(input.userId, input.text.trim());
      case 'photo':
        this.db.ensureUser(input.userId, input.name);
        return onPhoto(this, input.userId, input.photos);
      case 'button':
        this.db.ensureUser(input.userId, input.name);
        return this.onButton(input.userId, input.payload);
      case 'group_added':
        return this.onGroupAdded(input.chatId, input.title ?? null);
      case 'group_removed':
        this.db.removeChat(input.chatId);
        return;
      case 'group_text':
        return this.onGroupText(input.chatId, input.userId, input.text.trim());
    }
  }

  // Методы ниже без private: ими пользуются модули house.ts, acts.ts, photos.ts, escalate.ts.

  send(userId: number, msg: OutMessage) {
    if (msg.text.length > MAX_TEXT) msg = { ...msg, text: msg.text.slice(0, MAX_TEXT - 1) + '…' };
    return this.out.toUser(userId, msg);
  }

  async safeSend(userId: number, msg: OutMessage) {
    try {
      return await this.send(userId, msg);
    } catch (e) {
      console.error('[bot] не удалось отправить сообщение', userId, e);
      return {};
    }
  }

  menu(): Btn[][] {
    return mainMenu({ demo: this.cfg.demoMode, app: this.cfg.miniAppEnabled });
  }

  private deepLink(code: string) {
    return `https://max.ru/${this.cfg.botUsername}?start=j_${code}`;
  }

  private tz(houseId?: number | null) {
    return (houseId && this.db.getHouse(houseId)?.tz) || this.cfg.defaultTz;
  }

  /** Кнопка мини-приложения; payload — экран, который откроется (например, `house_12`). */
  appButton(text: string, payload?: string): Btn {
    return app(text, payload);
  }

  askPhoto(userId: number, pid: number, kind: PhotoKind) {
    return askPhoto(this, userId, pid, kind);
  }

  /** Вызывается планировщиком для каждого наступившего напоминания. */
  remind(kind: ReminderKind, pid: number) {
    if (kind === 'ask_restored') return this.remindRestored(pid);
    if (kind === 'ask_receipt') return this.remindReceipt(pid);
    return remindInspection(this, pid);
  }

  /** Отправляет наступившие уведомления соседям (ночные уходят в 08:00). */
  flushAlerts() {
    return flushAlerts(this);
  }

  // =====================================================================
  // Мини-приложение: те же правила, что и в чате
  // =====================================================================

  /**
   * Сообщение о проблеме из мини-приложения. Если в доме уже есть такое открытое отключение —
   * житель присоединяется к нему. Бот пишет в чат то же, что при сообщении из чата.
   * Возвращает id дела или текст ошибки для жителя.
   */
  async reportFromApp(
    userId: number,
    r: { houseId: number; service: ServiceKey; evidence: Evidence; number: string | null; startedAt: Date; temp?: number; corner?: boolean; variant?: string; planned?: boolean },
  ): Promise<{ pid: number } | { error: string }> {
    const norm = this.norms.services[r.service];
    if (!this.db.getUserHouse(userId, r.houseId)) return { error: 'Этого адреса нет в вашем списке' };
    if (r.service === 'hot_water_off' && r.planned) return { error: 'За плановое летнее отключение доплаты не положено: со счётчиком вы и так не платите за неизрасходованную воду.' };
    if (norm.kind !== 'interruption') {
      if (r.temp === undefined) return { error: 'Укажите температуру' };
      const threshold =
        norm.kind === 'heating_temperature'
          ? r.corner
            ? (norm.temperature as HeatingTempNorm).corner_norm_c
            : (norm.temperature as HeatingTempNorm).norm_c
          : (norm.temperature as HotWaterTempNorm).norm_c - (norm.temperature as HotWaterTempNorm).day_tolerance_c;
      if (r.temp >= threshold) return { error: `+${fmtNum(r.temp, 1)} °C — это норма (не ниже +${threshold} °C), доплаты не положено.` };
    }
    this.db.addUserHouse(userId, r.houseId);
    this.db.track(userId, 'report_started', { service: r.service, via: 'app' });
    const open = this.db.findOpenIncident(r.houseId, r.service);
    if (open) {
      const mine = this.db.getParticipantFor(open.id, userId);
      if (mine) return { pid: mine.id };
      await this.completeJoin(userId, open, norm.kind === 'interruption' ? null : r.temp!, !!r.corner);
      return { pid: this.db.getParticipantFor(open.id, userId)!.id };
    }
    await this.createIncident(
      userId,
      { service: r.service, houseId: r.houseId, evidence: r.evidence, number: r.number, variant: r.variant, corner: r.corner, temp: r.temp, hwChecked: true },
      r.startedAt,
    );
    return { pid: this.db.listUserParticipants(userId)[0].id };
  }

  /** «Починили» из мини-приложения. */
  async endFromApp(userId: number, pid: number, endedAt: Date): Promise<string | null> {
    const c = this.ownCase(userId, pid);
    if (!c) return 'Дело не найдено';
    if (c.p.status !== 'tracking') return 'Окончание уже записано';
    if (endedAt.getTime() <= new Date(c.p.started_at).getTime()) return 'Время окончания должно быть позже начала';
    if (endedAt.getTime() > this.now().getTime() + 5 * 60_000) return 'Это время ещё не наступило';
    await this.setEnded(userId, c, endedAt);
    return null;
  }

  /** Житель скачал заявление в приложении — значит, оно готово: через месяц спросим про квитанцию. */
  markClaimIssued(pid: number) {
    const c = loadCase(this.db, pid);
    if (!c || c.p.status !== 'ended') return;
    this.db.updateParticipant(pid, { status: 'claim_ready', claim: JSON.stringify({ ...claimOf(c.p), createdAt: this.now().toISOString() }) });
    this.db.track(c.p.user_id, 'claim_created', { service: c.incident.service_key, via: 'app' });
    const due = this.cfg.fastReminders ? new Date(this.now().getTime() + 3 * 60_000) : this.quietShift(new Date(this.now().getTime() + this.cfg.receiptCheckDays * 24 * MS_HOUR), c.house.tz);
    this.db.schedule('ask_receipt', pid, c.p.user_id, due);
  }

  // =====================================================================
  // Старт, команды, меню
  // =====================================================================

  private async onStart(userId: number, payload: string | null) {
    this.db.setState(userId, 'idle');
    if (payload?.startsWith('j_')) return this.joinByCode(userId, payload.slice(2));
    if (payload?.startsWith('h_')) return joinHouseByCode(this, userId, payload.slice(2));
    if (payload?.startsWith('a_')) return onActLink(this, userId, payload.slice(2));
    if (payload === 'demo' && this.cfg.demoMode) return this.startDemo(userId);
    return this.welcome(userId);
  }

  welcome(userId: number) {
    return this.send(userId, {
      text: 'Привет! Я **«Вернём»** 👋\nОтключили воду, свет или в квартире холодно? По закону за это положено снизить плату. Я помогу всё записать, посчитать и получить деньги — по шагам.',
      buttons: this.menu(),
    });
  }

  private async onText(userId: number, text: string) {
    if (text.startsWith('/')) return this.onCommand(userId, text);
    const { state, data } = this.db.getState<any>(userId);
    switch (state) {
      case 'await_city':
        return onCityText(this, userId, text, data);
      case 'await_address':
        return onAddressText(this, userId, text, data);
      case 'await_temp':
        return this.onTemperature(userId, text, data);
      case 'await_number':
        return this.onNumber(userId, text, data.draft);
      case 'await_time_start':
        return this.onStartTimeText(userId, text, data.draft);
      case 'await_time_end':
        return this.onEndTimeText(userId, text, data.pid);
      case 'await_bill':
        return this.onBill(userId, text, data);
      case 'await_fio':
      case 'await_flat':
      case 'await_account':
      case 'await_executor':
        return this.onPersonal(userId, state, text, data.pid);
      case 'await_refund':
        return this.onRefund(userId, text, data.pid);
      case 'await_own_number':
        return this.onOwnNumber(userId, text, data.pid);
      case 'await_house_info':
        return onHouseInfoText(this, userId, text, data);
      case 'await_entrance':
        return onEntranceText(this, userId, text, data);
      case 'await_act_fio':
      case 'await_act_flat':
        return onActText(this, userId, state, text, data);
      case 'await_photo':
        return this.send(userId, { text: 'Жду фото: прикрепите его к сообщению (скрепка → фото).', buttons: [[cb('⬅️ К случаю', `cs:${data.pid}`)]] });
      default:
        return this.send(userId, {
          text: 'Я работаю через кнопки. Выберите, что случилось, или откройте свои случаи.',
          buttons: this.menu(),
        });
    }
  }

  private async onCommand(userId: number, text: string) {
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    const arg = text.split(/\s+/)[1];
    switch (cmd) {
      case '/start':
        return this.onStart(userId, arg ?? null);
      case '/menu':
      case '/cancel':
        this.db.setState(userId, 'idle');
        return this.welcome(userId);
      case '/cases':
        return this.showCases(userId);
      case '/house':
        return showAddresses(this, userId);
      case '/help':
        return this.send(userId, { text: howItWorks(this.norms), buttons: [backRow()] });
      case '/delete_me':
        return this.send(userId, {
          text: 'Удалить все ваши данные: адрес, ФИО, случаи и заявления? Это действие нельзя отменить.',
          buttons: [[cb('🗑 Да, удалить всё', 'delme'), cb('Отмена', 'menu')]],
        });
      case '/stats':
        if (!this.cfg.adminIds.includes(userId)) break;
        return this.send(userId, { text: this.statsText() });
    }
    return this.send(userId, { text: 'Такой команды нет. Вот что я умею:', buttons: this.menu() });
  }

  private statsText() {
    const f = this.db.funnel();
    const names: [string, string][] = [
      ['start', 'Открыли бота'],
      ['report_started', 'Начали сообщение о поломке'],
      ['fixed', 'Зафиксировали нарушение'],
      ['restored', 'Отметили восстановление'],
      ['calc_done', 'Получили расчёт'],
      ['claim_created', 'Получили заявление'],
      ['card_created', 'Позвали соседей'],
      ['alert_sent', 'Получили уведомление «у вас тоже?»'],
      ['alert_yes', 'Ответили «да» на уведомление'],
      ['neighbour_joined', 'Присоединились к отключению соседа'],
      ['house_joined', 'Подключились к сети дома по ссылке'],
      ['act_started', 'Начали собирать акт'],
      ['act_ready', 'Собрали акт полностью'],
      ['act_signed', 'Отметили акт подписанным'],
      ['photo_added', 'Прислали фото'],
      ['refund_yes', 'Получили перерасчёт'],
      ['refund_no', 'Перерасчёт не сделали'],
      ['escalation_fine', 'Требование о штрафе 50%'],
      ['escalation_gji', 'Жалоба в ГЖИ'],
      ['escalation_ozpp', 'Заявление в общество потребителей'],
    ];
    return ['**Воронка (уникальные пользователи)**', ...names.map(([k, t]) => `${t}: ${f[k] ?? 0}`)].join('\n');
  }

  // =====================================================================
  // Кнопки
  // =====================================================================

  private async onButton(userId: number, payload: string) {
    const [head, a, b] = payload.split(':');
    const pid = Number(a);

    switch (head) {
      case 'menu':
        this.db.setState(userId, 'idle');
        return this.welcome(userId);
      case 'how':
        return this.send(userId, { text: howItWorks(this.norms), buttons: [[cb('🚨 Что-то сломалось', 'new')], backRow()] });
      case 'new':
        this.db.setState(userId, 'idle');
        return this.send(userId, { text: 'Что случилось? Выберите ближайший вариант.', buttons: serviceMenu(this.norms) });
      case 'svc': {
        if (!SERVICE_ORDER.includes(a as ServiceKey)) return this.stale(userId);
        this.db.track(userId, 'report_started', { service: a });
        // Адрес выберет chooseAddress: один адрес — сразу он, несколько — спросим «Где?».
        return this.continueDraft(userId, { service: a as ServiceKey });
      }
      case 'addr': {
        const draft = this.draftFromState(userId);
        return askAddressText(this, userId, { draft: draft ? { ...draft, houseId: undefined, skipJoin: false } : undefined });
      }
      case 'adr':
      case 'adrpick':
      case 'adrnew':
      case 'adrtxt':
        return onAddressButton(this, userId, head, a);
      case 'cty':
        return onCityButton(this, userId, a);
      case 'crj':
        return this.onJoinCorner(userId, pid, b === '1');
      case 'jn':
        return this.onJoinChoice(userId, a);
      case 'hw':
      case 'el':
      case 'cr':
      case 'fx':
      case 'fb':
        return this.onDraftButton(userId, head, a);
      case 'ts':
        return this.onStartTimeButton(userId, a);
      case 'rest':
        return this.onRestoredAnswer(userId, pid, b);
      case 'te':
        return this.onEndTimeButton(userId, pid, b);
      case 'tmp':
        return this.askTemperature(userId, { purpose: 'update', pid });
      case 'same':
        return this.onSameAnswer(userId, pid, b);
      case 'own':
        if (!this.ownCase(userId, pid)) return this.stale(userId);
        this.db.setState(userId, 'await_own_number', { pid });
        return this.send(userId, { text: 'Напишите регистрационный номер, который вам назвал диспетчер АДС.', buttons: [backRow()] });
      case 'nb':
        return this.sendNeighbourCard(userId, pid);
      case 'post':
        return this.postToHouseChat(userId, pid);
      case 'calc':
        return this.resumeCalculation(userId, pid);
      case 'billskip':
        return this.onBillSkip(userId);
      case 'ex':
        return this.onExecutorType(userId, pid, b as ExecutorType | 'ask', payload.split(':')[3]);
      case 'pd':
        return this.onPersonalChoice(userId, pid, b);
      case 'skip':
        return this.onPersonalSkip(userId);
      case 'sv':
        return this.issueClaim(userId, pid, b === '1');
      case 'doc':
        return this.resendClaim(userId, pid);
      case 'send':
        return this.send(userId, { text: SEND_HOWTO, buttons: [[cb('📋 Мои случаи', 'cases')], backRow()] });
      case 'rc':
        return this.onReceiptAnswer(userId, pid, b);
      case 'rfskip':
        return this.finishRefund(userId, pid, null);
      case 'cases':
        return this.showCases(userId);
      case 'cs':
        return this.showCase(userId, pid);
      case 'stop':
        return this.stopCase(userId, pid, b === 'y');
      case 'act':
        return this.send(userId, { text: actTemplate(this.norms.services[a as ServiceKey]?.title ?? 'коммунальная услуга', this.addressOf(userId)) });
      case 'demo':
        return this.cfg.demoMode ? this.startDemo(userId) : this.stale(userId);
      case 'house':
        return showAddresses(this, userId);
      case 'hs':
        return onHouseButton(this, userId, a, Number(b));
      case 'hsi':
        return onHouseInfoSkip(this, userId, pid, Number(b));
      case 'ent':
        return onEntranceButton(this, userId, a);
      case 'al':
        return onAlertAnswer(this, userId, pid, b);
      case 'ak':
        return onActButton(this, userId, a, b, payload.split(':')[3]);
      case 'insp':
        return onInspection(this, userId, pid, b);
      case 'ph':
        return onPhotoPick(this, userId, pid);
      case 'phadd':
        return this.askPhoto(userId, pid, (['evidence', 'receipt', 'act'].includes(b) ? b : 'evidence') as PhotoKind);
      case 'esc':
        return onEscalate(this, userId, pid, b);
      case 'escm':
        return showEscalation(this, userId, pid);
      case 'delme':
        this.db.deleteUserData(userId);
        return this.send(userId, { text: 'Готово: все ваши данные удалены. Если понадоблюсь — нажмите /start.' });
      default:
        return this.stale(userId);
    }
  }

  stale(userId: number) {
    return this.send(userId, { text: 'Эта кнопка уже неактуальна. Начнём с главного меню.', buttons: this.menu() });
  }

  ownCase(userId: number, pid: number): CaseBundle | null {
    const c = Number.isFinite(pid) ? loadCase(this.db, pid) : null;
    return c && c.p.user_id === userId ? c : null;
  }

  private addressOf(userId: number) {
    const u = this.db.getUser(userId);
    return (u?.house_id && this.db.getHouse(u.house_id)?.address) || '__________';
  }

  // =====================================================================
  // Новое сообщение о поломке: черновик до фиксации
  // =====================================================================

  private draftFromState(userId: number): Draft | null {
    return this.db.getState<any>(userId).data?.draft ?? null;
  }

  private saveDraft(userId: number, state: string, draft: Draft, extra: object = {}) {
    this.db.setState(userId, state, { draft, ...extra });
  }

  /** Проверяет, чего не хватает в черновике, и задаёт следующий вопрос. */
  async continueDraft(userId: number, draft: Draft): Promise<unknown> {
    const norm = this.norms.services[draft.service];

    if (!draft.houseId) return chooseAddress(this, userId, draft);
    const house = this.db.getHouse(draft.houseId)!;

    if (!draft.skipJoin) {
      const open = this.db.findOpenIncident(draft.houseId, draft.service);
      if (open) {
        const mine = this.db.getParticipantFor(open.id, userId);
        if (mine) return this.showCase(userId, mine.id);
        const count = this.db.listParticipants(open.id).length;
        this.saveDraft(userId, 'draft', draft);
        return this.send(userId, {
          text: `Соседи уже сообщили: **${norm.button.toLowerCase()}** с ${formatShort(new Date(open.started_at), house.tz)}${open.ads_number ? `, заявка № ${clean(open.ads_number)}` : ''} (${count} ${plural(count, ['житель', 'жителя', 'жителей'])}). У вас то же самое?`,
          buttons: [[cb('✅ Да, присоединиться', `jn:${open.id}`)], [cb('Нет, у меня другое', 'jn:new')], backRow()],
        });
      }
    }

    if (draft.service === 'hot_water_off' && !draft.hwChecked) {
      this.saveDraft(userId, 'draft', draft);
      return this.send(userId, {
        text: 'Отключили внезапно или по плану (летом, с объявлением на подъезде)?',
        buttons: [[cb('Внезапно / авария', 'hw:sudden'), cb('По плану', 'hw:planned')], backRow()],
      });
    }

    if (draft.service === 'electricity_off' && !draft.variant) {
      if (house.electricity_variant) {
        draft.variant = house.electricity_variant;
      } else {
        this.saveDraft(userId, 'draft', draft);
        return this.send(userId, {
          text: 'Сколько у дома вводов электричества? Обычно два — у многоэтажек с лифтами. Не знаете — посчитаю по строгому варианту.',
          buttons: [[cb('Два', 'el:two_sources'), cb('Один / не знаю', 'el:one_source')], backRow()],
        });
      }
    }

    if (draft.service === 'heating_temp' && draft.corner === undefined) {
      this.saveDraft(userId, 'draft', draft);
      return this.send(userId, {
        text: 'Комната угловая? Для угловой норма +20 °C, для обычной +18 °C.',
        buttons: [[cb('Обычная', 'cr:0'), cb('Угловая', 'cr:1')], backRow()],
      });
    }

    if ((norm.kind === 'heating_temperature' || norm.kind === 'hot_water_temperature') && draft.temp === undefined) {
      return this.askTemperature(userId, { purpose: 'initial', draft });
    }

    if (!draft.evidence) return this.askFixation(userId, draft);
    if (draft.number === undefined) {
      this.saveDraft(userId, 'await_number', draft);
      return this.send(userId, {
        text:
          draft.evidence === 'ads' ? 'Номер заявки, который назвал диспетчер:' : 'Номер вашего обращения (если есть):',
        buttons: [[cb('Номера нет', 'fb:nonum')], backRow()],
      });
    }
    return this.askStartTime(userId, draft);
  }


  private async onJoinChoice(userId: number, value: string) {
    const draft = this.draftFromState(userId);
    if (value === 'new') {
      if (!draft) return this.stale(userId);
      return this.continueDraft(userId, { ...draft, skipJoin: true });
    }
    const incident = this.db.getIncident(Number(value));
    if (!incident) return this.stale(userId);
    return this.joinIncident(userId, incident);
  }

  private async onDraftButton(userId: number, head: string, value: string) {
    const draft = this.draftFromState(userId);
    if (!draft) return this.stale(userId);
    const norm = this.norms.services[draft.service];

    if (head === 'hw') {
      if (value === 'planned') {
        this.db.setState(userId, 'idle');
        return this.send(userId, {
          text: 'За плановое летнее отключение доплаты не положено: со счётчиком вы и так не платите за неизрасходованную воду (п. 98–99 ПП № 354). Если отключили дольше объявленного или без предупреждения — выберите «Внезапно». Денег за плановое я не обещаю.',
          buttons: [[cb('Выбрать «Внезапно»', 'svc:hot_water_off')], backRow()],
        });
      }
      return this.continueDraft(userId, { ...draft, hwChecked: true });
    }
    if (head === 'el') {
      if (draft.houseId) this.db.setHouseVariant(draft.houseId, value);
      return this.continueDraft(userId, { ...draft, variant: value });
    }
    if (head === 'cr') return this.continueDraft(userId, { ...draft, corner: value === '1' });
    if (head === 'fx') {
      if (value === 'called') return this.continueDraft(userId, { ...draft, evidence: 'ads' });
      if (value === 'fail') return this.askFallback(userId, draft);
    }
    if (head === 'fb') {
      if (value === 'written') return this.continueDraft(userId, { ...draft, evidence: 'written' });
      if (value === 'self') return this.continueDraft(userId, { ...draft, evidence: 'self', number: null });
      if (value === 'nonum') return this.continueDraft(userId, { ...draft, number: null, evidence: draft.evidence === 'ads' ? 'self' : draft.evidence });
    }
    return this.stale(userId);
  }

  private askFixation(userId: number, draft: Draft) {
    const norm = this.norms.services[draft.service];
    const house = draft.houseId ? this.db.getHouse(draft.houseId) : undefined;
    const phone = house ? this.db.houseInfo(house).adsPhone : undefined;
    this.saveDraft(userId, 'draft', draft);
    const lines = [
      `📞 **Позвоните в аварийную службу**${phone ? `: ${phone}` : ' — телефон есть в квитанции'}.`,
      'Скажите адрес и что случилось. **Запишите номер заявки** — это главное доказательство (п. 106 ПП № 354).',
    ];
    if (norm.kind !== 'interruption') lines.push('Попросите прийти и замерить — по правилам не позднее чем через 2 часа.');
    if (norm.executor_hint) lines.push(norm.executor_hint);
    return this.send(userId, {
      text: lines.join('\n'),
      buttons: [[cb('📞 Позвонил — ввести номер', 'fx:called')], [cb('Не дозвонился', 'fx:fail')], [cb('📍 Другой адрес', 'addr'), cb('⬅️ Меню', 'menu')]],
    });
  }

  private askFallback(userId: number, draft: Draft) {
    this.saveDraft(userId, 'draft', draft);
    return this.send(userId, {
      text: [
        'Сделайте скриншот журнала звонков — он докажет, что вы звонили. Аварийная служба обязана ответить за 5 минут или перезвонить за 10 (п. 13 ПП № 416).',
        '',
        'Без номера заявки УК может сказать «не было». Докажите иначе:',
        '• напишите в «Госуслуги Дом» или ГИС ЖКХ — обращение получит номер;',
        '• или запишите время — сделаю акт, его подпишут соседи.',
      ].join('\n'),
      buttons: [[cb('✍️ Написал, есть номер', 'fb:written')], [cb('Записать время → акт', 'fb:self')], backRow()],
    });
  }

  private async onNumber(userId: number, text: string, draft: Draft) {
    const number = clean(text).slice(0, 40);
    if (!number) return this.send(userId, { text: 'Напишите номер обращения цифрами или буквами.' });
    return this.continueDraft(userId, { ...draft, number });
  }

  private askStartTime(userId: number, draft: Draft) {
    const norm = this.norms.services[draft.service];
    this.saveDraft(userId, 'draft', draft);
    const q =
      draft.evidence === 'ads'
        ? 'Во сколько приняли заявку? С этого времени считаются часы (п. 111).'
        : draft.evidence === 'written'
          ? 'Когда отправили обращение?'
          : norm.kind === 'interruption'
            ? `Когда пропала ${norm.genitive.startsWith('горяч') || norm.genitive.startsWith('холодн') ? 'вода' : 'услуга'}?`
            : 'Когда измерили температуру?';
    return this.send(userId, { text: q, buttons: [...timeButtons('ts', 'start'), backRow()] });
  }

  private async onStartTimeButton(userId: number, code: string) {
    const draft = this.draftFromState(userId);
    if (!draft) return this.stale(userId);
    if (code === 'manual') {
      this.saveDraft(userId, 'await_time_start', draft);
      return this.send(userId, { text: TIME_HINT, buttons: [backRow()] });
    }
    const date = relativeTime(code, this.now());
    if (!date) return this.stale(userId);
    return this.createIncident(userId, draft, date);
  }

  private async onStartTimeText(userId: number, text: string, draft: Draft) {
    const r = parseLocalInput(text, this.now(), this.tz(draft.houseId));
    if (!r.ok) return this.send(userId, { text: r.error, buttons: [backRow()] });
    return this.createIncident(userId, draft, r.date);
  }

  private async createIncident(userId: number, draft: Draft, startedAt: Date) {
    const house = this.db.getHouse(draft.houseId!)!;
    const incident = this.db.createIncident({
      house_id: house.id,
      service_key: draft.service,
      reporter_user_id: userId,
      started_at: startedAt.toISOString(),
      ads_number: draft.number ?? null,
      evidence: draft.evidence ?? 'self',
      variant: draft.variant ?? null,
      entrance: this.db.getUserHouse(userId, house.id)?.entrance ?? null,
    });
    const p = this.db.addParticipant({
      incident_id: incident.id,
      user_id: userId,
      role: 'reporter',
      started_at: startedAt.toISOString(),
      corner: draft.corner ? 1 : 0,
    });
    if (draft.temp !== undefined) this.db.addReading(p.id, startedAt.toISOString(), draft.temp);
    this.db.setState(userId, 'idle');
    this.db.track(userId, 'fixed', { service: draft.service, evidence: incident.evidence });
    this.scheduleRestoredCheck(p, house.tz);
    // Температуру проверяет исполнитель на месте (п. 108): через 2 часа спросим, приходили ли.
    if (this.norms.services[draft.service].kind !== 'interruption' && incident.evidence !== 'self') scheduleInspectionCheck(this, p.id, userId, house.tz);
    // Бот сам сообщает соседям: «У вас тоже?» — одна кнопка, и время начала у них уже есть.
    const n = await queueHouseAlerts(this, incident);
    const night = this.quietShift(this.now(), house.tz).getTime() > this.now().getTime();
    return this.sendTracking(userId, p.id, true, n ? `📣 Сообщил ${n} ${plural(n, ['соседу', 'соседям', 'соседям'])}${night ? ' (утром в 08:00)' : ''}.` : undefined);
  }

  // =====================================================================
  // Отслеживание
  // =====================================================================

  private scheduleRestoredCheck(p: Participant, tz: string) {
    const now = this.now();
    const due = this.cfg.fastReminders ? new Date(now.getTime() + 2 * 60_000) : this.quietShift(new Date(now.getTime() + this.cfg.restoreCheckHours * MS_HOUR), tz);
    this.db.schedule('ask_restored', p.id, p.user_id, due);
  }

  /** Не беспокоим ночью: напоминание на 23:00–08:00 переносится на 08:00. */
  quietShift(due: Date, tz: string): Date {
    const lp = localParts(due, tz);
    if (lp.hour >= 8 && lp.hour < 23) return due;
    const morning = fromLocal(lp.year, lp.month, lp.day, 8, 0, tz);
    return lp.hour >= 23 ? new Date(morning.getTime() + 24 * MS_HOUR) : morning;
  }

  private trackingButtons(c: CaseBundle): Btn[][] {
    const norm = this.norms.services[c.incident.service_key];
    const rows: Btn[][] = [];
    const done = cb(norm.kind === 'interruption' ? `✅ ${this.restoredWord(c.incident.service_key)}` : '✅ Стало тепло', `rest:${c.p.id}:y`);
    rows.push(norm.kind !== 'interruption' ? [done, cb('🌡 Новый замер', `tmp:${c.p.id}`)] : [done]);
    if (c.p.role === 'neighbour' && !c.p.own_ads_number) rows.push([cb('✏️ Ввести свой номер заявки', `own:${c.p.id}`)]);
    rows.push([cb('👥 Позвать соседей', `nb:${c.p.id}`), cb('📷 Фото', `phadd:${c.p.id}:evidence`)]);
    rows.push(...actButtons(this, c));
    rows.push([cb('⬅️ Меню', 'menu')]);
    return rows;
  }

  private restoredWord(service: ServiceKey) {
    const map: Partial<Record<ServiceKey, string>> = {
      electricity_off: 'Свет дали',
      gas_off: 'Газ дали',
      heating_off: 'Отопление дали',
      sewerage_off: 'Канализацию починили',
      waste_off: 'Мусор вывезли',
    };
    return map[service] ?? 'Воду дали';
  }

  private async sendTracking(userId: number, pid: number, fresh: boolean, extra?: string) {
    const c = loadCase(this.db, pid)!;
    const norm = this.norms.services[c.incident.service_key];
    const tz = c.house.tz;
    const evidenceLine =
      c.incident.evidence === 'ads'
        ? `заявка № ${clean(c.p.own_ads_number || c.incident.ads_number)}`
        : c.incident.evidence === 'written'
          ? `обращение${c.incident.ads_number ? ` № ${clean(c.incident.ads_number)}` : ''}`
          : 'без номера заявки';
    const readings = this.db.listReadings(pid);
    const lines = [
      `${fresh ? '✅ **Записал.**' : '👀 **Слежу.**'} ${ICON[c.incident.service_key]} ${norm.title} · ${c.house.address} · с ${formatShort(new Date(c.p.started_at), tz)} · ${evidenceLine}`,
    ];
    if (readings.length) lines.push(`Последний замер: +${fmtNum(readings[readings.length - 1].temp_c, 1)} °C.`);
    if (c.incident.evidence === 'self' && !this.db.getActByIncident(c.incident.id)) lines.push('Без номера заявки нужен акт с соседями — доказательство, что услуги не было.');
    if (extra) lines.push(extra);
    lines.push(`Каждые ${this.cfg.restoreCheckHours} ч спрошу, починили ли. Починят раньше — нажмите ✅.`);
    return this.send(userId, { text: lines.join('\n'), buttons: this.trackingButtons(c) });
  }

  /** Вызывается планировщиком. */
  async remindRestored(pid: number) {
    const c = loadCase(this.db, pid);
    if (!c || c.p.status !== 'tracking') return;
    const norm = this.norms.services[c.incident.service_key];
    const tz = c.house.tz;
    const started = new Date(c.p.started_at);
    const hours = hoursBetween(started, this.now());
    if (hours > 24 * 21) {
      this.db.updateParticipant(pid, { status: 'closed' });
      return this.safeSend(c.p.user_id, {
        text: `Случай «${norm.title}» с ${formatShort(started, tz)} длится больше трёх недель без отметки о восстановлении. Я перестал напоминать — откройте его в «Мои случаи», когда будет что отметить.`,
        buttons: [[cb('📋 Мои случаи', 'cases')]],
      });
    }
    const q =
      norm.kind === 'interruption'
        ? `${ICON[c.incident.service_key]} Починили? ${norm.title}, ${c.house.address} — уже ${formatDuration(hours)}.`
        : `${ICON[c.incident.service_key]} Стало тепло? ${c.house.address} — уже ${formatDuration(hours)}. Если нет, пришлите новый замер: так сумма будет точнее.`;
    const buttons: Btn[][] = [[cb(norm.kind === 'interruption' ? '✅ Да, восстановили' : '✅ Да, тепло', `rest:${pid}:y`), cb('Нет ещё', `rest:${pid}:n`)]];
    if (norm.kind !== 'interruption') buttons.push([cb('🌡 Новый замер', `tmp:${pid}`)]);
    await this.safeSend(c.p.user_id, { text: q, buttons });
    this.scheduleRestoredCheck(c.p, tz);
  }

  private async onRestoredAnswer(userId: number, pid: number, answer: string) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    if (c.p.status !== 'tracking') return this.showCase(userId, pid);
    if (answer === 'n') {
      this.scheduleRestoredCheck(c.p, c.house.tz);
      return this.send(userId, {
        text: this.cfg.fastReminders ? 'Понял, спрошу через пару минут (демо-режим).' : `Понял, спрошу через ${this.cfg.restoreCheckHours} ч. Ночью не беспокою.`,
        buttons: [[cb('👥 Позвать соседей', `nb:${pid}`), cb('⬅️ Меню', 'menu')]],
      });
    }
    this.db.setState(userId, 'idle', { pid });
    return this.send(userId, { text: 'Когда восстановили?', buttons: [...timeButtons(`te:${pid}`, 'end'), backRow()] });
  }

  private async onEndTimeButton(userId: number, pid: number, code: string) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    if (code === 'manual') {
      this.db.setState(userId, 'await_time_end', { pid });
      return this.send(userId, { text: TIME_HINT, buttons: [backRow()] });
    }
    const date = relativeTime(code, this.now());
    if (!date) return this.stale(userId);
    return this.setEnded(userId, c, date);
  }

  private async onEndTimeText(userId: number, text: string, pid: number) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    const r = parseLocalInput(text, this.now(), c.house.tz);
    if (!r.ok) return this.send(userId, { text: r.error, buttons: [backRow()] });
    return this.setEnded(userId, c, r.date);
  }

  private async setEnded(userId: number, c: CaseBundle, endedAt: Date) {
    if (endedAt.getTime() <= new Date(c.p.started_at).getTime()) {
      return this.send(userId, {
        text: `Время окончания должно быть позже начала (${formatShort(new Date(c.p.started_at), c.house.tz)}). Выберите другое время.`,
        buttons: [...timeButtons(`te:${c.p.id}`, 'end'), backRow()],
      });
    }
    this.db.updateParticipant(c.p.id, { ended_at: endedAt.toISOString(), status: 'ended' });
    this.db.cancelReminders(c.p.id, 'ask_restored');
    this.db.setState(userId, 'idle');
    this.db.track(userId, 'restored', { service: c.incident.service_key });

    if (!c.incident.ended_at) {
      this.db.closeIncident(c.incident.id, endedAt.toISOString());
      await this.notifyNeighboursClosed(c, endedAt);
    }

    await this.send(userId, {
      text: `✅ Записал: починили в ${formatShort(endedAt, c.house.tz)}. Скажите об этом аварийной службе — так фиксируется конец (п. 112 ПП № 354).`,
    });
    return this.resumeCalculation(userId, c.p.id);
  }

  private async notifyNeighboursClosed(c: CaseBundle, endedAt: Date) {
    const norm = this.norms.services[c.incident.service_key];
    for (const other of this.db.listParticipants(c.incident.id)) {
      if (other.id === c.p.id || other.status !== 'tracking') continue;
      await this.safeSend(other.user_id, {
        text: `${ICON[c.incident.service_key]} Сосед отметил: починили в ${formatShort(endedAt, c.house.tz)}. У вас тоже?`,
        buttons: [[cb('✅ Да', `same:${other.id}:y`), cb('Нет ещё', `same:${other.id}:n`)]],
      });
    }
  }

  private async onSameAnswer(userId: number, pid: number, answer: string) {
    const c = this.ownCase(userId, pid);
    if (!c || c.p.status !== 'tracking') return this.stale(userId);
    if (answer === 'y' && c.incident.ended_at) return this.setEnded(userId, c, new Date(c.incident.ended_at));
    return this.send(userId, { text: 'Хорошо, слежу за вами отдельно.', buttons: this.trackingButtons(c) });
  }

  // =====================================================================
  // Температура
  // =====================================================================

  private askTemperature(userId: number, data: { purpose: 'initial' | 'update' | 'join'; draft?: Draft; pid?: number; incidentId?: number; corner?: boolean }) {
    const service = data.draft?.service ?? (data.pid ? loadCase(this.db, data.pid)?.incident.service_key : undefined) ?? (data.incidentId ? this.db.getIncident(data.incidentId)?.service_key : undefined);
    if (!service) return this.stale(userId);
    if (data.pid && !this.ownCase(userId, data.pid)) return this.stale(userId);
    const norm = this.norms.services[service];
    this.db.setState(userId, 'await_temp', data);
    return this.send(userId, {
      text: `🌡 Сколько градусов? Например 16 или 15,5.\n${norm.measure_hint ?? ''}`,
      buttons: [backRow()],
    });
  }

  /** Сосед присоединяется к «холодно в квартире»: сначала угловая ли комната — от этого зависит норма. */
  private async onJoinCorner(userId: number, incidentId: number, corner: boolean) {
    const incident = this.db.getIncident(incidentId);
    if (!incident) return this.stale(userId);
    return this.askTemperature(userId, { purpose: 'join', incidentId, corner });
  }

  private async onTemperature(userId: number, text: string, data: { purpose: string; draft?: Draft; pid?: number; incidentId?: number; corner?: boolean }) {
    const t = parseTemperature(text);
    if (t === null) return this.send(userId, { text: 'Напишите число градусов, например 16 или 15,5.', buttons: [backRow()] });

    if (data.purpose === 'update' && data.pid) {
      const c = this.ownCase(userId, data.pid);
      if (!c) return this.stale(userId);
      this.db.addReading(c.p.id, this.now().toISOString(), t);
      this.db.setState(userId, 'idle');
      await this.send(userId, { text: `Записал: +${fmtNum(t, 1)} °C в ${formatShort(this.now(), c.house.tz)}.` });
      return this.sendTracking(userId, c.p.id, false);
    }

    const service = data.draft?.service ?? this.db.getIncident(data.incidentId!)?.service_key;
    if (!service) return this.stale(userId);
    const norm = this.norms.services[service];
    const corner = data.draft?.corner ?? data.corner ?? false;
    let threshold: number;
    let normText: string;
    if (norm.kind === 'heating_temperature') {
      const tn = norm.temperature as HeatingTempNorm;
      threshold = corner ? tn.corner_norm_c : tn.norm_c;
      normText = `${corner ? 'для угловой комнаты ' : ''}не ниже +${threshold} °C`;
    } else {
      const tn = norm.temperature as HotWaterTempNorm;
      threshold = tn.norm_c - tn.day_tolerance_c;
      normText = `не ниже +${tn.norm_c} °C, днём допустимо на ${tn.day_tolerance_c} °C меньше`;
    }
    if (t >= threshold) {
      // Состояние не сбрасываем: житель может перемерить в другой комнате и ввести новое число.
      return this.send(userId, {
        text: `+${fmtNum(t, 1)} °C — это норма (${normText}), доплаты не положено. Если в другой комнате холоднее или стало хуже — напишите новый замер.`,
        buttons: [[cb('⬅️ Меню', 'menu')]],
      });
    }
    if (data.purpose === 'join' && data.incidentId) {
      const incident = this.db.getIncident(data.incidentId)!;
      return this.completeJoin(userId, incident, t, corner);
    }
    return this.continueDraft(userId, { ...data.draft!, temp: t });
  }

  // =====================================================================
  // Соседи
  // =====================================================================

  private async joinByCode(userId: number, code: string) {
    const incident = this.db.getIncidentByCode(code);
    if (!incident) {
      return this.send(userId, { text: 'Эта карточка не найдена: возможно, случай удалён. Расскажите, что случилось у вас.', buttons: this.menu() });
    }
    const house = this.db.getHouse(incident.house_id)!;
    const norm = this.norms.services[incident.service_key];
    const mine = this.db.getParticipantFor(incident.id, userId);
    if (mine) return this.showCase(userId, mine.id);
    if (incident.ended_at && hoursBetween(new Date(incident.ended_at), this.now()) > 24 * 45) {
      return this.send(userId, { text: 'Это отключение закончилось больше полутора месяцев назад, присоединиться уже нельзя.', buttons: this.menu() });
    }
    this.db.setState(userId, 'idle');
    return this.send(userId, {
      text: `${ICON[incident.service_key]} **${house.address}: ${norm.button.toLowerCase()}** с ${formatShort(new Date(incident.started_at), house.tz)}${incident.ended_at ? ` по ${formatShort(new Date(incident.ended_at), house.tz)}` : ''}${incident.ads_number ? `, заявка № ${clean(incident.ads_number)}` : ''}.\nВы живёте в этом доме, и у вас то же самое?`,
      buttons: [[cb('✅ Да, у меня тоже', `jn:${incident.id}`), cb('Нет', 'menu')]],
    });
  }

  async joinIncident(userId: number, incident: Incident) {
    const mine = this.db.getParticipantFor(incident.id, userId);
    if (mine) return this.showCase(userId, mine.id);
    this.db.addUserHouse(userId, incident.house_id);
    const norm = this.norms.services[incident.service_key];
    // Для «холодно в квартире» норма зависит от комнаты (+18 °C или +20 °C в угловой) — спрашиваем соседа.
    if (norm.kind === 'heating_temperature') {
      this.db.setState(userId, 'idle');
      return this.send(userId, {
        text: 'Ваша комната угловая? Для угловой норма +20 °C, для обычной +18 °C.',
        buttons: [[cb('Обычная', `crj:${incident.id}:0`), cb('Угловая', `crj:${incident.id}:1`)]],
      });
    }
    if (norm.kind !== 'interruption') return this.askTemperature(userId, { purpose: 'join', incidentId: incident.id });
    return this.completeJoin(userId, incident, null);
  }

  private async completeJoin(userId: number, incident: Incident, temp: number | null, corner = false) {
    const house = this.db.getHouse(incident.house_id)!;
    const now = this.now();
    const startedAt = temp === null ? incident.started_at : now.toISOString();
    const p = this.db.addParticipant({ incident_id: incident.id, user_id: userId, role: 'neighbour', started_at: startedAt, corner: corner ? 1 : 0 });
    if (temp !== null) this.db.addReading(p.id, startedAt, temp);
    this.db.setState(userId, 'idle');
    this.db.cancelAlert(incident.id, userId);
    this.db.track(userId, 'neighbour_joined', { incident: incident.id });

    const reporter = this.db.listParticipants(incident.id).find((x) => x.role === 'reporter');
    if (reporter && reporter.user_id !== userId) {
      const count = this.db.listParticipants(incident.id).length;
      await this.safeSend(reporter.user_id, { text: `👥 Присоединился сосед. Вас уже ${count}.` });
    }

    if (incident.ended_at && temp === null) {
      await this.send(userId, { text: '✅ Вы в деле. Отключение уже закончилось — сразу считаю.' });
      await inviteToAct(this, incident.id, userId);
      return this.setEnded(userId, loadCase(this.db, p.id)!, new Date(incident.ended_at));
    }
    this.scheduleRestoredCheck(p, house.tz);
    await this.sendTracking(userId, p.id, false, 'Есть свой номер заявки? С ним заявление сильнее. Нет — укажу номер соседа.');
    // Если соседи уже собирают акт — новый участник сразу получает его на подтверждение.
    return inviteToAct(this, incident.id, userId);
  }

  private async onOwnNumber(userId: number, text: string, pid: number) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    const number = clean(text).slice(0, 40);
    if (!number) return this.send(userId, { text: 'Напишите номер цифрами или буквами.' });
    this.db.updateParticipant(pid, { own_ads_number: number });
    this.db.setState(userId, 'idle');
    await this.send(userId, { text: `Записал ваш номер заявки: ${number}.` });
    return c.p.status === 'tracking' ? this.sendTracking(userId, pid, false) : this.showCase(userId, pid);
  }

  cardMessage(c: CaseBundle): OutMessage {
    const norm = this.norms.services[c.incident.service_key];
    const tz = c.house.tz;
    const n = norm.interruption;
    const rule = n
      ? `За каждый ${n.unit_hours === 1 ? 'час' : `${n.unit_hours} ч`} сверх допустимого положено снижение платы на ${fmtPercent(n.rate_percent)} — ПП РФ № 354.`
      : 'За каждый час низкой температуры положено снижение платы — ПП РФ № 354.';
    const what = norm.kind === 'interruption' ? `нет ${norm.genitive}` : `низкая температура ${norm.genitive}`;
    const url = this.deepLink(c.incident.code);
    return {
      // Ссылка продублирована в тексте: при пересылке сообщения MAX убирает кнопки.
      text: [
        `🚨 **${c.house.address}: ${what}** с ${formatShort(new Date(c.incident.started_at), tz)}${c.incident.ads_number && c.incident.evidence === 'ads' ? `, заявка № ${clean(c.incident.ads_number)}` : ''}.`,
        `${rule} Бот «Вернём» посчитает и поможет вернуть деньги каждому соседу.`,
        `👉 У меня тоже: ${url}`,
      ].join('\n'),
      buttons: [[link('💸 У меня тоже', url)]],
    };
  }

  private async sendNeighbourCard(userId: number, pid: number) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    const user = this.db.getUser(userId)!;
    await this.send(userId, {
      text: user.house_chat_id
        ? 'Карточка ниже. Могу сам опубликовать её в чате дома — там будет работать кнопка.'
        : 'Перешлите карточку ниже в домовой чат. При пересылке кнопка пропадёт, но ссылка в тексте работает. Кнопки видны, только если бот сам публикует в группе: добавьте его в чат и отправьте там /dom.',
    });
    const sent = await this.send(userId, this.cardMessage(c));
    if (sent.mid) this.db.updateParticipant(pid, { last_card_mid: sent.mid });
    this.db.track(userId, 'card_created', { incident: c.incident.id });
    const rows: Btn[][] = [];
    if (user.house_chat_id) rows.push([cb('📣 Опубликовать в чате дома', `post:${pid}`)]);
    if (this.cfg.miniAppEnabled) rows.push([app('📱 Поделиться через приложение', `share_${pid}`)]);
    rows.push([cb('⬅️ К делу', `cs:${pid}`)]);
    return this.send(userId, { text: 'Готово.', buttons: rows });
  }

  private async postToHouseChat(userId: number, pid: number) {
    const c = this.ownCase(userId, pid);
    const user = this.db.getUser(userId)!;
    if (!c || !user.house_chat_id) return this.stale(userId);
    try {
      await this.out.toChat(user.house_chat_id, this.cardMessage(c));
      this.db.track(userId, 'card_posted', { incident: c.incident.id });
      return this.send(userId, { text: 'Опубликовал карточку в чате дома 📣' });
    } catch (e) {
      console.error('[bot] не удалось опубликовать в чат', e);
      this.db.updateUser(userId, { house_chat_id: null });
      return this.send(userId, { text: 'Не получилось опубликовать: похоже, бота удалили из чата. Перешлите карточку вручную.' });
    }
  }

  // =====================================================================
  // Расчёт
  // =====================================================================

  private async resumeCalculation(userId: number, pid: number) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    if (!c.p.ended_at) return this.sendTracking(userId, pid, false);
    const calc = calcFor(this.db, this.norms, c, this.now());
    this.db.setCalc(pid, calc);
    if (!hasMoney(calc)) {
      this.db.updateParticipant(pid, { status: 'closed' });
      return this.send(userId, {
        text: ['**Доплаты не положено:** перерыв в пределах нормы.', ...calc.months.flatMap((m) => m.lines), 'Повторится в этом месяце — сообщите снова: перерывы за месяц суммируются.'].join('\n'),
        buttons: this.menu(),
      });
    }
    const bills = billsOf(c.p);
    const months = calc.months.filter((m) => m.percent > 0 && bills[m.month] === undefined).map((m) => m.month);
    if (months.length) return this.askBill(userId, pid, months, 0);
    return this.showCalculation(userId, pid);
  }

  private askBill(userId: number, pid: number, months: string[], idx: number) {
    const c = this.ownCase(userId, pid)!;
    const norm = this.norms.services[c.incident.service_key];
    this.db.setState(userId, 'await_bill', { pid, months, idx });
    return this.send(userId, {
      text: `Сколько начислено за «${norm.title.toLowerCase()}» за ${monthTitle(months[idx])}? Строка этой услуги в квитанции, не итог. Квитанции ещё нет — возьмите прошлую. Например: 1200`,
      buttons: [[cb('Не знаю — посчитать в процентах', 'billskip')], backRow()],
    });
  }

  private async onBill(userId: number, text: string, data: { pid: number; months: string[]; idx: number }) {
    const amount = parseRubles(text);
    if (amount === null) return this.send(userId, { text: 'Не понял сумму. Напишите число, например 1200 или 1 200,50.', buttons: [[cb('Пропустить', 'billskip')]] });
    const c = this.ownCase(userId, data.pid);
    if (!c) return this.stale(userId);
    const bills = { ...billsOf(c.p), [data.months[data.idx]]: amount };
    this.db.updateParticipant(c.p.id, { bills: JSON.stringify(bills) });
    return this.nextBill(userId, data);
  }

  private async onBillSkip(userId: number) {
    const { state, data } = this.db.getState<any>(userId);
    if (state !== 'await_bill') return this.stale(userId);
    return this.nextBill(userId, data);
  }

  private nextBill(userId: number, data: { pid: number; months: string[]; idx: number }) {
    if (data.idx + 1 < data.months.length) return this.askBill(userId, data.pid, data.months, data.idx + 1);
    this.db.setState(userId, 'idle');
    return this.showCalculation(userId, data.pid);
  }

  private async showCalculation(userId: number, pid: number) {
    const c = this.ownCase(userId, pid)!;
    const norm = this.norms.services[c.incident.service_key];
    const calc = calcFor(this.db, this.norms, c, this.now());
    this.db.setCalc(pid, calc);
    const bills = billsOf(c.p);
    const est = estimate(calc, bills);
    const tz = c.house.tz;
    const start = new Date(c.p.started_at);
    const end = new Date(c.p.ended_at!);
    const adsNumber = c.p.own_ads_number || c.incident.ads_number;

    const totalPercent = calc.months.reduce((s, m) => s + m.percent, 0);
    const lines = [
      est.sum > 0 ? `💰 **Положено ≈ ${fmtRub(est.sum)}**${est.complete ? '' : ' (+ месяцы без суммы)'}` : `💰 **Положено снижение платы на ${fmtPercent(Math.round(totalPercent * 100) / 100)}**`,
      `${norm.title}: ${formatShort(start, tz)} – ${formatShort(end, tz)} (${formatDuration(hoursBetween(start, end))})${adsNumber ? `, ${c.incident.evidence === 'ads' ? 'заявка' : 'обращение'} № ${clean(adsNumber)}` : ''}.`,
    ];
    for (const m of calc.months) {
      if (calc.months.length > 1) lines.push(`_${monthTitle(m.month)}_`);
      lines.push(...m.lines);
      const bill = bills[m.month];
      if (bill && m.percent > 0) lines.push(`${fmtPercent(m.percent)} от ${fmtRub(bill)} ≈ ${fmtRub(refundAmount(bill, m.percent))}`);
    }
    lines.push(`Основание: ${norm.item} к ПП РФ № 354. Итог считает исполнитель.`);
    this.db.track(userId, 'calc_done', { service: c.incident.service_key, sum: est.sum });
    await this.send(userId, { text: lines.join('\n') });

    // Получатель из карточки дома — не спрашиваем то, что соседи уже заполнили.
    const known = executorFromHouse(this.db.houseInfo(c.house), c.incident.service_key);
    if (known) {
      return this.send(userId, {
        text: `Заявление — в «${known.name}» (из карточки дома). Верно?`,
        buttons: [[cb('✅ Да', `ex:${pid}:${known.type}:h`), cb('Другой получатель', `ex:${pid}:ask`)]],
      });
    }
    return this.askExecutorType(userId, pid);
  }

  private askExecutorType(userId: number, pid: number) {
    const c = this.ownCase(userId, pid)!;
    const norm = this.norms.services[c.incident.service_key];
    const rows: Btn[][] = [[cb('УК / ТСЖ', `ex:${pid}:uk`), cb('Ресурсоснабжающей', `ex:${pid}:rso`)]];
    if (c.incident.service_key === 'waste_off') rows.push([cb('Региональному оператору ТКО', `ex:${pid}:rop`)]);
    rows.push([cb('Не знаю', `ex:${pid}:unknown`)]);
    return this.send(userId, {
      text: `Кому вы платите за «${norm.title.toLowerCase()}»? Смотрите получателя в квитанции — он и делает перерасчёт.`,
      buttons: rows,
    });
  }

  // =====================================================================
  // Заявление
  // =====================================================================

  private async onExecutorType(userId: number, pid: number, type: ExecutorType | 'ask', fromHouse?: string) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    if (type === 'ask') return this.askExecutorType(userId, pid);
    const claim = { ...claimOf(c.p), executorType: type };
    if (fromHouse === 'h') {
      const info = this.db.houseInfo(c.house);
      const known = executorFromHouse(info, c.incident.service_key);
      if (known) {
        claim.executor = known.name;
        if (known.type === 'uk' && info.ukInn) claim.executorInn = info.ukInn;
      }
    }
    this.db.updateParticipant(pid, { claim: JSON.stringify(claim) });
    const user = this.db.getUser(userId)!;
    if (user.fio && user.flat) {
      return this.send(userId, {
        text: `Заявление от: ${clean(user.fio)}, кв. ${clean(user.flat)}${user.account ? `, л/с ${clean(user.account)}` : ''}?`,
        buttons: [[cb('✅ Да', `pd:${pid}:reuse`), cb('Другие данные', `pd:${pid}:new`)]],
      });
    }
    return this.askPersonal(userId, pid, 'await_fio');
  }

  private async onPersonalChoice(userId: number, pid: number, choice: string) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    if (choice === 'reuse') {
      const u = this.db.getUser(userId)!;
      const claim = { ...claimOf(c.p), fio: u.fio ?? undefined, flat: u.flat ?? undefined, account: u.account ?? undefined };
      this.db.updateParticipant(pid, { claim: JSON.stringify(claim) });
      return this.nextPersonal(userId, 'await_account', pid);
    }
    return this.askPersonal(userId, pid, 'await_fio');
  }

  private askPersonal(userId: number, pid: number, state: string) {
    this.db.setState(userId, state, { pid });
    const prompts: Record<string, { text: string; skip: boolean }> = {
      await_fio: { text: 'Ваши ФИО полностью — заявление подаётся от вашего имени:', skip: false },
      await_flat: { text: 'Номер квартиры?', skip: false },
      await_account: { text: 'Лицевой счёт из квитанции — ускорит перерасчёт:', skip: true },
      await_executor: { text: 'Название получателя платежа из квитанции, например «ООО "УК Пример"»:', skip: true },
    };
    const p = prompts[state];
    const rows: Btn[][] = [];
    if (p.skip) rows.push([cb('Пропустить', 'skip')]);
    rows.push(backRow());
    return this.send(userId, { text: p.text, buttons: rows });
  }

  private async onPersonal(userId: number, state: string, text: string, pid: number) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    const value = clean(text).replace(/\s+/g, ' ').slice(0, 150);
    if (state === 'await_fio' && (value.length < 5 || /\d/.test(value))) {
      return this.send(userId, { text: 'Напишите фамилию, имя и отчество буквами, например «Иванов Иван Иванович».' });
    }
    if (state === 'await_flat' && !/^[\dА-Яа-яA-Za-z/-]{1,10}$/.test(value)) {
      return this.send(userId, { text: 'Напишите номер квартиры, например 42 или 12А.' });
    }
    const claim = claimOf(c.p);
    const field = { await_fio: 'fio', await_flat: 'flat', await_account: 'account', await_executor: 'executor' }[state] as 'fio' | 'flat' | 'account' | 'executor';
    claim[field] = value;
    this.db.updateParticipant(pid, { claim: JSON.stringify(claim) });
    return this.nextPersonal(userId, state, pid);
  }

  private async onPersonalSkip(userId: number) {
    const { state, data } = this.db.getState<any>(userId);
    if (state !== 'await_account' && state !== 'await_executor') return this.stale(userId);
    return this.nextPersonal(userId, state, data.pid);
  }

  private nextPersonal(userId: number, state: string, pid: number) {
    const order = ['await_fio', 'await_flat', 'await_account', 'await_executor'];
    let next = order[order.indexOf(state) + 1];
    // Получатель уже известен (из карточки дома) — не спрашиваем.
    const c = this.ownCase(userId, pid);
    if (next === 'await_executor' && c && claimOf(c.p).executor) next = '';
    if (next) return this.askPersonal(userId, pid, next);
    this.db.setState(userId, 'idle');
    const user = this.db.getUser(userId)!;
    if (user.save_personal) return this.issueClaim(userId, pid, true);
    return this.send(userId, {
      text: 'Запомнить ФИО и квартиру для следующих заявлений?',
      buttons: [[cb('Запомнить', `sv:${pid}:1`), cb('Не сохранять', `sv:${pid}:0`)]],
    });
  }

  private async issueClaim(userId: number, pid: number, save: boolean) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    const claim = { ...claimOf(c.p), createdAt: this.now().toISOString() };
    this.db.updateParticipant(pid, { claim: JSON.stringify(claim), status: 'claim_ready' });
    if (save) this.db.updateUser(userId, { fio: claim.fio ?? null, flat: claim.flat ?? null, account: claim.account ?? null, save_personal: 1 });

    const fresh = loadCase(this.db, pid)!;
    const doc = claimDocFor(this.db, this.norms, fresh, this.now());
    // Текстом заявление не дублируем: PDF удобнее распечатать, отправить или переписать от руки.
    await this.sendDocPdf(userId, doc, `📄 **Заявление готово**${doc.total ? ` — на ≈ ${fmtRub(doc.total)}` : ''}.`);
    this.db.track(userId, 'claim_created', { service: c.incident.service_key, sum: doc.total });

    if (!save) {
      const { fio, flat, account, ...rest } = claim;
      this.db.updateParticipant(pid, { claim: JSON.stringify(rest) });
    }
    const due = this.cfg.fastReminders ? new Date(this.now().getTime() + 3 * 60_000) : this.quietShift(new Date(this.now().getTime() + this.cfg.receiptCheckDays * 24 * MS_HOUR), c.house.tz);
    this.db.schedule('ask_receipt', pid, userId, due);
    // Без номера заявки и без подписанного акта заявление слабое — говорим прямо и даём кнопку акта.
    const act = this.db.getActByIncident(c.incident.id);
    const weak = c.incident.evidence === 'self' && act?.status !== 'signed';
    const rows: Btn[][] = weak ? actButtons(this, fresh) : [];
    rows.push([cb('👥 Позвать соседей', `nb:${pid}`), cb('⬅️ Меню', 'menu')]);
    return this.send(userId, {
      text: [
        weak ? '⚠️ В заявлении нет доказательства — ни номера заявки, ни акта. Подпишите акт с соседями и приложите его.' : '',
        act?.status === 'signed' ? '📎 Акт указан в приложениях — приложите его копию.' : '',
        SEND_HOWTO,
        save ? '' : 'ФИО и квартиру из базы удалил — они остались только в PDF.',
      ]
        .filter(Boolean)
        .join('\n'),
      buttons: rows,
    });
  }

  private sendPdf(userId: number, c: CaseBundle) {
    return this.sendDocPdf(userId, claimDocFor(this.db, this.norms, c, this.now()), 'PDF для печати или отправки:');
  }

  /** Отправляет любой документ жителя PDF-файлом: заявление, акт, требование, жалобу. */
  async sendDocPdf(userId: number, doc: ClaimDoc, caption: string) {
    const name = doc.fileName ?? 'Документ.pdf';
    try {
      const pdf = await claimToPdf(doc);
      const dir = mkdtempSync(join(this.cfg.tmpDir, 'doc-'));
      const path = join(dir, name);
      writeFileSync(path, pdf);
      await this.send(userId, { text: caption, file: { path, name } });
    } catch (e) {
      console.error('[bot] не удалось отправить PDF', e);
      await this.safeSend(userId, { text: 'PDF сейчас не получилось отправить. Попробуйте ещё раз чуть позже.' });
    }
  }

  private async resendClaim(userId: number, pid: number) {
    const c = this.ownCase(userId, pid);
    if (!c || !c.p.ended_at) return this.stale(userId);
    return this.sendPdf(userId, c);
  }

  // =====================================================================
  // Проверка квитанции через месяц
  // =====================================================================

  async remindReceipt(pid: number) {
    const c = loadCase(this.db, pid);
    if (!c || c.p.status !== 'claim_ready') return;
    const norm = this.norms.services[c.incident.service_key];
    return this.safeSend(c.p.user_id, {
      text: `🧾 Пришла новая квитанция? Есть перерасчёт за «${norm.title.toLowerCase()}» (${formatShort(new Date(c.p.started_at), c.house.tz)})? Сфотографируйте квитанцию — пригодится, если перерасчёта нет.`,
      buttons: [
        [cb('✅ Да, вернули', `rc:${pid}:y`), cb('❌ Нет', `rc:${pid}:n`)],
        [cb('📷 Фото квитанции', `phadd:${pid}:receipt`), cb('Ещё не пришла', `rc:${pid}:w`)],
      ],
    });
  }

  private async onReceiptAnswer(userId: number, pid: number, answer: string) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    if (answer === 'y') {
      this.db.setState(userId, 'await_refund', { pid });
      return this.send(userId, { text: 'Отлично! Сколько вернули? Напишите сумму перерасчёта из квитанции.', buttons: [[cb('Не помню', `rfskip:${pid}`)]] });
    }
    if (answer === 'w') {
      const due = this.cfg.fastReminders ? new Date(this.now().getTime() + 2 * 60_000) : this.quietShift(new Date(this.now().getTime() + 7 * 24 * MS_HOUR), c.house.tz);
      this.db.schedule('ask_receipt', pid, userId, due);
      return this.send(userId, { text: 'Хорошо, спрошу через неделю.' });
    }
    this.db.updateParticipant(pid, { status: 'refused', refund_amount: null });
    this.db.cancelReminders(pid, 'ask_receipt');
    this.db.track(userId, 'refund_no', { service: c.incident.service_key });
    return showEscalation(this, userId, pid);
  }

  private async onRefund(userId: number, text: string, pid: number) {
    const amount = parseRubles(text);
    if (amount === null) return this.send(userId, { text: 'Напишите сумму числом, например 115 или 115,20.', buttons: [[cb('Не помню', `rfskip:${pid}`)]] });
    return this.finishRefund(userId, pid, amount);
  }

  private async finishRefund(userId: number, pid: number, amount: number | null) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    this.db.updateParticipant(pid, { status: 'refunded', refund_amount: amount });
    this.db.cancelReminders(pid, 'ask_receipt');
    this.db.setState(userId, 'idle');
    this.db.track(userId, 'refund_yes', { service: c.incident.service_key, amount });
    const total = this.db
      .listUserParticipants(userId)
      .reduce((s, p) => s + (p.status === 'refunded' && p.refund_amount ? p.refund_amount : 0), 0);
    // Вернули заметно меньше расчёта — предлагаем потребовать остальное.
    const expected = estimate(calcFor(this.db, this.norms, c, this.now()), billsOf(c.p));
    const partial = amount !== null && expected.sum > 0 && amount < expected.sum * 0.9;
    const lines = [`🎉 Исполнитель заплатил за плохую услугу.${total > 0 ? `\nВсего вы вернули с ботом: **${fmtRub(Math.round(total * 100) / 100)}**.` : ''}`];
    if (partial) {
      lines.push('', `По расчёту положено ≈ ${fmtRub(expected.sum)}, а вернули ${fmtRub(amount!)}. Можно потребовать остальное и штраф 50% за нарушение порядка расчёта.`);
      return this.send(userId, { text: lines.join('\n'), buttons: [[cb('⚖️ Потребовать остальное', `escm:${pid}`)], ...this.menu()] });
    }
    lines.push('', 'Расскажите соседям — им положено столько же.');
    return this.send(userId, { text: lines.join('\n'), buttons: this.menu() });
  }

  // =====================================================================
  // Мои случаи
  // =====================================================================

  private async showCases(userId: number) {
    this.db.setState(userId, 'idle');
    const list = this.db.listUserParticipants(userId).slice(0, 10);
    if (!list.length) {
      return this.send(userId, { text: 'Дел пока нет. Что-то сломается — нажмите «Что-то сломалось».', buttons: this.menu() });
    }
    const rows: Btn[][] = list.map((p) => {
      const c = loadCase(this.db, p.id)!;
      const norm = this.norms.services[c.incident.service_key];
      return [cb(`${ICON[c.incident.service_key]} ${norm.button} · ${formatShort(new Date(p.started_at), c.house.tz).split(' ')[0]} · ${STATUS_TITLE[p.status]}`.slice(0, 64), `cs:${p.id}`)];
    });
    if (this.cfg.miniAppEnabled) rows.push([app('📱 Открыть в приложении')]);
    rows.push(backRow());
    const refunded = list.reduce((s, p) => s + (p.status === 'refunded' && p.refund_amount ? p.refund_amount : 0), 0);
    return this.send(userId, {
      text: `**Мои дела**${refunded > 0 ? ` · вернули с ботом ${fmtRub(Math.round(refunded * 100) / 100)}` : ''}`,
      buttons: rows,
    });
  }

  async showCase(userId: number, pid: number) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    if (c.p.status === 'tracking') return this.sendTracking(userId, pid, false);
    const norm = this.norms.services[c.incident.service_key];
    const tz = c.house.tz;
    const calc = calcFor(this.db, this.norms, c, this.now());
    const est = estimate(calc, billsOf(c.p));
    const lines = [
      `${ICON[c.incident.service_key]} **${norm.title}**`,
      c.house.address,
      `с ${formatShort(new Date(c.p.started_at), tz)}${c.p.ended_at ? ` по ${formatShort(new Date(c.p.ended_at), tz)}` : ''}`,
      `Статус: ${STATUS_TITLE[c.p.status]}`,
    ];
    if (est.sum > 0) lines.push(`Расчёт: ≈ ${fmtRub(est.sum)}`);
    if (c.p.refund_amount) lines.push(`Вернули: ${fmtRub(c.p.refund_amount)}`);
    const photos = this.db.listPhotos(pid).length;
    if (photos) lines.push(`Фото к делу: ${photos}`);
    const rows: Btn[][] = [];
    if (c.p.status === 'ended') rows.push([cb('▶️ Продолжить расчёт', `calc:${pid}`)]);
    if (c.p.status === 'claim_ready' || c.p.status === 'refused' || c.p.status === 'refunded') rows.push([cb('📄 Прислать заявление ещё раз', `doc:${pid}`)]);
    if (c.p.status === 'claim_ready') rows.push([cb('✅ Перерасчёт пришёл', `rc:${pid}:y`), cb('❌ Не сделали', `rc:${pid}:n`)]);
    if (c.p.status === 'refused') rows.push([cb('⚖️ Что делать дальше', `escm:${pid}`)]);
    rows.push(...actButtons(this, c));
    if (c.p.status !== 'closed') rows.push([cb('📷 Добавить фото', `phadd:${pid}:evidence`)]);
    if (c.p.status !== 'refunded') rows.push([cb('🗑 Удалить случай', `stop:${pid}:n`)]);
    rows.push([cb('📋 Мои случаи', 'cases'), cb('⬅️ В начало', 'menu')]);
    return this.send(userId, { text: lines.join('\n'), buttons: rows });
  }

  private async stopCase(userId: number, pid: number, confirmed: boolean) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    if (!confirmed) {
      return this.send(userId, { text: 'Удалить этот случай вместе с расчётом и заявлением?', buttons: [[cb('🗑 Да, удалить', `stop:${pid}:y`), cb('Отмена', `cs:${pid}`)]] });
    }
    this.db.deleteParticipant(pid);
    return this.send(userId, { text: 'Случай удалён.', buttons: this.menu() });
  }

  // =====================================================================
  // Демо: сценарий за 2 минуты для проверки жюри
  // =====================================================================

  private async startDemo(userId: number) {
    const now = this.now();
    // Демо-дом не попадает в «Мои адреса» и не меняет настоящий адрес жителя.
    const house = this.db.upsertHouse('ДЕМО: ул. Примерная, 5', this.cfg.defaultTz, 1);
    const started = new Date(now.getTime() - 72 * MS_HOUR);
    const incident = this.db.createIncident({
      house_id: house.id,
      service_key: 'hot_water_off',
      reporter_user_id: userId,
      started_at: started.toISOString(),
      ads_number: 'ДЕМО-4512',
      evidence: 'ads',
      variant: null,
      demo: 1,
    });
    const p = this.db.addParticipant({ incident_id: incident.id, user_id: userId, role: 'reporter', started_at: started.toISOString() });
    this.db.track(userId, 'demo_started');
    await this.send(userId, {
      text: '🧪 **Демо** (данные тестовые). Три дня назад в доме отключили горячую воду, заявка ДЕМО-4512. Нажмите «Воду дали» → «Только что», введите 1200 — и дойдите до заявления.',
    });
    return this.sendTracking(userId, p.id, false);
  }

  // =====================================================================
  // Групповой (домовой) чат
  // =====================================================================

  private groupIntro(): OutMessage {
    return {
      text: [
        'Привет, соседи! Я **«Вернём»** — помогаю вернуть деньги за отключения воды, света и тепла по ПП РФ № 354.',
        'Если что-то отключили — напишите мне в личные сообщения: помогу зафиксировать нарушение, посчитать сумму и подготовить заявление.',
        '',
        'Чтобы я публиковал сюда карточки отключений, любой житель может отправить в этом чате команду /dom.',
      ].join('\n'),
      buttons: [[link('💬 Написать боту', `https://max.ru/${this.cfg.botUsername}`)]],
    };
  }

  private async onGroupAdded(chatId: number, title: string | null) {
    this.db.upsertChat(chatId, title);
    return this.out.toChat(chatId, this.groupIntro());
  }

  private async onGroupText(chatId: number, userId: number, text: string) {
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    if (cmd === '/vernem' || cmd === '/start' || cmd === '/help') return this.out.toChat(chatId, this.groupIntro());
    if (cmd !== '/dom') return;
    this.db.upsertChat(chatId, null);
    const user = this.db.getUser(userId);
    if (!user?.house_id) {
      return this.out.toChat(chatId, {
        text: 'Сначала напишите боту в личные сообщения и укажите адрес дома — тогда смогу привязать этот чат.',
        buttons: [[link('💬 Написать боту', `https://max.ru/${this.cfg.botUsername}`)]],
      });
    }
    const house = this.db.getHouse(user.house_id)!;
    this.db.linkChat(chatId, house.id, userId);
    this.db.updateUser(userId, { house_chat_id: chatId });
    return this.out.toChat(chatId, { text: `Чат привязан к дому: ${house.address}. Кнопка «Позвать соседей» будет публиковать карточки отключений сюда.` });
  }
}
