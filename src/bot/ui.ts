import type { Btn } from './types.ts';
import type { Norms, ServiceKey } from '../calc/norms.ts';
import { SERVICE_ORDER } from '../calc/norms.ts';

export const cb = (text: string, payload: string): Btn => ({ type: 'callback', text, payload });
export const link = (text: string, url: string): Btn => ({ type: 'link', text, url });
export const app = (text: string, payload?: string): Btn => ({ type: 'app', text, payload });

export const ICON: Record<ServiceKey, string> = {
  hot_water_off: '🚿',
  hot_water_temp: '🌡',
  heating_temp: '🥶',
  heating_off: '❄️',
  cold_water_off: '🚰',
  electricity_off: '💡',
  gas_off: '🔥',
  sewerage_off: '🚽',
  waste_off: '🗑',
};

/** Убирает символы разметки из пользовательского текста, чтобы не сломать markdown. */
export function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/[*_`[\]~]/g, '').trim();
}

export function mainMenu(opts: { demo: boolean; app: boolean }): Btn[][] {
  const rows: Btn[][] = [[cb('🚨 Что-то сломалось', 'new')], [cb('📋 Мои дела', 'cases'), cb('🏠 Мои адреса', 'house')]];
  if (opts.app) rows.push([app('📱 Открыть приложение')]);
  rows.push(opts.demo ? [cb('❓ Как это работает', 'how'), cb('🧪 Демо', 'demo')] : [cb('❓ Как это работает', 'how')]);
  return rows;
}

export function serviceMenu(norms: Norms): Btn[][] {
  const rows: Btn[][] = [];
  const keys = SERVICE_ORDER;
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(keys.slice(i, i + 2).map((k) => cb(`${ICON[k]} ${norms.services[k].button}`, `svc:${k}`)));
  }
  rows.push([cb('⬅️ В начало', 'menu')]);
  return rows;
}

export const backRow = (): Btn[] => [cb('⬅️ Меню', 'menu')];

export function timeButtons(prefix: string, labels: 'start' | 'end'): Btn[][] {
  return [
    [cb(labels === 'start' ? 'Только что' : 'Только что', `${prefix}:now`), cb('30 мин назад', `${prefix}:m30`)],
    [cb('1 ч назад', `${prefix}:h1`), cb('3 ч назад', `${prefix}:h3`)],
    [cb('✏️ Ввести время', `${prefix}:manual`)],
  ];
}

export function relativeTime(code: string, now: Date): Date | null {
  const map: Record<string, number> = { now: 0, m30: 30, h1: 60, h3: 180 };
  if (!(code in map)) return null;
  return new Date(now.getTime() - map[code] * 60_000);
}

export const TIME_HINT = 'Напишите время, например: 08:10, «вчера 23:00» или «21.09 18:30».';

export function howItWorks(norms: Norms): string {
  return [
    '**Как это работает**',
    '1. 📞 Звоните в аварийную службу, записываете номер заявки — я подскажу, что сказать.',
    '2. 👥 Я сам спрашиваю соседей «у вас тоже?». Не дозвонились — сделаю акт: соседи подпишут, что воды не было.',
    '3. ✅ Дали воду или тепло — нажимаете кнопку, я считаю деньги по ПП № 354.',
    '4. 💰 Присылаю заявление на перерасчёт в PDF (акт — в приложениях) — отдаёте его в УК или через «Госуслуги Дом».',
    '5. 🧾 Через месяц проверяем квитанцию. Нет перерасчёта — готовлю требование о штрафе 50% и жалобу в ГЖИ.',
    '',
    `Я не юрист, итог перерасчёта считает УК. Нормы проверены ${norms.source.checked_at.split('-').reverse().join('.')}.`,
  ].join('\n');
}

/** Акт и заявление — в двух строках. Показываем там, где житель выбирает, что делать. */
export const ACT_VS_CLAIM = [
  '📄 **Акт** — доказательство. Соседи подписывают: «воды не было с 8:10».',
  '💰 **Заявление** — требование вернуть деньги. Подписываете вы, акт прикладываете.',
].join('\n');

export const SEND_HOWTO = [
  '**Как подать** (любой способ):',
  '• лично в УК — два экземпляра, на своём попросите отметку о приёме;',
  '• в «Госуслуги Дом» или ГИС ЖКХ — обращение в УК, PDF во вложении;',
  '• на почту УК из квитанции.',
  'Через месяц спрошу, пришёл ли перерасчёт.',
].join('\n');

export function actTemplate(serviceTitle: string, address: string): string {
  return [
    '**Шаблон акта (п. 110(1) ПП РФ № 354)**',
    'Составьте, если не удалось дозвониться в АДС или исполнитель не пришёл на проверку в течение 2 часов. Нужны подписи не менее 2 жителей и председателя совета дома (ТСЖ).',
    '',
    'АКТ о нарушении качества (непредоставлении) коммунальной услуги',
    `Адрес: ${address}`,
    'Дата и время составления: «__» ________ 20__ г. __:__',
    'Мы, нижеподписавшиеся: 1) __________, кв. __; 2) __________, кв. __; председатель совета МКД __________,',
    `составили акт о том, что с __:__ «__» ________ 20__ г. коммунальная услуга «${serviceTitle}» не предоставляется / предоставляется ненадлежащего качества: __________.`,
    'Уведомить аварийно-диспетчерскую службу исполнителя не удалось: __________ (причина).',
    'Подписи: __________',
  ].join('\n');
}
