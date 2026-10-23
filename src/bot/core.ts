// Основной сценарий «Вернём»:
// что случилось → фиксация в АДС → отслеживание → «появилось?» → сумма из квитанции →
// расчёт → заявление (текст + PDF) → через месяц «перерасчёт пришёл?».
//
// Отдельные модули, которые действуют сами, без вопроса жителя:
//   house.ts    — сеть дома: уведомления соседям «у вас тоже?», подъезд, председатель;
//   acts.ts     — акт без исполнителя (п. 110(1)) и вопрос о проверке через 2 часа;
//   photos.ts   — фото к делу;
//   escalate.ts — требование о штрафе 50%, жалоба в ГЖИ, общество защиты прав потребителей.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, Evidence, ExecutorType, Incident, Participant, PhotoKind, ReminderKind } from '../db/db.ts';
import type { HeatingTempNorm, HotWaterTempNorm, Norms, ServiceKey } from '../calc/norms.ts';
import { SERVICE_ORDER } from '../calc/norms.ts';
import { fmtNum, fmtPercent, fmtRub, parseRubles, parseTemperature, plural } from '../calc/format.ts';
import { formatDate, formatDuration, formatShort, hoursBetween, localParts, fromLocal, monthTitle, parseLocalInput, MS_HOUR, monthKey, monthGenitive, toMinute } from '../calc/time.ts';
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
  canDispatch,
  dispatchCase,
  dispatcherNames,
  dispatchLine,
  expireDispatchers,
  onDispatchButton,
  onDispatcherRemove,
  onDispatchEnd,
  onDispatcherLeave,
  onDispatcherLink,
  onDispatcherTitle,
  onDispatchNumber,
  remindDispatch,
  tellDispatchersRestored,
} from './dispatch.ts';
import { askEmailClaim, canEmailClaim, finishEmail, forgetClaimPdfs, onEmailReply, rememberClaimPdf } from './mail.ts';
import { MAX_SIGNED_SCAN_BYTES, removeSignedScan, saveSignedScan } from '../files/signed-scans.ts';
import type { StoredSignedScan } from '../files/signed-scans.ts';
import {
  STATUS_TITLE,
  statusTitle,
  billsOf,
  calcFor,
  claimDocFor,
  claimOf,
  estimate,
  hasMoney,
  loadCase,
  claimSnapshot,
  snapshotChanged, snapshotIgnore,
  relatedOverlap,
} from '../services/cases.ts';
import type { CaseBundle } from '../services/cases.ts';
import { resetDemoCases } from '../sim/demo-cases.ts';
import type { BotConfig, Btn, InFile, Input, OutMessage, Outbox } from './types.ts';
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
  /** Заявку отправляем в УК через бота (УК дома подключена). */
  dispatch?: boolean;
  /** Плановое отключение горячей воды: до какого времени объявили работы (ISO). Перерыв — после этого срока. */
  plannedUntil?: string;
};

