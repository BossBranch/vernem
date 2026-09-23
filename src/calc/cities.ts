// Города для выбора адреса. Город нужен по двум причинам:
// 1) «Садовая, 10» есть во многих городах — без города соседи из разных городов попали бы в один дом;
// 2) часовой пояс дома: от него зависят ночные часы, расчётный месяц и время в документах.
// Неизвестный город допускается (пояс — по умолчанию). В продакшене город и дом берутся из ФИАС.

export type City = { name: string; tz: string };

export const CITIES: City[] = [
  { name: 'Москва', tz: 'Europe/Moscow' },
  { name: 'Санкт-Петербург', tz: 'Europe/Moscow' },
  { name: 'Казань', tz: 'Europe/Moscow' },
  { name: 'Новосибирск', tz: 'Asia/Novosibirsk' },
  { name: 'Екатеринбург', tz: 'Asia/Yekaterinburg' },
  { name: 'Нижний Новгород', tz: 'Europe/Moscow' },
  { name: 'Челябинск', tz: 'Asia/Yekaterinburg' },
  { name: 'Красноярск', tz: 'Asia/Krasnoyarsk' },
  { name: 'Самара', tz: 'Europe/Samara' },
  { name: 'Уфа', tz: 'Asia/Yekaterinburg' },
  { name: 'Ростов-на-Дону', tz: 'Europe/Moscow' },
  { name: 'Омск', tz: 'Asia/Omsk' },
  { name: 'Краснодар', tz: 'Europe/Moscow' },
  { name: 'Воронеж', tz: 'Europe/Moscow' },
  { name: 'Пермь', tz: 'Asia/Yekaterinburg' },
  { name: 'Волгоград', tz: 'Europe/Volgograd' },
  { name: 'Саратов', tz: 'Europe/Saratov' },
  { name: 'Тюмень', tz: 'Asia/Yekaterinburg' },
  { name: 'Ижевск', tz: 'Europe/Samara' },
  { name: 'Барнаул', tz: 'Asia/Barnaul' },
  { name: 'Ульяновск', tz: 'Europe/Ulyanovsk' },
  { name: 'Иркутск', tz: 'Asia/Irkutsk' },
  { name: 'Хабаровск', tz: 'Asia/Vladivostok' },
  { name: 'Владивосток', tz: 'Asia/Vladivostok' },
  { name: 'Ярославль', tz: 'Europe/Moscow' },
  { name: 'Томск', tz: 'Asia/Tomsk' },
  { name: 'Кемерово', tz: 'Asia/Novokuznetsk' },
  { name: 'Астрахань', tz: 'Europe/Astrakhan' },
  { name: 'Калининград', tz: 'Europe/Kaliningrad' },
  { name: 'Якутск', tz: 'Asia/Yakutsk' },
  { name: 'Мурманск', tz: 'Europe/Moscow' },
  { name: 'Архангельск', tz: 'Europe/Moscow' },
];

/** Для кнопок: самые частые города. */
export const POPULAR_CITIES = ['Москва', 'Санкт-Петербург', 'Казань'];

/** «г. Москва», «город москва», «МОСКВА» → «москва». */
export function normalizeCity(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/["«»]/g, ' ')
    .replace(/^\s*(город|г\.?|гор\.?)\s+/u, '')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Город из справочника или введённый жителем (с заглавной буквы) и его часовой пояс. */
export function resolveCity(text: string, defaultTz: string): City | null {
  const norm = normalizeCity(text);
  if (norm.length < 2 || norm.length > 60 || /\d/.test(norm)) return null;
  const known = CITIES.find((c) => normalizeCity(c.name) === norm);
  if (known) return known;
  const name = norm.replace(/(^|[\s-])([а-яa-z])/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
  return { name, tz: defaultTz };
}