/** Сколько ждём отметку о подаче после выдачи заявления, прежде чем спросить. */
const SUBMIT_CHECK_DAYS = 3;

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
          text: 'Не удалось выполнить действие. Данные сохранены. Повторите попытку или вернитесь в главное меню.',
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
        if (this.db.getState(input.userId).state === 'await_signed_scan') {
          return this.send(input.userId, { text: 'Для заявления требуется один файл PDF со сканами всех заполненных и подписанных страниц. Прикрепите его через скрепку в разделе «Файл».', buttons: [[cb('⬅️ К случаю', `cs:${this.db.getState<{ pid?: number }>(input.userId).data.pid ?? ''}`)]] });
        }
        return onPhoto(this, input.userId, input.photos);
      case 'file':
        this.db.ensureUser(input.userId, input.name);
        return this.onSignedScanFile(input.userId, input.file);
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

  /** Ссылка «у меня тоже» для соседей; без ника бота (офлайн-демо) её не построить. */
  joinLink(c: CaseBundle): string | null {
    return this.cfg.botUsername ? this.deepLink(c.incident.code) : null;
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
    if (kind === 'ask_submitted') return this.remindSubmitted(pid);
    if (kind === 'ask_receipt') return this.remindReceipt(pid);
    if (kind === 'dispatch_timeout') return remindDispatch(this, pid);
    return remindInspection(this, pid);
  }

  /** Отправляет наступившие уведомления соседям (ночные уходят в 08:00). */
  flushAlerts() {
    return flushAlerts(this);
  }

  /** Отключает сотрудников УК, которые давно ничего не делали с заявками (вызывает планировщик раз в час). */
  expireDispatchers() {
    return expireDispatchers(this);
  }

  /** Удаление всех данных жителя (/delete_me и «Удалить мои данные» в приложении). */
  deleteUser(userId: number) {
    forgetClaimPdfs(this.db.listUserParticipants(userId).map((p) => p.id));
    const scans = this.db.listSignedScansForUser(userId);
    this.db.deleteUserData(userId);
    for (const scan of scans) removeSignedScan(this.cfg.signedScanDir, scan.storage_name);
  }

  /** Скан относится к конкретной версии заявления: изменили расчёт или шапку — нужен новый. */
  saveSignedScan(userId: number, pid: number, data: Buffer): string | null {
    const c = this.ownCase(userId, pid);
    const claim = c ? claimOf(c.p) : null;
    const snapshot = claim?.issuedSnapshot;
    if (!c || !claim || c.p.status !== 'claim_ready' || !snapshot || c.incident.demo || snapshotChanged(snapshot, claimSnapshot(this.db, this.norms, c, this.now()), snapshotIgnore(claim))) {
      return 'Сначала скачайте актуальное заявление';
    }
    let stored: StoredSignedScan;
    try {
      stored = saveSignedScan(this.cfg.signedScanDir, data);
    } catch (e) {
      return (e as Error).message;
    }
    try {
      const old = this.db.replaceSignedScan({
        participant_id: pid,
        user_id: userId,
        issued_snapshot: snapshot,
        filename: stored.filename,
        mime: stored.mime,
        bytes: stored.bytes,
        storage_name: stored.storageName,
        uploaded_at: this.now().toISOString(),
      });
      removeSignedScan(this.cfg.signedScanDir, old);
      this.db.track(userId, 'signed_scan_uploaded', { pid, bytes: stored.bytes });
      return null;
    } catch (e) {
      removeSignedScan(this.cfg.signedScanDir, stored.storageName);
      return 'Не удалось сохранить скан. Попробуйте ещё раз.';
    }
  }

  removeSignedScan(pid: number) {
    const scan = this.db.takeSignedScan(pid);
    removeSignedScan(this.cfg.signedScanDir, scan?.storage_name);
  }

  purgeSignedScans(before: Date) {
    for (const scan of this.db.takeExpiredSignedScans(before)) removeSignedScan(this.cfg.signedScanDir, scan.storage_name);
  }

  private async askSignedScan(userId: number, pid: number) {
    const c = this.ownCase(userId, pid);
    if (!c || c.p.status !== 'claim_ready' || !claimOf(c.p).issuedSnapshot || c.incident.demo) return this.stale(userId);
    this.db.setState(userId, 'await_signed_scan', { pid });
    return this.send(userId, {
      text: 'Распечатайте заявление, заполните пустые поля, поставьте дату и собственноручную подпись. Затем отсканируйте **все страницы в один PDF** и пришлите сюда файлом. Исходный PDF без подписи не отправляю в УК.',
      buttons: [[cb('⬅️ К случаю', `cs:${pid}`)]],
    });
  }

  private async onSignedScanFile(userId: number, file: InFile) {
    const state = this.db.getState<{ pid?: number }>(userId);
    const pid = state.data.pid;
    if (state.state !== 'await_signed_scan' || !pid || !this.ownCase(userId, pid)) return this.stale(userId);
    if (!file.url || !file.url.startsWith('https://')) {
      return this.send(userId, { text: 'Не смог получить файл от MAX. Откройте мини-приложение и загрузите PDF там.', buttons: [[cb('⬅️ К случаю', `cs:${pid}`)]] });
    }
    if (file.size !== null && file.size > MAX_SIGNED_SCAN_BYTES) {
      return this.send(userId, { text: 'Скан больше 10 МБ. Сожмите PDF и пришлите его снова.', buttons: [[cb('⬅️ К случаю', `cs:${pid}`)]] });
    }
    try {
      const response = await fetch(file.url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (!response.ok || (contentLength && contentLength > MAX_SIGNED_SCAN_BYTES)) throw new Error('size');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('body');
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_SIGNED_SCAN_BYTES) throw new Error('size');
        chunks.push(next.value);
      }
      const error = this.saveSignedScan(userId, pid, Buffer.concat(chunks));
      if (error) return this.send(userId, { text: `Не принял скан: ${error}.`, buttons: [[cb('📎 Попробовать снова', `scan:${pid}`)], [cb('⬅️ К случаю', `cs:${pid}`)]] });
      this.db.setState(userId, 'idle');
      return this.send(userId, { text: '✅ Подписанный скан получил. Теперь его можно отправить в УК на почту из карточки дела.', buttons: [[cb('📋 К случаю', `cs:${pid}`)]] });
    } catch {
      return this.send(userId, { text: 'Не смог скачать файл из MAX. Откройте мини-приложение и загрузите PDF там.', buttons: [[cb('⬅️ К случаю', `cs:${pid}`)]] });
    }
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
    r: {
      houseId: number;
      service: ServiceKey;
      evidence: Evidence;
      number: string | null;
      startedAt: Date;
      temp?: number;
      corner?: boolean;
      variant?: string;
      planned?: boolean;
      plannedUntil?: Date | null;
      dispatch?: boolean;
    },
  ): Promise<{ pid: number; outcome: 'new' | 'existing' | 'joined'; numberSaved?: boolean; neighbours?: number; readingSaved?: boolean; since?: string; dispatched?: boolean } | { error: string; field?: string }> {
    if (r.dispatch && !canDispatch(this, r.houseId)) return { error: 'УК этого дома ещё не подключена к боту. Обратитесь в аварийную службу' };
    const norm = this.norms.services[r.service];
    const uh = this.db.getUserHouse(userId, r.houseId);
    if (!uh) return { error: 'Этого адреса нет в вашем списке' };
    if (uh.demo) return { error: 'Это демо-адрес: настоящее дело на нём не создаётся. Выберите свой адрес' };
    // Плановое отключение в объявленный срок плату не снижает; не дали воду в срок — перерыв считается со срока окончания работ.
    let plannedUntil: Date | null = null;
    if (r.service === 'hot_water_off' && r.planned) {
      if (!r.plannedUntil || Number.isNaN(r.plannedUntil.getTime())) return { error: 'Укажите, до какого времени объявили отключение', field: 'plannedUntil' };
      plannedUntil = r.plannedUntil;
      if (plannedUntil.getTime() > this.now().getTime()) {
        return { error: `Отключение объявлено до ${formatShort(plannedUntil, uh.tz)}. До этого времени снижение платы не применяется. Если воду не восстановят в срок, сообщите о нарушении повторно.`, field: 'plannedUntil' };
      }
      if (!r.dispatch && r.startedAt.getTime() < plannedUntil.getTime() - 60_000) {
        return { error: `До ${formatShort(plannedUntil, uh.tz)} проводились объявленные работы. Укажите более позднее время`, field: 'started' };
      }
    }
    if (norm.kind !== 'interruption') {
      if (r.temp === undefined) return { error: 'Укажите температуру' };
      const threshold =
        norm.kind === 'heating_temperature'
          ? r.corner
            ? (norm.temperature as HeatingTempNorm).corner_norm_c
            : (norm.temperature as HeatingTempNorm).norm_c
          : (norm.temperature as HotWaterTempNorm).norm_c - (norm.temperature as HotWaterTempNorm).day_tolerance_c;
      if (r.temp >= threshold) return { error: `+${fmtNum(r.temp, 1)} °C соответствует норме: не ниже +${threshold} °C. Снижение платы не применяется.` };
    }
    // Не может быть одновременно «воды нет» и «вода еле тёплая» — второе дело только запутает расчёт.
    const RELATED: Partial<Record<ServiceKey, ServiceKey>> = { hot_water_temp: 'hot_water_off', hot_water_off: 'hot_water_temp', heating_temp: 'heating_off', heating_off: 'heating_temp' };
    const related = RELATED[r.service];
    const relatedOpen = related ? this.db.findOpenIncident(r.houseId, related) : undefined;
    if (related && relatedOpen && this.db.getParticipantFor(relatedOpen.id, userId)) {
      return { error: `По этому адресу уже открыто дело «${this.norms.services[related].button}». Сначала укажите время окончания в этом деле. После этого можно создать новое дело.` };
    }
    const overlap = relatedOverlap(this.db, this.norms, userId, r.houseId, r.service, r.startedAt, null);
    if (overlap) return { error: `За этот период уже есть дело ${overlap}. Одни и те же часы нельзя учитывать дважды. Укажите более позднее время.` };
    // Ответ про лифт — свойство дома: лимит перерыва света одинаков для всех дел этого дома.
    // «Да» и «Нет» из формы — ответ за весь дом, как в карточке дома; «Не знаю» приходит без варианта и ничего не меняет.
    if (r.service === 'electricity_off' && r.variant) {
      const house = this.db.getHouse(r.houseId)!;
      const two = r.variant === 'two_sources';
      if (this.db.houseInfo(house).twoPowerSources !== two) {
        this.db.setHouseInfo(r.houseId, { ...this.db.houseInfo(house), twoPowerSources: two, updatedAt: this.now().toISOString(), updatedBy: userId });
        this.recheckPowerCases(r.houseId);
      }
    }
    this.db.addUserHouse(userId, r.houseId);
    this.db.track(userId, 'report_started', { service: r.service, via: 'app' });
    const open = this.db.findOpenIncident(r.houseId, r.service);
    // Повторное сообщение не должно молча терять новый номер заявки. Номер — собственный номер жителя:
    // время начала дела он не меняет (звонок мог быть позже начала), поэтому время регистрации не выдумываем.
    const keepNumber = (p: Participant, inc: Incident): boolean => {
      const number = r.number?.trim();
      if (!number || r.evidence === 'self' || number === inc.ads_number || p.own_ads_number) return false;
      this.db.updateParticipant(p.id, { own_ads_number: number, own_evidence: r.evidence === 'written' ? 'written' : 'ads' });
      return true;
    };
    if (open) {
      const mine = this.db.getParticipantFor(open.id, userId);
      if (mine) {
        // Новый замер — в то же дело, временем «сейчас»: мерили только что.
        const readingSaved = norm.kind !== 'interruption' && r.temp !== undefined && mine.status === 'tracking';
        if (readingSaved) this.db.addReading(mine.id, this.now().toISOString(), r.temp!);
        const dispatched = !!r.dispatch && !(await dispatchCase(this, userId, mine.id));
        return { pid: mine.id, outcome: 'existing', numberSaved: keepNumber(mine, open), readingSaved, since: mine.started_at, dispatched };
      }
      await this.completeJoin(userId, open, norm.kind === 'interruption' ? null : r.temp!, !!r.corner);
      const joined = this.db.getParticipantFor(open.id, userId)!;
      const dispatched = !!r.dispatch && !(await dispatchCase(this, userId, joined.id));
      return { pid: joined.id, outcome: 'joined', numberSaved: keepNumber(joined, open), dispatched };
    }
    // Заявка через бота: начало — момент отправки, как у звонка в аварийную (п. 111).
    await this.createIncident(
      userId,
      {
        service: r.service,
        houseId: r.houseId,
        evidence: r.dispatch ? 'self' : r.evidence,
        number: r.dispatch ? null : r.number,
        variant: r.variant,
        corner: r.corner,
        temp: r.temp,
        hwChecked: true,
        dispatch: r.dispatch,
        plannedUntil: plannedUntil?.toISOString(),
      },
      r.dispatch ? this.now() : r.startedAt,
    );
    const pid = this.db.listUserParticipants(userId)[0].id;
    return { pid, outcome: 'new', neighbours: Math.max(0, this.db.countHouseMembers(r.houseId) - 1), dispatched: !!r.dispatch && !!this.db.dispatchFor(loadCase(this.db, pid)!.incident.id) };
  }

  /** Заявка в УК из мини-приложения по уже открытому делу. */
  dispatchFromApp(userId: number, pid: number): Promise<string | null> {
    return dispatchCase(this, userId, pid);
  }

  /** Исправить время начала или окончания своего дела. Время у соседей не меняется. */
  editTimesFromApp(userId: number, pid: number, startedAt: Date | null, endedAt: Date | null): string | null {
    const c = this.ownCase(userId, pid);
    if (!c) return 'Дело не найдено';
    if (c.p.status === 'refunded') return 'Перерасчёт уже отмечен. Изменение времени недоступно';
    // Поле времени в приложении без секунд: то же время до минуты — не изменение, храним прежнее точное.
    const sameMinute = (a: Date, b: Date) => Math.floor(a.getTime() / 60_000) === Math.floor(b.getTime() / 60_000);
    const oldStart = new Date(c.p.started_at);
    const oldEnd = c.p.ended_at ? new Date(c.p.ended_at) : null;
    const start = startedAt && !sameMinute(startedAt, oldStart) ? startedAt : oldStart;
    const end = endedAt && !(oldEnd && sameMinute(endedAt, oldEnd)) ? endedAt : oldEnd;
    if (start === oldStart && end === oldEnd) return null;
    const now = this.now().getTime();
    if (start.getTime() > now + 5 * 60_000) return 'Время начала ещё не наступило';
    if (now - start.getTime() > 366 * 24 * MS_HOUR) return 'Событие произошло более года назад. Рекомендуем обратиться в жилищную инспекцию';
    if (end && end.getTime() <= start.getTime()) return 'Окончание должно быть позже начала';
    if (end && end.getTime() > now + 5 * 60_000) return 'Время окончания ещё не наступило';
    const early = this.db.listReadings(pid).find((r) => new Date(r.at).getTime() < start.getTime() - 60_000);
    if (early) return `Есть замер раньше нового начала (${formatShort(new Date(early.at), c.house.tz)}). Удалите его или укажите начало не позже первого замера.`;
    const overlap = relatedOverlap(this.db, this.norms, userId, c.house.id, c.incident.service_key, start, end, pid);
    if (overlap) return `За этот период уже есть дело ${overlap}. Одни и те же часы нельзя учитывать дважды.`;
    // Подписанный на бумаге акт уже не изменить — время в заявлении должно совпадать с ним.
    const act = this.db.getActByIncident(c.incident.id);
    if (act?.status === 'signed' && start.getTime() !== new Date(c.p.started_at).getTime()) {
      return 'Акт уже подписан с этим временем начала. Чтобы изменить время, снимите отметку «подписан» и подпишите исправленный акт.';
    }
    // Окончание жителя, который задаёт время отключения, попадает и в акт — сверяем с подписанным.
    const endInAct = c.p.role === 'reporter' && !!c.incident.ended_at && c.incident.ended_at === c.p.ended_at;
    if (end && oldEnd && end !== oldEnd && endInAct) {
      const actProblem = this.actEndProblem(c, end);
      if (actProblem) return actProblem;
    }
    this.db.updateParticipant(pid, { started_at: start.toISOString(), ...(end && c.p.ended_at ? { ended_at: end.toISOString() } : {}) });
    // Кто сообщил первым, тот и задаёт время отключения — оно же попадает в акт.
    if (c.p.role === 'reporter') {
      const incEnd = c.incident.ended_at && end && c.incident.ended_at === c.p.ended_at ? end.toISOString() : undefined;
      this.db.setIncidentTimes(c.incident.id, start.toISOString(), incEnd);
    }
    if (c.p.ended_at && (c.p.status === 'ended' || c.p.status === 'closed')) {
      const calc = calcFor(this.db, this.norms, loadCase(this.db, pid)!, this.now());
      this.db.setCalc(pid, calc);
      this.db.updateParticipant(pid, { status: hasMoney(calc) ? 'ended' : 'closed' });
    }
    this.db.track(userId, 'times_edited', { via: 'app' });
    return null;
  }

  /** «Ещё не починили» — нажали «Починили» по ошибке. */
  reopenFromApp(userId: number, pid: number): string | null {
    const c = this.ownCase(userId, pid);
    if (!c) return 'Дело не найдено';
    if (c.p.status !== 'ended' && c.p.status !== 'closed') return 'Заявление уже подготовлено. Открыть дело повторно нельзя, но можно изменить время окончания';
    this.db.updateParticipant(pid, { ended_at: null, status: 'tracking', calc: null });
    // Отключение закрыл этот житель — открываем снова, чтобы соседи могли присоединиться.
    if (c.incident.ended_at && (c.p.role === 'reporter' || c.incident.ended_at === c.p.ended_at)) this.db.reopenIncident(c.incident.id);
    this.scheduleRestoredCheck(loadCase(this.db, pid)!.p, c.house.tz);
    this.db.track(userId, 'reopened', { via: 'app' });
    return null;
  }

  /** Удалить дело, созданное по ошибке. */
  deleteFromApp(userId: number, pid: number): string | null {
    const c = this.ownCase(userId, pid);
    if (!c) return 'Дело не найдено';
    this.removeSignedScan(pid);
    this.db.deleteParticipant(pid);
    return null;
  }

  /** Новый замер температуры из приложения. */
  /**
   * Изменился ответ «есть лифт» — лимит перерыва света в доме другой: дело, закрытое «без денег»,
   * может получить деньги, и наоборот. Заявления, уже выданные, помечаются устаревшими сами (снимок расчёта).
   */
  recheckPowerCases(houseId: number) {
    for (const p of this.db.listHouseParticipants(houseId, 'electricity_off')) {
      if (p.status !== 'ended' && p.status !== 'closed') continue;
      const c = loadCase(this.db, p.id);
      if (!c) continue;
      const calc = calcFor(this.db, this.norms, c, this.now());
      this.db.setCalc(p.id, calc);
      this.db.updateParticipant(p.id, { status: hasMoney(calc) ? 'ended' : 'closed' });
    }
  }

  /** Нижняя граница нормы для замера: ниже — нарушение. */
  normThreshold(serviceKey: ServiceKey, corner: boolean): number | null {
    const norm = this.norms.services[serviceKey];
    if (norm.kind === 'heating_temperature') return corner ? (norm.temperature as HeatingTempNorm).corner_norm_c : (norm.temperature as HeatingTempNorm).norm_c;
    if (norm.kind === 'hot_water_temperature') return (norm.temperature as HotWaterTempNorm).norm_c - (norm.temperature as HotWaterTempNorm).day_tolerance_c;
    return null;
  }

  addReadingFromApp(userId: number, pid: number, temp: number, at: Date): string | null {
    const c = this.ownCase(userId, pid);
    if (!c) return 'Дело не найдено';
    if (this.norms.services[c.incident.service_key].kind === 'interruption') return 'Замер нужен только для температуры';
    if (c.p.status !== 'tracking') return 'Дело уже закрыто для замеров';
    if (at.getTime() < new Date(c.p.started_at).getTime()) return 'Время замера раньше времени начала. Проверьте значение';
    if (at.getTime() > this.now().getTime() + 5 * 60_000) return 'Это время ещё не наступило';
    this.db.addReading(pid, at.toISOString(), temp);
    this.db.track(userId, 'reading', { via: 'app' });
    return null;
  }

  /** Перерасчёт пришёл (сумма), его не сделали или отметку нужно снять — ответ из приложения. */
  async receiptFromApp(userId: number, pid: number, action: 'yes' | 'no' | 'undo', amount: number | null): Promise<string | null> {
    const c = this.ownCase(userId, pid);
    if (!c) return 'Дело не найдено';
    if (c.p.status !== 'claim_ready' && c.p.status !== 'refused' && c.p.status !== 'refunded') return 'Сначала скачайте и подайте заявление';
    if (action === 'undo') {
      this.db.updateParticipant(pid, { status: 'claim_ready', refund_amount: null });
      return null;
    }
    const cl = claimOf(c.p);
    // «Не сделали» ведёт к требованию и жалобе — в них нужна дата подачи; без подачи сроки не идут.
    if (action === 'no' && !cl.submittedAt) return 'Сначала отметьте, когда подали заявление: от этой даты считаются сроки, и она попадёт в требование';
    // И «сделали», и «не сделали» видно только в квитанции за следующий месяц после подачи.
    const since = new Date(cl.submittedAt ?? cl.createdAt ?? this.now().toISOString());
    const [y, m] = monthKey(since, c.house.tz).split('-').map(Number);
    const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
    if (monthKey(this.now(), c.house.tz) < next && c.p.status === 'claim_ready') {
      return `Перерасчёт появится в квитанции за ${monthTitle(monthKey(since, c.house.tz))}, которая придёт в начале ${monthGenitive(next)}. Отметьте результат, когда получите её.`;
    }
    if (action === 'yes') {
      await this.finishRefund(userId, pid, amount);
      return null;
    }
    this.db.updateParticipant(pid, { status: 'refused', refund_amount: null });
    this.db.cancelReminders(pid, 'ask_receipt');
    this.db.track(userId, 'refund_no', { service: c.incident.service_key, via: 'app' });
    return null;
  }

  /**
   * Подписанный акт уже на бумаге. Окончание отключения (время дела, оно же попадает в акт) не должно ему противоречить:
   * если в акте окончание записано — не меняем его; если записано «на момент составления не устранено» — окончание
   * не может быть раньше составления акта. Иначе PDF акта разойдётся с подписанной бумагой.
   */
  actEndProblem(c: CaseBundle, end: Date): string | null {
    const act = this.db.getActByIncident(c.incident.id);
    if (act?.status !== 'signed') return null;
    const created = new Date(act.created_at);
    const tz = c.house.tz;
    const incEnd = c.incident.ended_at ? new Date(c.incident.ended_at) : null;
    if (incEnd && incEnd.getTime() <= created.getTime()) {
      return `Окончание (${formatShort(incEnd, tz)}) записано в подписанном акте. Чтобы изменить его, снимите отметку «подписан» и подпишите исправленный акт.`;
    }
    if (end.getTime() <= created.getTime()) {
      return `В подписанном акте указано, что на ${formatShort(created, tz)} услуга ещё не восстановлена. Время окончания не может быть раньше. Если это ошибка, снимите отметку «подписан» и подпишите исправленный акт.`;
    }
    return null;
  }

  /** «Починили» из мини-приложения. */
  async endFromApp(userId: number, pid: number, endedAt: Date): Promise<string | null> {
    const c = this.ownCase(userId, pid);
    if (!c) return 'Дело не найдено';
    if (c.p.status !== 'tracking') return 'Окончание уже записано';
    if (endedAt.getTime() <= new Date(c.p.started_at).getTime()) return 'Время окончания должно быть позже начала';
    if (endedAt.getTime() > this.now().getTime() + 5 * 60_000) return 'Это время ещё не наступило';
    const overlap = relatedOverlap(this.db, this.norms, userId, c.house.id, c.incident.service_key, new Date(c.p.started_at), endedAt, pid);
    if (overlap) return `За этот период уже есть дело ${overlap}. Одни и те же часы нельзя учитывать дважды. Исправьте время.`;
    // Окончание попадёт в акт, только если отключение ещё открыто (первый, кто отметил «починили»).
    const actProblem = c.incident.ended_at ? null : this.actEndProblem(c, endedAt);
    if (actProblem) return actProblem;
    await this.setEnded(userId, c, endedAt);
    return null;
  }

  /**
   * Заявление уже выдавали, а расчёт, время или доказательства с тех пор изменились (исправили время, добавили
   * отключение за тот же месяц, подписали акт): это новое заявление — новая дата, прежняя отметка о подаче не относится к нему.
   */
  refreshClaimIssue(pid: number): boolean {
    const c = loadCase(this.db, pid);
    if (!c || c.p.status === 'ended' || c.p.status === 'tracking' || c.p.status === 'closed') return false;
    const cl = claimOf(c.p);
    const snap = claimSnapshot(this.db, this.norms, c, this.now());
    if (cl.issuedSnapshot && !snapshotChanged(cl.issuedSnapshot, snap, snapshotIgnore(cl))) return false;
    const changed = !!cl.issuedSnapshot;
    const { submittedAt, incomingNumber, submittedVia, emailedTo, emailedAt, ...rest } = cl;
    const next = changed ? { ...rest, createdAt: this.now().toISOString(), issuedSnapshot: snap } : { ...cl, issuedSnapshot: snap };
    this.db.updateParticipant(pid, { claim: JSON.stringify(next) });
    if (changed) this.removeSignedScan(pid);
    // Новое заявление ещё не подано: квитанцию по старому не ждём, спросим о подаче нового.
    if (changed && c.p.status === 'claim_ready') {
      this.db.cancelReminders(pid, 'ask_receipt');
      if (!c.incident.demo) this.scheduleSubmittedCheck(pid, c.p.user_id, c.house.tz);
    }
    return changed;
  }

  /** Житель скачал заявление в приложении — значит, оно готово. Сроки пойдут, когда он отметит подачу. */
  markClaimIssued(pid: number) {
    const c = loadCase(this.db, pid);
    if (!c || c.p.status !== 'ended') return;
    this.db.updateParticipant(pid, {
      status: 'claim_ready',
      claim: JSON.stringify({ ...claimOf(c.p), createdAt: claimOf(c.p).createdAt ?? this.now().toISOString(), issuedSnapshot: claimSnapshot(this.db, this.norms, c, this.now()) }),
    });
    this.db.track(c.p.user_id, 'claim_created', { service: c.incident.service_key, via: 'app' });
    if (!claimOf(c.p).submittedAt && !c.incident.demo) this.scheduleSubmittedCheck(pid, c.p.user_id, c.house.tz);
  }

  /** Через несколько дней после выдачи спросим, подали ли заявление: без подачи квитанцию проверять рано. */
  scheduleSubmittedCheck(pid: number, userId: number, tz: string, days = SUBMIT_CHECK_DAYS) {
    const due = this.cfg.fastReminders ? new Date(this.now().getTime() + 3 * 60_000) : this.quietShift(new Date(this.now().getTime() + days * 24 * MS_HOUR), tz);
    this.db.schedule('ask_submitted', pid, userId, due);
  }

  /**
   * Заявление подано (отметка жителя или письмо на почту УК): квитанцию с перерасчётом ждём через месяц
   * после подачи. Вызывается после каждой новой отметки о подаче.
   */
  afterSubmitted(pid: number) {
    const c = loadCase(this.db, pid);
    const at = c ? claimOf(c.p).submittedAt : undefined;
    if (!c || !at) return;
    this.db.cancelReminders(pid, 'ask_submitted');
    if (c.p.status !== 'claim_ready') return;
    const now = this.now().getTime();
    const due = this.cfg.fastReminders
      ? new Date(now + 3 * 60_000)
      : this.quietShift(new Date(Math.max(new Date(at).getTime() + this.cfg.receiptCheckDays * 24 * MS_HOUR, now + 60_000)), c.house.tz);
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
    if (payload?.startsWith('d_')) return onDispatcherLink(this, userId, payload.slice(2));
    if (payload === 'demo' && this.cfg.demoMode) return this.askDemo(userId);
    return this.welcome(userId);
  }

  welcome(userId: number) {
    return this.send(userId, {
      text: 'Добро пожаловать в **«Вернём»**.\nЕсли коммунальная услуга не предоставляется или её качество нарушено, сервис поможет зафиксировать обстоятельства, рассчитать снижение платы и подготовить заявление.',
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
      case 'await_mail_reply':
        return onEmailReply(this, userId, text, data);
      case 'await_planned_end':
        return this.onPlannedEnd(userId, text, data.draft);
      case 'await_submitted_date':
        return this.onSubmittedDate(userId, text, data.pid);
      case 'await_incoming':
        return this.saveSubmitted(userId, data.pid, data.at, text);
      case 'await_dispatcher_title':
        return onDispatcherTitle(this, userId, text, data);
      case 'await_dispatch_number':
        return onDispatchNumber(this, userId, text, data);
      case 'await_photo':
        return this.send(userId, { text: 'Прикрепите фото к сообщению через скрепку в разделе «Фото».', buttons: [[cb('⬅️ К случаю', `cs:${data.pid}`)]] });
      case 'await_signed_scan':
        return this.send(userId, { text: 'Прикрепите один файл PDF: распечатайте заявление, заполните пустые поля, подпишите его и отсканируйте все страницы.', buttons: [[cb('⬅️ К случаю', `cs:${data.pid}`)]] });
      default:
        return this.send(userId, {
          text: 'Для продолжения используйте кнопки. Выберите тип нарушения или откройте список дел.',
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
    return this.send(userId, { text: 'Команда не распознана. Доступные действия указаны в меню.', buttons: this.menu() });
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
        return this.send(userId, { text: howItWorks(this.norms), buttons: [[cb('🚨 Сообщить о проблеме', 'new')], backRow()] });
      case 'new':
        this.db.setState(userId, 'idle');
        return this.send(userId, { text: 'Выберите тип нарушения.', buttons: serviceMenu(this.norms) });
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
      case 'calc': {
        // Старая кнопка «Продолжить расчёт» после выдачи заявления — показываем дело, а не начинаем заново.
        const c = this.ownCase(userId, pid);
        if (c && !['tracking', 'ended', 'closed'].includes(c.p.status)) return this.showCase(userId, pid);
        return this.resumeCalculation(userId, pid);
      }
      case 'billskip':
        return this.onBillSkip(userId);
      case 'ex':
      case 'pd':
      case 'sv': {
        // Получатель, данные и выдача заявления — только пока заявление готовят. Старая кнопка после
        // подачи или перерасчёта не должна менять дело.
        const c = this.ownCase(userId, pid);
        if (!c) return this.stale(userId);
        if (c.p.status !== 'ended' && c.p.status !== 'claim_ready') return this.showCase(userId, pid);
        if (head === 'ex') return this.onExecutorType(userId, pid, b as ExecutorType | 'ask', payload.split(':')[3]);
        if (head === 'pd') return this.onPersonalChoice(userId, pid, b);
        return this.issueClaim(userId, pid, b === '1');
      }
      case 'skip':
        return this.onPersonalSkip(userId);
      case 'sub':
        return this.askSubmitted(userId, pid);
      case 'subd':
        return this.onSubmittedButton(userId, pid, b);
      case 'subn': {
        const st = this.db.getState<{ pid: number; at: string }>(userId);
        if (st.state !== 'await_incoming' || st.data.pid !== pid) return this.stale(userId);
        return this.saveSubmitted(userId, pid, st.data.at, null);
      }
      case 'subw': {
        const c = this.ownCase(userId, pid);
        if (!c || c.p.status !== 'claim_ready') return this.stale(userId);
        this.scheduleSubmittedCheck(pid, userId, c.house.tz, 7);
        return this.send(userId, { text: `Хорошо, напомню через неделю. ${SEND_HOWTO}`, buttons: [[cb('📋 К делу', `cs:${pid}`)]] });
      }
      case 'dom':
        return this.onDomChoice(userId, Number(a), Number(b));
      case 'doc':
        return this.resendClaim(userId, pid);
      case 'send':
        return this.send(userId, { text: SEND_HOWTO, buttons: [[cb('📋 Мои случаи', 'cases')], backRow()] });
      case 'rc':
        return this.onReceiptAnswer(userId, pid, b);
      case 'rfskip': {
        const st = this.db.getState<{ pid: number }>(userId);
        const c = this.ownCase(userId, pid);
        if (!c || st.state !== 'await_refund' || st.data.pid !== pid || c.p.status !== 'claim_ready') return c ? this.showCase(userId, pid) : this.stale(userId);
        return this.finishRefund(userId, pid, null);
      }
      case 'cases':
        return this.showCases(userId);
      case 'cs':
        return this.showCase(userId, pid);
      case 'stop':
        return this.stopCase(userId, pid, b === 'y');
      case 'act':
        return this.send(userId, { text: actTemplate(this.norms.services[a as ServiceKey]?.title ?? 'коммунальная услуга', this.addressOf(userId)) });
      case 'demo':
        if (!this.cfg.demoMode) return this.stale(userId);
        if (a === 'reset') return this.restartDemo(userId);
        return a === 'ads' || a === 'act' ? this.startDemo(userId, a) : this.askDemo(userId);
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
      case 'scan':
        return this.askSignedScan(userId, pid);
      case 'esc':
      case 'escm': {
        // Требование и жалоба — только когда перерасчёт не сделали или сделали не полностью.
        const c = this.ownCase(userId, pid);
        if (!c) return this.stale(userId);
        if (c.p.status !== 'refused' && c.p.status !== 'refunded') return this.showCase(userId, pid);
        return head === 'esc' ? onEscalate(this, userId, pid, b) : showEscalation(this, userId, pid);
      }
      case 'mail':
        return askEmailClaim(this, userId, pid);
      case 'mailgo':
        return finishEmail(this, userId, pid, null);
      case 'dsp':
        return onDispatchButton(this, userId, pid, b);
      case 'dsx':
        return onDispatcherLeave(this, userId, pid);
      case 'dsr':
        return onDispatcherRemove(this, userId, pid, Number(b), payload.split(':')[3] === 'y');
      case 'dspend':
        return onDispatchEnd(this, userId, pid);
      case 'dspsend': {
        const err = await dispatchCase(this, userId, pid);
        if (err) return this.send(userId, { text: err, buttons: [[cb('📋 К делу', `cs:${pid}`)]] });
        return this.sendTracking(userId, pid, false, '📨 Заявка направлена в УК. Номер будет направлен после её принятия.');
      }
      case 'delme':
        this.deleteUser(userId);
        return this.send(userId, { text: 'Все ваши данные удалены. Чтобы начать новый сценарий, используйте команду /start.' });
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
      const two = this.db.houseInfo(house).twoPowerSources;
      if (two !== undefined) draft.variant = two ? 'two_sources' : 'one_source';
      else if (house.electricity_variant) {
        draft.variant = house.electricity_variant;
      } else {
        this.saveDraft(userId, 'draft', draft);
        // Два независимых ввода — свойство дома из техпаспорта, по лифту или этажности его не угадать.
        return this.send(userId, {
          text: 'У дома два независимых ввода электричества? Эти сведения указаны в техническом паспорте дома. При отсутствии данных применяется строгая норма: 24 ч в месяц.',
          buttons: [[cb('Два независимых', 'el:two_sources'), cb('Один / не знаю', 'el:one_source')], backRow()],
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
        // В объявленный срок плата не снижается. Воду не дали в срок — с этого момента перерыв, как при аварии.
        this.saveDraft(userId, 'await_planned_end', draft);
        return this.send(userId, {
          text: 'Плановое отключение в объявленный срок не уменьшает плату. Если водоснабжение не восстановлено в срок, с этого момента учитывается перерыв.\nУкажите объявленный срок окончания работ, например: 21.10 18:00.',
          buttons: [[cb('Объявления не было', 'hw:sudden')], backRow()],
        });
      }
      return this.continueDraft(userId, { ...draft, hwChecked: true, plannedUntil: undefined });
    }
    if (head === 'el') {
      if (draft.houseId) {
        this.db.setHouseVariant(draft.houseId, value);
        // «Два независимых» — ответ за весь дом, как в карточке дома; «Один / не знаю» ничего не утверждает.
        if (value === 'two_sources') {
          const house = this.db.getHouse(draft.houseId)!;
          const info = this.db.houseInfo(house);
          if (info.twoPowerSources !== true) {
            this.db.setHouseInfo(house.id, { ...info, twoPowerSources: true, updatedAt: this.now().toISOString(), updatedBy: userId });
            this.recheckPowerCases(house.id);
          }
        }
      }
      return this.continueDraft(userId, { ...draft, variant: value });
    }
    if (head === 'cr') return this.continueDraft(userId, { ...draft, corner: value === '1' });
    if (head === 'fx') {
      if (value === 'called') return this.continueDraft(userId, { ...draft, evidence: 'ads' });
      if (value === 'fail') return this.askFallback(userId, draft);
      // Заявка через бота: время начала — момент отправки, как у звонка в аварийную.
      if (value === 'dsp') return this.createIncident(userId, { ...draft, evidence: 'self', number: null, dispatch: true }, this.now());
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
    const uk = !!house && canDispatch(this, house.id);
    const lines = [
      uk ? `🏢 УК этого дома принимает заявки в боте (${dispatcherNames(this, house!.id)}). Направьте заявку. Номер поступит в это дело.` : '',
      uk ? `📞 Или обратитесь в аварийную службу${phone ? `: ${phone}` : ''}.` : `📞 **Обратитесь в аварийную службу**${phone ? `: ${phone}` : '. Телефон указан в квитанции.'}`,
      'Сообщите адрес и характер нарушения. Запишите номер заявки и сведения о диспетчере. Диспетчер обязан сообщить свои данные согласно п. 106 ПП № 354.',
    ];
    if (norm.kind !== 'interruption') lines.push('Попросите провести проверку и измерение. Срок проверки по правилам составляет не более двух часов.');
    if (norm.executor_hint) lines.push(norm.executor_hint);
    const rows: Btn[][] = [[cb('📞 Указать номер заявки', 'fx:called')], [cb('Не удалось дозвониться', 'fx:fail')], [cb('📍 Другой адрес', 'addr'), cb('⬅️ Меню', 'menu')]];
    if (uk) rows.unshift([cb('📨 Отправить заявку в УК', 'fx:dsp')]);
    return this.send(userId, { text: lines.filter(Boolean).join('\n'), buttons: rows });
  }

  private askFallback(userId: number, draft: Draft) {
    this.saveDraft(userId, 'draft', draft);
    return this.send(userId, {
      text: [
        'Сохраните снимок экрана с журналом звонков. Он подтверждает попытку обращения. Аварийная служба обязана ответить в течение 5 минут или перезвонить в течение 10 минут согласно п. 13 ПП № 416.',
        '',
        'При отсутствии номера заявки используйте один из способов фиксации:',
        '• если уже направили заявку через ГИС ЖКХ или «Госуслуги Дом», сохраните номер обращения;',
        '• укажите время нарушения и составьте акт с соседями.',
      ].join('\n'),
      buttons: [[cb('✍️ Указать номер обращения', 'fb:written')], [cb('Составить акт', 'fb:self')], backRow()],
    });
  }

  private async onNumber(userId: number, text: string, draft: Draft) {
    const number = clean(text).slice(0, 40);
    // В номере всегда есть цифры: «не назвали» — не номер, в заявлении он выглядел бы как «№ не назвали».
    if (!number || !/\d/.test(number)) {
      return this.send(userId, {
        text: 'Номер должен содержать цифры, например 4512 или А-17. Если номер не сообщён, выберите «Номера нет».',
        buttons: [[cb('Номера нет', 'fb:nonum')], backRow()],
      });
    }
    return this.continueDraft(userId, { ...draft, number });
  }

  private askStartTime(userId: number, draft: Draft) {
    const norm = this.norms.services[draft.service];
    this.saveDraft(userId, 'draft', draft);
    const tz = this.tz(draft.houseId);
    const planned = draft.plannedUntil ? new Date(draft.plannedUntil) : null;
    const q =
      draft.evidence === 'ads'
        ? 'Во сколько приняли заявку? С этого времени считаются часы (п. 111).'
        : draft.evidence === 'written'
          ? 'Когда отправили обращение?'
          : planned
            ? `С какого времени учитывать перерыв? Работы были объявлены до ${formatShort(planned, tz)}. Более раннее время указать нельзя.`
            : norm.kind === 'interruption'
              ? `Когда пропала ${norm.genitive.startsWith('горяч') || norm.genitive.startsWith('холодн') ? 'вода' : 'услуга'}?`
              : 'Когда измерили температуру?';
    const rows = [...timeButtons('ts', 'start'), backRow()];
    if (planned && draft.evidence !== 'ads' && draft.evidence !== 'written') rows.unshift([cb(`С ${formatShort(planned, tz)}: срок восстановления воды`, 'ts:planned')]);
    return this.send(userId, { text: q, buttons: rows });
  }

  /** Житель написал, до какого времени объявили плановое отключение горячей воды. */
  private async onPlannedEnd(userId: number, text: string, draft: Draft) {
    if (!draft) return this.stale(userId);
    const tz = this.tz(draft.houseId);
    const r = parseLocalInput(text, this.now(), tz, { future: true });
    if (!r.ok) return this.send(userId, { text: r.error, buttons: [[cb('Объявления не было', 'hw:sudden')], backRow()] });
    if (r.date.getTime() > this.now().getTime()) {
      this.db.setState(userId, 'idle');
      return this.send(userId, {
        text: `Срок работ установлен до ${formatShort(r.date, tz)}. До этого времени снижение платы не применяется. Если услугу не восстановят в срок, создайте новое сообщение о проблеме.`,
        buttons: this.menu(),
      });
    }
    return this.continueDraft(userId, { ...draft, hwChecked: true, plannedUntil: r.date.toISOString() });
  }

  private async onStartTimeButton(userId: number, code: string) {
    const draft = this.draftFromState(userId);
    if (!draft) return this.stale(userId);
    if (code === 'manual') {
      this.saveDraft(userId, 'await_time_start', draft);
      return this.send(userId, { text: TIME_HINT, buttons: [backRow()] });
    }
    if (code === 'planned' && draft.plannedUntil) return this.createIncident(userId, draft, new Date(draft.plannedUntil));
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
    // До срока окончания плановых работ перерыва нет — начало дела не может быть раньше.
    if (draft.plannedUntil && startedAt.getTime() < new Date(draft.plannedUntil).getTime() - 60_000) {
      this.saveDraft(userId, 'draft', draft);
      return this.send(userId, {
        text: `До ${formatShort(new Date(draft.plannedUntil), house.tz)} проводились объявленные работы. Время начала не может быть раньше. Выберите другое время.`,
        buttons: [[cb(`С ${formatShort(new Date(draft.plannedUntil), house.tz)}`, 'ts:planned')], ...timeButtons('ts', 'start'), backRow()],
      });
    }
    const incident = this.db.createIncident({
      house_id: house.id,
      service_key: draft.service,
      reporter_user_id: userId,
      started_at: startedAt.toISOString(),
      ads_number: draft.number ?? null,
      evidence: draft.evidence ?? 'self',
      variant: draft.variant ?? null,
      entrance: this.db.getUserHouse(userId, house.id)?.entrance ?? null,
      planned_until: draft.service === 'hot_water_off' ? (draft.plannedUntil ?? null) : null,
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
    const sent = !!draft.dispatch && !(await dispatchCase(this, userId, p.id));
    const extra = [
      sent ? '📨 Заявка направлена в УК. Номер будет направлен после её принятия.' : '',
      n ? `📣 Сообщил ${n} ${plural(n, ['соседу', 'соседям', 'соседям'])}${night ? ' (утром в 08:00)' : ''}.` : '',
    ].filter(Boolean);
    return this.sendTracking(userId, p.id, true, extra.length ? extra.join('\n') : undefined);
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
    const d = this.db.dispatchFor(c.incident.id);
    if (!c.incident.ads_number && !c.p.own_ads_number && !c.incident.demo && (!d || d.status === 'declined') && canDispatch(this, c.house.id)) {
      rows.push([cb('📨 Отправить заявку в УК', `dspsend:${c.p.id}`)]);
    }
    if ((c.p.role === 'neighbour' || c.incident.evidence === 'self') && !c.p.own_ads_number) rows.push([cb('✏️ Ввести свой номер заявки', `own:${c.p.id}`)]);
    rows.push([cb('👥 Позвать соседей', `nb:${c.p.id}`), cb('📷 Фото', `phadd:${c.p.id}:evidence`)]);
    rows.push(...actButtons(this, c));
    rows.push([cb('⬅️ Меню', 'menu')]);
    return rows;
  }

  private restoredWord(service: ServiceKey) {
    const map: Partial<Record<ServiceKey, string>> = {
      electricity_off: 'Электроснабжение восстановлено',
      gas_off: 'Газоснабжение восстановлено',
      heating_off: 'Отопление восстановлено',
      sewerage_off: 'Водоотведение восстановлено',
      waste_off: 'Отходы вывезены',
    };
    return map[service] ?? 'Водоснабжение восстановлено';
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
      `${fresh ? '✅ **Обращение зарегистрировано.**' : '👀 **Ведётся контроль.**'} ${ICON[c.incident.service_key]} ${norm.title}`,
      `${c.house.address}, с ${formatShort(new Date(c.p.started_at), tz)}, ${evidenceLine}.`,
    ];
    if (readings.length) lines.push(`Последний замер: +${fmtNum(readings[readings.length - 1].temp_c, 1)} °C.`);
    const dispatch = this.db.dispatchFor(c.incident.id);
    if (dispatch) lines.push(dispatchLine(dispatch, tz));
    const waiting = dispatch?.status === 'sent' && !dispatch.timeout_at;
    if (c.incident.evidence === 'self' && !c.p.own_ads_number && !waiting && !this.db.getActByIncident(c.incident.id)) lines.push('При отсутствии номера заявки составьте акт с соседями. Он подтвердит факт нарушения.');
    if (extra) lines.push(extra);
    lines.push(`Напоминание о восстановлении услуги поступит через ${this.cfg.restoreCheckHours} ч. Если услугу восстановят раньше, нажмите ✅.`);
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
        text: `По случаю «${norm.title}» с ${formatShort(started, tz)} более трёх недель нет отметки о восстановлении. Напоминания остановлены. Откройте дело в разделе «Мои дела», когда услуга будет восстановлена.`,
        buttons: [[cb('📋 Мои случаи', 'cases')]],
      });
    }
    const q =
      norm.kind === 'interruption'
        ? `${ICON[c.incident.service_key]} Услуга восстановлена? ${norm.title}, ${c.house.address}. Продолжительность нарушения: ${formatDuration(hours)}.`
        : `${ICON[c.incident.service_key]} Температура восстановилась? ${c.house.address}. Продолжительность нарушения: ${formatDuration(hours)}. Если нет, направьте новый замер. Каждый замер учитывается не более суток.`;
    const buttons: Btn[][] = [[cb(norm.kind === 'interruption' ? '✅ Да, восстановили' : '✅ Да, тепло', `rest:${pid}:y`), cb('Ещё нет', `rest:${pid}:n`)]];
    if (norm.kind !== 'interruption') buttons.push([cb('🌡 Новый замер', `tmp:${pid}`)]);
    // send, а не safeSend: не дошло — планировщик повторит напоминание.
    await this.send(c.p.user_id, { text: q, buttons });
    this.scheduleRestoredCheck(c.p, tz);
  }

  private async onRestoredAnswer(userId: number, pid: number, answer: string) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    if (c.p.status !== 'tracking') return this.showCase(userId, pid);
    if (answer === 'n') {
      this.scheduleRestoredCheck(c.p, c.house.tz);
      return this.send(userId, {
        text: this.cfg.fastReminders ? 'Следующее напоминание поступит через несколько минут в демо-режиме.' : `Следующее напоминание поступит через ${this.cfg.restoreCheckHours} ч. В ночное время уведомления не направляются.`,
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

  async setEnded(userId: number, c: CaseBundle, endedAt: Date) {
    if (endedAt.getTime() <= new Date(c.p.started_at).getTime()) {
      return this.send(userId, {
        text: `Время окончания должно быть позже начала (${formatShort(new Date(c.p.started_at), c.house.tz)}). Выберите другое время.`,
        buttons: [...timeButtons(`te:${c.p.id}`, 'end'), backRow()],
      });
    }
    const actProblem = c.incident.ended_at ? null : this.actEndProblem(c, endedAt);
    if (actProblem) return this.send(userId, { text: actProblem, buttons: [...timeButtons(`te:${c.p.id}`, 'end'), backRow()] });
    this.db.updateParticipant(c.p.id, { ended_at: endedAt.toISOString(), status: 'ended' });
    this.db.cancelReminders(c.p.id, 'ask_restored');
    this.db.setState(userId, 'idle');
    this.db.track(userId, 'restored', { service: c.incident.service_key });

    let ukTold = false;
    if (!c.incident.ended_at) {
      this.db.closeIncident(c.incident.id, endedAt.toISOString());
      await this.notifyNeighboursClosed(c, endedAt);
      ukTold = await tellDispatchersRestored(this, c.incident.id, endedAt);
    }
    const viaUk = ukTold || this.db.dispatchFor(c.incident.id)?.status === 'fixed';
    const tail = viaUk ? ' УК уведомлена.' : c.incident.evidence === 'self' ? '' : ' Сообщите об этом в аварийную службу. Так фиксируется окончание нарушения согласно п. 112 ПП № 354.';
    await this.send(userId, { text: `✅ Восстановление услуги зафиксировано: ${formatShort(endedAt, c.house.tz)}.${tail}` });
    return this.resumeCalculation(userId, c.p.id);
  }

  private async notifyNeighboursClosed(c: CaseBundle, endedAt: Date) {
    const norm = this.norms.services[c.incident.service_key];
    for (const other of this.db.listParticipants(c.incident.id)) {
      if (other.id === c.p.id || other.status !== 'tracking') continue;
      await this.safeSend(other.user_id, {
        text: `${ICON[c.incident.service_key]} Сосед указал, что услуга восстановлена ${formatShort(endedAt, c.house.tz)}. У вас услуга также восстановлена?`,
        buttons: [[cb('✅ Да', `same:${other.id}:y`), cb('Ещё нет', `same:${other.id}:n`)]],
      });
    }
  }

  private async onSameAnswer(userId: number, pid: number, answer: string) {
    const c = this.ownCase(userId, pid);
    if (!c || c.p.status !== 'tracking') return this.stale(userId);
    if (answer === 'y' && c.incident.ended_at) return this.setEnded(userId, c, new Date(c.incident.ended_at));
    return this.send(userId, { text: 'Дело будет отслеживаться отдельно.', buttons: this.trackingButtons(c) });
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
        text: `+${fmtNum(t, 1)} °C соответствует норме (${normText}). Снижение платы не применяется. Если в другой комнате температура ниже или ситуация изменилась, направьте новый замер.`,
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
      await this.send(userId, { text: '✅ Вы присоединились к делу. Отключение уже завершено. Выполняется расчёт.' });
      await inviteToAct(this, incident.id, userId);
      return this.setEnded(userId, loadCase(this.db, p.id)!, new Date(incident.ended_at));
    }
    this.scheduleRestoredCheck(p, house.tz);
    await this.sendTracking(userId, p.id, false, 'Есть собственный номер заявки? Укажите его. При отсутствии номера будет указан номер соседа.');
    // Если соседи уже собирают акт — новый участник сразу получает его на подтверждение.
    return inviteToAct(this, incident.id, userId);
  }

  private async onOwnNumber(userId: number, text: string, pid: number) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    const number = clean(text).slice(0, 40);
    if (!number) return this.send(userId, { text: 'Напишите номер цифрами или буквами.' });
    this.db.updateParticipant(pid, { own_ads_number: number, own_evidence: 'ads' });
    this.db.setState(userId, 'idle');
    await this.send(userId, { text: `Записал ваш номер заявки: ${number}.` });
    return c.p.status === 'tracking' ? this.sendTracking(userId, pid, false) : this.showCase(userId, pid);
  }

  cardMessage(c: CaseBundle): OutMessage {
    const norm = this.norms.services[c.incident.service_key];
    const tz = c.house.tz;
    const n = norm.interruption;
    const rule = n
      ? `За каждый ${n.unit_hours === 1 ? 'час' : `${n.unit_hours} ч`} сверх допустимого применяется снижение платы на ${fmtPercent(n.rate_percent)} согласно ПП РФ № 354.`
      : 'За каждый час низкой температуры применяется снижение платы согласно ПП РФ № 354.';
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
    // Чат именно этого дома: карточку с адресом не отправляем в чат другого адреса жителя.
    const chat = this.db.houseChat(c.house.id);
    await this.send(userId, {
      text: chat
        ? 'Карточка представлена ниже. Её можно опубликовать в чате дома с рабочей кнопкой.'
        : 'Перешлите карточку ниже в домовой чат. При пересылке кнопка пропадёт, но ссылка в тексте работает. Кнопки видны, только если бот сам публикует в группе: добавьте его в чат и отправьте там /dom.',
    });
    const sent = await this.send(userId, this.cardMessage(c));
    if (sent.mid) this.db.updateParticipant(pid, { last_card_mid: sent.mid });
    this.db.track(userId, 'card_created', { incident: c.incident.id });
    const rows: Btn[][] = [];
    if (chat) rows.push([cb('📣 Опубликовать в чате дома', `post:${pid}`)]);
    if (this.cfg.miniAppEnabled) rows.push([app('📱 Поделиться через приложение', `share_${pid}`)]);
    rows.push([cb('⬅️ К делу', `cs:${pid}`)]);
    return this.send(userId, { text: 'Готово.', buttons: rows });
  }

  private async postToHouseChat(userId: number, pid: number) {
    const c = this.ownCase(userId, pid);
    const chat = c ? this.db.houseChat(c.house.id) : undefined;
    if (!c || !chat) return this.stale(userId);
    try {
      await this.out.toChat(chat.chat_id, this.cardMessage(c));
      this.db.track(userId, 'card_posted', { incident: c.incident.id });
      return this.send(userId, { text: 'Опубликовал карточку в чате дома 📣' });
    } catch (e) {
      console.error('[bot] не удалось опубликовать в чат', e);
      this.db.unlinkChat(chat.chat_id);
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
        text: ['**Снижение платы не применяется:** перерыв не превышает норматив.', ...calc.months.flatMap((m) => m.lines), 'Лимит установлен на весь месяц. При повторном отключении в этом месяце сообщите о нём, чтобы учесть все перерывы.'].join('\n'),
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
        text: `Сколько начислено за «${norm.title.toLowerCase()}» за ${monthTitle(months[idx])}? Укажите сумму по этой услуге, а не итоговую сумму квитанции. Если новой квитанции нет, используйте предыдущую. Например: 1200`,
        buttons: [[cb('Не знаю. Рассчитать в процентах', 'billskip')], backRow()],
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
    const est = estimate(calc, bills, claimOf(c.p));
    const tz = c.house.tz;
    const start = new Date(c.p.started_at);
    const end = new Date(c.p.ended_at!);
    const adsNumber = c.p.own_ads_number || c.incident.ads_number;

    const totalPercent = calc.months.reduce((s, m) => s + m.percent, 0);
    const lines = [
      est.sum > 0 ? `💰 **Положено ≈ ${fmtRub(est.sum)}**${est.complete ? '' : ' (+ месяцы без суммы)'}` : `💰 **Положено снижение платы на ${fmtPercent(Math.round(totalPercent * 100) / 100)}**`,
      `${norm.title}: ${formatShort(start, tz)} – ${formatShort(end, tz)} (${formatDuration(hoursBetween(toMinute(start), toMinute(end)))})${adsNumber ? `, ${c.incident.evidence === 'ads' ? 'заявка' : 'обращение'} № ${clean(adsNumber)}` : ''}.`,
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
        text: `Направить заявление в «${known.name}» из карточки дома?`,
        buttons: [[cb('✅ Да', `ex:${pid}:${known.type}:h`), cb('Другой получатель', `ex:${pid}:ask`)]],
      });
    }
    return this.askExecutorType(userId, pid);
  }

  private askExecutorType(userId: number, pid: number) {
    const c = this.ownCase(userId, pid)!;
    const norm = this.norms.services[c.incident.service_key];
    const rows: Btn[][] = [[cb('УК / ТСЖ', `ex:${pid}:uk`), cb('Поставщику (Теплосеть и т. п.)', `ex:${pid}:rso`)]];
    if (c.incident.service_key === 'waste_off') rows.push([cb('Региональному оператору ТКО', `ex:${pid}:rop`)]);
    rows.push([cb('Не знаю', `ex:${pid}:unknown`)]);
    return this.send(userId, {
        text: `Кому направить заявление по услуге «${norm.title.toLowerCase()}»? Проверьте получателя платежа в квитанции. Он рассматривает вопрос о перерасчёте.`,
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
    const person = this.claimPerson(userId, c);
    if (person.fio && person.flat) {
      return this.send(userId, {
        text: `Использовать данные для заявления: ${clean(person.fio)}, квартира ${clean(person.flat)}${person.account ? `, лицевой счёт ${clean(person.account)}` : ''}?`,
        buttons: [[cb('✅ Да', `pd:${pid}:reuse`), cb('Другие данные', `pd:${pid}:new`)]],
      });
    }
    return this.askPersonal(userId, pid, 'await_fio');
  }

  /** ФИО и квартира для заявления: сохранённые — или как в акте по этому отключению (они должны совпадать). */
  private claimPerson(userId: number, c: CaseBundle) {
    const person = this.db.personFor(userId, c.house.id);
    if (person.fio) return person;
    const act = this.db.getActByIncident(c.incident.id);
    const signer = act ? this.db.listSigners(act.id).find((s) => s.user_id === userId) : undefined;
    return signer ? { ...person, fio: signer.fio, flat: signer.flat ?? person.flat } : person;
  }

  private async onPersonalChoice(userId: number, pid: number, choice: string) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    if (choice === 'reuse') {
      const u = this.claimPerson(userId, c);
      const claim = { ...claimOf(c.p), fio: u.fio ?? undefined, flat: u.flat ?? undefined, account: u.account ?? undefined };
      this.db.updateParticipant(pid, { claim: JSON.stringify(claim) });
      return this.nextPersonal(userId, 'await_account', pid);
    }
    return this.askPersonal(userId, pid, 'await_fio');
  }

  private askPersonal(userId: number, pid: number, state: string) {
    this.db.setState(userId, state, { pid });
    const prompts: Record<string, { text: string; skip: boolean }> = {
      await_fio: { text: 'Укажите фамилию, имя и отчество. Заявление будет подано от вашего имени.', skip: false },
      await_flat: { text: 'Укажите номер квартиры.', skip: false },
      await_account: { text: 'Укажите лицевой счёт из квитанции. Это поможет идентифицировать лицевой счёт.', skip: true },
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
      text: 'Сохранить фамилию, имя, отчество и номер квартиры для следующих заявлений?',
      buttons: [[cb('Запомнить', `sv:${pid}:1`), cb('Не сохранять', `sv:${pid}:0`)]],
    });
  }

  private async issueClaim(userId: number, pid: number, save: boolean) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    // Дата заявления — первая выдача: повторная не меняет дату в документе.
    const claim = { ...claimOf(c.p), createdAt: claimOf(c.p).createdAt ?? this.now().toISOString(), issuedSnapshot: claimSnapshot(this.db, this.norms, c, this.now()) };
    this.db.updateParticipant(pid, { claim: JSON.stringify(claim), status: 'claim_ready' });
    if (save) this.db.savePerson(userId, c.house.id, claim);

    const fresh = loadCase(this.db, pid)!;
    const doc = claimDocFor(this.db, this.norms, fresh, this.now());
    // Текстом заявление не дублируем: PDF удобнее распечатать, отправить или переписать от руки.
    const pdf = await this.sendDocPdf(userId, doc, `📄 **Заявление подготовлено**${doc.total ? `. Ориентировочная сумма: ${fmtRub(doc.total)}` : ''}.`);
    if (pdf) rememberClaimPdf(pid, pdf);
    this.db.track(userId, 'claim_created', { service: c.incident.service_key, sum: doc.total });

    if (!save) {
      const { fio, flat, account, ...rest } = claim;
      this.db.updateParticipant(pid, { claim: JSON.stringify(rest) });
    }
    // Сроки (проверка квитанции, требование) идут от подачи, а не от скачивания: сначала спросим, подали ли.
    if (!claimOf(fresh.p).submittedAt && !c.incident.demo) this.scheduleSubmittedCheck(pid, userId, c.house.tz);
    // Без номера заявки и без подписанного акта заявление слабое — говорим прямо и даём кнопку акта.
    const act = this.db.getActByIncident(c.incident.id);
    const weak = c.incident.evidence === 'self' && !c.p.own_ads_number && act?.status !== 'signed';
    const lateNumber = c.incident.evidence === 'self' && !!c.p.own_ads_number && act?.status !== 'signed';
    const rows: Btn[][] = weak || lateNumber ? actButtons(this, fresh) : [];
    // Для электронной подачи нужен именно скан заполненного и подписанного заявления.
    rows.unshift([cb('📎 Прислать подписанный скан', `scan:${pid}`)]);
    rows.push([cb('✅ Заявление подано', `sub:${pid}`)]);
    rows.push([cb('👥 Позвать соседей', `nb:${pid}`), cb('⬅️ Меню', 'menu')]);
    return this.send(userId, {
      text: [
        weak ? '⚠️ В заявлении нет номера заявки или акта. Составьте акт с соседями и приложите его.' : '',
        lateNumber ? '⚠️ Номер заявки получен позже начала: время до звонка подтвердит только акт с соседями.' : '',
        act?.status === 'signed' ? '📎 Акт указан в приложениях. Приложите его копию к заявлению.' : '',
        act?.status === 'signed' && act.chair_signed === 0 ? '⚠️ В акте нет подписи председателя совета дома. Если председатель есть, попросите его подписать акт.' : '',
        SEND_HOWTO,
        'После подачи выберите «Заявление подано». С этой даты будет отслеживаться квитанция с перерасчётом.',
        save ? '' : 'Фамилия, имя, отчество и номер квартиры удалены из базы. Они сохранены только в файле PDF.',
      ]
        .filter(Boolean)
        .join('\n'),
      buttons: rows,
    });
  }

  private async sendPdf(userId: number, c: CaseBundle) {
    const pdf = await this.sendDocPdf(userId, claimDocFor(this.db, this.norms, c, this.now()), 'Файл PDF для печати или отправки:');
    if (pdf) rememberClaimPdf(c.p.id, pdf);
    return pdf;
  }

  /**
   * Отправляет любой документ жителя PDF-файлом: заявление, акт, требование, жалобу.
   * Файл с ФИО лежит на диске только на время отправки. Возвращает сам PDF (для письма в УК) или null.
   */
  async sendDocPdf(userId: number, doc: ClaimDoc, caption: string): Promise<Buffer | null> {
    const name = doc.fileName ?? 'Документ.pdf';
    let dir: string | null = null;
    try {
      const pdf = await claimToPdf(doc);
      dir = mkdtempSync(join(this.cfg.tmpDir, 'doc-'));
      const path = join(dir, name);
      writeFileSync(path, pdf);
      await this.send(userId, { text: caption, file: { path, name } });
      return pdf;
    } catch (e) {
      console.error('[bot] не удалось отправить PDF', e);
      await this.safeSend(userId, { text: 'Не удалось отправить файл PDF. Повторите попытку позже.' });
      return null;
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
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
    // Квитанцию проверяем только по поданному заявлению: без подачи перерасчёта и не ждём.
    if (!c || c.p.status !== 'claim_ready' || !claimOf(c.p).submittedAt) return;
    const norm = this.norms.services[c.incident.service_key];
    return this.send(c.p.user_id, {
      text: `Получена новая квитанция? Проверьте перерасчёт за «${norm.title.toLowerCase()}» (${formatShort(new Date(c.p.started_at), c.house.tz)}). Если перерасчёта нет, направьте фото квитанции.`,
      buttons: [
        [cb('✅ Да, вернули', `rc:${pid}:y`), cb('❌ Нет', `rc:${pid}:n`)],
        [cb('📷 Фото квитанции', `phadd:${pid}:receipt`), cb('Ещё не пришла', `rc:${pid}:w`)],
      ],
    });
  }

  private async onReceiptAnswer(userId: number, pid: number, answer: string) {
    const c = this.ownCase(userId, pid);
    if (!c) return this.stale(userId);
    // Старая кнопка из напоминания: результат уже отмечен — не переписываем его.
    if (c.p.status !== 'claim_ready') return this.showCase(userId, pid);
    if (answer === 'n' && !claimOf(c.p).submittedAt) {
      return this.send(userId, {
        text: 'Сначала отметьте, когда подали заявление: от этой даты считаются сроки, и она попадёт в требование.',
        buttons: [[cb('✅ Я подал(а) заявление', `sub:${pid}`)], [cb('📋 К делу', `cs:${pid}`)]],
      });
    }
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
    const c = this.ownCase(userId, pid);
    if (!c || c.p.status !== 'claim_ready') {
      this.db.setState(userId, 'idle');
      return c ? this.showCase(userId, pid) : this.stale(userId);
    }
    const amount = parseRubles(text);
    if (amount === null) return this.send(userId, { text: 'Напишите сумму числом, например 115 или 115,20.', buttons: [[cb('Не помню', `rfskip:${pid}`)]] });
    return this.finishRefund(userId, pid, amount);
  }

  async finishRefund(userId: number, pid: number, amount: number | null) {
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
    const expected = estimate(calcFor(this.db, this.norms, c, this.now()), billsOf(c.p), claimOf(c.p));
    const partial = amount !== null && expected.sum > 0 && amount < expected.sum * 0.9;
    const lines = [`🎉 Исполнитель заплатил за плохую услугу.${total > 0 ? `\nВсего вы вернули с ботом: **${fmtRub(Math.round(total * 100) / 100)}**.` : ''}`];
    if (partial) {
      lines.push('', `По расчёту положено ≈ ${fmtRub(expected.sum)}, а вернули ${fmtRub(amount!)}. Можно потребовать остальное и штраф 50% за нарушение порядка расчёта.`);
      return this.send(userId, { text: lines.join('\n'), buttons: [[cb('⚖️ Потребовать остальное', `escm:${pid}`)], ...this.menu()] });
    }
    lines.push('', 'Сообщите соседям о результате. Они могут проверить своё право на перерасчёт.');
    return this.send(userId, { text: lines.join('\n'), buttons: this.menu() });
  }

  // =====================================================================
  // Подача заявления: с неё идут сроки
  // =====================================================================

  /** Через несколько дней после выдачи: подали ли заявление. */
  async remindSubmitted(pid: number) {
    const c = loadCase(this.db, pid);
    if (!c || c.p.status !== 'claim_ready' || claimOf(c.p).submittedAt) return;
    const norm = this.norms.services[c.incident.service_key];
    return this.send(c.p.user_id, {
      text: `📄 Вы подали заявление о перерасчёте («${norm.title.toLowerCase()}», ${formatShort(new Date(c.p.started_at), c.house.tz)})? Отметьте дату: с неё я жду квитанцию с перерасчётом.`,
      buttons: [[cb('✅ Подал(а)', `sub:${pid}`), cb('Ещё нет', `subw:${pid}`)], [cb('📄 Прислать заявление ещё раз', `doc:${pid}`)]],
    });
  }

  private askSubmitted(userId: number, pid: number) {
    const c = this.ownCase(userId, pid);
    if (!c || c.p.status !== 'claim_ready') return c ? this.showCase(userId, pid) : this.stale(userId);
    this.db.setState(userId, 'idle');
    return this.send(userId, {
      text: 'Когда подали заявление? Дата попадёт в требование и жалобу, если перерасчёт не сделают.',
      buttons: [[cb('Сегодня', `subd:${pid}:0`), cb('Вчера', `subd:${pid}:1`)], [cb('Другой день', `subd:${pid}:m`)], [cb('📋 К делу', `cs:${pid}`)]],
    });
  }

  private async onSubmittedButton(userId: number, pid: number, code: string) {
    const c = this.ownCase(userId, pid);
    if (!c || c.p.status !== 'claim_ready') return c ? this.showCase(userId, pid) : this.stale(userId);
    if (code === 'm') {
      this.db.setState(userId, 'await_submitted_date', { pid });
      return this.send(userId, { text: 'Напишите дату подачи, например 21.10.', buttons: [[cb('📋 К делу', `cs:${pid}`)]] });
    }
    const lp = localParts(new Date(this.now().getTime() - (code === '1' ? 24 : 0) * MS_HOUR), c.house.tz);
    return this.askIncoming(userId, c, fromLocal(lp.year, lp.month, lp.day, 12, 0, c.house.tz));
  }

  private async onSubmittedDate(userId: number, text: string, pid: number) {
    const c = this.ownCase(userId, pid);
    if (!c || c.p.status !== 'claim_ready') return this.stale(userId);
    const m = /^\s*(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s*$/.exec(text);
    const today = localParts(this.now(), c.house.tz);
    if (!m) return this.send(userId, { text: 'Дата в виде 21.10 или 21.10.2026.', buttons: [[cb('📋 К делу', `cs:${pid}`)]] });
    let y = m[3] ? Number(m[3]) : today.year;
    if (y < 100) y += 2000;
    const date = fromLocal(y, Number(m[2]), Number(m[1]), 12, 0, c.house.tz);
    const check = localParts(date, c.house.tz);
    if (check.day !== Number(m[1]) || check.month !== Number(m[2])) return this.send(userId, { text: 'Такой даты нет в календаре. Проверьте число и месяц.' });
    return this.askIncoming(userId, c, date);
  }

  /** Дата подачи принята — спрашиваем входящий номер (необязательно). */
  private askIncoming(userId: number, c: CaseBundle, date: Date) {
    const problem = this.submittedProblem(c, date);
    if (problem) return this.send(userId, { text: problem, buttons: [[cb('Другой день', `subd:${c.p.id}:m`)], [cb('📋 К делу', `cs:${c.p.id}`)]] });
    this.db.setState(userId, 'await_incoming', { pid: c.p.id, at: date.toISOString() });
    return this.send(userId, {
      text: 'Входящий номер дали? Его пишут на вашем экземпляре вместе с отметкой о приёме. Напишите номер или нажмите «Номера нет».',
      buttons: [[cb('Номера нет', `subn:${c.p.id}`)]],
    });
  }

  /** Подать заявление раньше, чем оно датировано, или в будущем нельзя. */
  private submittedProblem(c: CaseBundle, date: Date): string | null {
    const day = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: c.house.tz });
    if (day(date) > day(this.now())) return 'Эта дата ещё не наступила.';
    const created = claimOf(c.p).createdAt;
    if (created && day(date) < day(new Date(created))) return `Заявление датировано ${formatDate(new Date(created), c.house.tz)}. Его нельзя подать раньше этой даты.`;
    return null;
  }

  private async saveSubmitted(userId: number, pid: number, at: string, number: string | null) {
    const c = this.ownCase(userId, pid);
    if (!c || c.p.status !== 'claim_ready') return this.stale(userId);
    const incoming = number ? clean(number).replace(/^\s*(вх\.?\s*)?№\s*/i, '').slice(0, 40) || undefined : undefined;
    this.db.updateParticipant(pid, { claim: JSON.stringify({ ...claimOf(c.p), submittedAt: at, incomingNumber: incoming }) });
    this.db.setState(userId, 'idle');
    this.db.track(userId, 'claim_submitted', { pid });
    this.afterSubmitted(pid);
    const [y, mo] = monthKey(new Date(at), c.house.tz).split('-').map(Number);
    const next = `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}`;
    return this.send(userId, {
      text: `✅ Подача заявления зафиксирована: ${formatDate(new Date(at), c.house.tz)}${incoming ? `, входящий № ${incoming}` : ''}. Проверьте квитанцию в начале ${monthGenitive(next)}.`,
      buttons: [[cb('📋 К делу', `cs:${pid}`), cb('⬅️ Меню', 'menu')]],
    });
  }

  // =====================================================================
  // Мои случаи
  // =====================================================================

  private async showCases(userId: number) {
    this.db.setState(userId, 'idle');
    const list = this.db.listUserParticipants(userId).slice(0, 10);
    if (!list.length) {
      return this.send(userId, { text: 'Дел пока нет. Чтобы зафиксировать нарушение, выберите «Сообщить о проблеме».', buttons: this.menu() });
    }
    const rows: Btn[][] = list.map((p) => {
      const c = loadCase(this.db, p.id)!;
      const norm = this.norms.services[c.incident.service_key];
      return [cb(`${ICON[c.incident.service_key]} ${norm.button}, ${formatShort(new Date(p.started_at), c.house.tz).split(' ')[0]}: ${statusTitle(p.status, norm.kind, c.incident.service_key).toLowerCase()}`.slice(0, 64), `cs:${p.id}`)];
    });
    if (this.cfg.miniAppEnabled) rows.push([app('📱 Открыть в приложении')]);
    rows.push(backRow());
    const refunded = list.reduce((s, p) => s + (p.status === 'refunded' && p.refund_amount ? p.refund_amount : 0), 0);
    return this.send(userId, {
      text: `**Мои дела**${refunded > 0 ? `\nВернули с ботом: ${fmtRub(Math.round(refunded * 100) / 100)}` : ''}`,
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
    const est = estimate(calc, billsOf(c.p), claimOf(c.p));
    const lines = [
      `${ICON[c.incident.service_key]} **${norm.title}**`,
      c.house.address,
      `с ${formatShort(new Date(c.p.started_at), tz)}${c.p.ended_at ? ` по ${formatShort(new Date(c.p.ended_at), tz)}` : ''}`,
      `Статус: ${statusTitle(c.p.status, norm.kind, c.incident.service_key)}`,
    ];
    if (est.sum > 0) lines.push(`Расчёт: ≈ ${fmtRub(est.sum)}`);
    if (c.p.refund_amount) lines.push(`Вернули: ${fmtRub(c.p.refund_amount)}`);
    const photos = this.db.listPhotos(pid).length;
    if (photos) lines.push(`Фото к делу: ${photos}`);
    const dispatch = this.db.dispatchFor(c.incident.id);
    if (dispatch) lines.push(dispatchLine(dispatch, tz));
    const rows: Btn[][] = [];
    if (c.p.status === 'ended') rows.push([cb('▶️ Продолжить расчёт', `calc:${pid}`)]);
    if (c.p.status === 'claim_ready' || c.p.status === 'refused' || c.p.status === 'refunded') rows.push([cb('📄 Прислать заявление ещё раз', `doc:${pid}`)]);
    const cl = claimOf(c.p);
    const scan = this.db.getSignedScan(pid);
    const scanReady = !!scan?.storage_name && !scan.sent_at && scan.issued_snapshot === cl.issuedSnapshot;
    if (cl.emailedAt) lines.push(`📧 Отправлено на почту УК ${formatShort(new Date(cl.emailedAt), tz)}.`);
    else if (scanReady && canEmailClaim(this, c) && c.p.status === 'claim_ready') rows.push([cb('📧 Отправить в УК на почту', `mail:${pid}`)]);
    else if (c.p.status === 'claim_ready' && !c.incident.demo) rows.push([cb('📎 Прислать подписанный скан', `scan:${pid}`)]);
    if (cl.submittedAt && !cl.emailedAt) lines.push(`Подано ${formatDate(new Date(cl.submittedAt), tz)}${cl.incomingNumber ? `, вх. № ${clean(cl.incomingNumber)}` : ''}.`);
    // «Не сделали» — только после подачи: от неё считаются сроки, дата нужна в требовании.
    if (c.p.status === 'claim_ready' && !cl.submittedAt) rows.push([cb('✅ Заявление подано', `sub:${pid}`)], [cb('✅ Перерасчёт получен', `rc:${pid}:y`)]);
    else if (c.p.status === 'claim_ready') rows.push([cb('✅ Перерасчёт получен', `rc:${pid}:y`), cb('❌ Перерасчёт не выполнен', `rc:${pid}:n`)]);
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
    this.removeSignedScan(pid);
    this.db.deleteParticipant(pid);
    return this.send(userId, { text: 'Случай удалён.', buttons: this.menu() });
  }

  // =====================================================================
  // Демо: сценарий за 2 минуты для проверки жюри
  // =====================================================================

  /** Два демо-случая: номер заявки есть — и номера нет (не дозвонились, доказываем актом). */
  private askDemo(userId: number) {
    return this.send(userId, {
      text: [
        '🧪 **Демо на тестовых данных.** Какой случай показать?',
        '1. Обращение в аварийную службу зарегистрировано, номер заявки получен.',
        '2. Связаться с аварийной службой не удалось, номера заявки нет. Для подтверждения нарушения используется акт с соседями.',
      ].join('\n'),
      buttons: [[cb('📞 1. Есть номер заявки', 'demo:ads')], [cb('📵 2. Не дозвонились', 'demo:act')], [cb('🔄 Все демо-дела заново', 'demo:reset')], [cb('⬅️ Меню', 'menu')]],
    });
  }

  /** Все демо-дела заново: прежние демо удаляются, создаются демо 1, 2 и 3. Настоящие дела не трогаются. */
  async restartDemo(userId: number) {
    const n = await resetDemoCases(this.db, userId, this.now());
    this.db.track(userId, 'demo_reset');
    return this.send(userId, {
      text: `🧪 Создано демо-дел: ${n}. Демо 1 содержит номер заявки, демо 2 содержит акт с соседями, демо 3 показывает неполный перерасчёт. Ваши реальные дела не изменены.`,
      buttons: [[cb('📋 Мои дела', 'cases')], [cb('⬅️ Меню', 'menu')]],
    });
  }

  private async startDemo(userId: number, kind: 'ads' | 'act') {
    const now = this.now();
    // Демо-дом не попадает в «Мои адреса» и не меняет настоящий адрес жителя.
    const house = this.db.upsertHouse('ДЕМО: ул. Примерная, 5', this.cfg.defaultTz, 1);
    const ads = kind === 'ads';
    const started = new Date(now.getTime() - (ads ? 72 : 50) * MS_HOUR);
    const demoNo = `ДЕМО-${4512 + this.db.listUserParticipants(userId).filter((p) => this.db.getIncident(p.incident_id)?.demo).length}`;
    const incident = this.db.createIncident({
      house_id: house.id,
      // Разные услуги: два демо в одном месяце не складываются в один расчёт.
      service_key: ads ? 'hot_water_off' : 'cold_water_off',
      reporter_user_id: userId,
      started_at: started.toISOString(),
      ads_number: ads ? demoNo : null,
      evidence: ads ? 'ads' : 'self',
      variant: null,
      demo: 1,
    });
    const p = this.db.addParticipant({ incident_id: incident.id, user_id: userId, role: 'reporter', started_at: started.toISOString() });
    this.db.track(userId, 'demo_started', { kind });
    await this.send(userId, {
      text: ads
        ? `🧪 **Демо 1: есть номер заявки**. Используются тестовые данные. Три дня назад было отключено горячее водоснабжение. Обращение в аварийную службу зарегистрировано под № ${demoNo}. Выберите «Водоснабжение восстановлено», затем «Только что» и укажите 1200, чтобы перейти к заявлению.`
        : [
            '🧪 **Демо 2: номера заявки нет** (данные тестовые). Позавчера пропала холодная вода, в аварийную службу не дозвонились.',
            'При отсутствии номера заявки нарушение подтверждается актом, который подписывают соседи согласно п. 110(1) ПП № 354.',
            '1) Выберите «📄 Акт с соседями». Ваши данные будут внесены в акт, два демонстрационных соседа подтвердят его.',
            '2) «✅ Акт подписан».',
            '3) Выберите «Водоснабжение восстановлено» и укажите 600. Акт будет приложен к заявлению.',
          ].join('\n'),
    });
    return this.sendTracking(userId, p.id, false);
  }

  // =====================================================================
  // Групповой (домовой) чат
  // =====================================================================

  private groupIntro(): OutMessage {
    return {
      text: [
        'Здравствуйте. **«Вернём»** помогает подготовить обращение о нарушении предоставления коммунальных услуг и рассчитать снижение платы по ПП РФ № 354.',
        'При отключении коммунальной услуги напишите в личные сообщения. Сервис поможет зафиксировать нарушение, выполнить расчёт и подготовить заявление.',
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
    const houses = this.db.getUser(userId) ? this.db.listUserHouses(userId) : [];
    if (!houses.length) {
      return this.out.toChat(chatId, {
        text: 'Сначала напишите боту в личные сообщения и укажите адрес дома. После этого чат можно будет привязать к дому.',
        buttons: [[link('💬 Написать боту', `https://max.ru/${this.cfg.botUsername}`)]],
      });
    }
    if (houses.length === 1) return this.linkHouseChat(chatId, houses[0].id, userId);
    // Адресов несколько — не угадываем: иначе карточки одного дома уходили бы в чат другого.
    const title = this.db.getChat(chatId)?.title;
    await this.safeSend(userId, {
      text: `К какому дому привязать чат${title ? ` «${clean(title)}»` : ''}? Туда будут уходить карточки отключений только этого дома.`,
      buttons: houses.map((h) => [cb(`🏠 ${h.address}`.slice(0, 64), `dom:${chatId}:${h.id}`)]),
    });
    return this.out.toChat(chatId, { text: 'У вас несколько адресов. Выберите дом в личных сообщениях с ботом.' });
  }

  private linkHouseChat(chatId: number, houseId: number, userId: number) {
    const house = this.db.getHouse(houseId)!;
    this.db.linkChat(chatId, house.id, userId);
    this.db.updateUser(userId, { house_chat_id: chatId });
    return this.out.toChat(chatId, { text: `Чат привязан к дому: ${house.address}. Кнопка «Позвать соседей» будет публиковать карточки отключений этого дома сюда.` });
  }

  /** Житель выбрал в личных сообщениях, к какому из своих домов привязать групповой чат. */
  private async onDomChoice(userId: number, chatId: number, houseId: number) {
    const h = this.db.getUserHouse(userId, houseId);
    if (!h || h.demo || !this.db.getChat(chatId)) return this.stale(userId);
    try {
      await this.linkHouseChat(chatId, houseId, userId);
    } catch (e) {
      console.error('[bot] чат недоступен', e);
      this.db.unlinkChat(chatId);
      return this.send(userId, { text: 'Не получилось написать в этот чат: похоже, бота из него удалили.' });
    }
    return this.send(userId, { text: `Готово: чат привязан к дому ${h.address}.`, buttons: this.menu() });
  }
}
