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

/** Как города называют в разговоре. */
const ALIASES: Record<string, string> = {
  'мск': 'Москва',
  'спб': 'Санкт-Петербург',
  'питер': 'Санкт-Петербург',
  'петербург': 'Санкт-Петербург',
  'ленинград': 'Санкт-Петербург',
  'с-петербург': 'Санкт-Петербург',
  'санкт петербург': 'Санкт-Петербург',
  'екб': 'Екатеринбург',
  'нн': 'Нижний Новгород',
  'нижний': 'Нижний Новгород',
  'нск': 'Новосибирск',
  'ростов': 'Ростов-на-Дону',
  'ростов на дону': 'Ростов-на-Дону',
};

/** Расстояние Левенштейна — чтобы «Масква» узнавалась как «Москва». */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** Город из справочника, похожий на введённый: сокращение («Питер») или опечатка («Масква»). */
export function suggestCity(text: string): City | null {
  const norm = normalizeCity(text);
  if (norm.length < 2) return null;
  const alias = ALIASES[norm];
  if (alias) return CITIES.find((c) => c.name === alias) ?? null;
  if (norm.length < 4) return null;
  let best: City | null = null;
  let bestD = Infinity;
  for (const c of CITIES) {
    const d = distance(norm, normalizeCity(c.name));
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best && bestD > 0 && bestD <= (norm.length >= 7 ? 2 : 1) ? best : null;
}

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
  const known = CITIES.find((c) => normalizeCity(c.name) === norm) ?? (ALIASES[norm] ? CITIES.find((c) => c.name === ALIASES[norm]) : undefined);
  if (known) return known;
  // «Сам», «Мо» — недописанное название, а не новый город. Короткие настоящие («Уфа») есть в справочнике.
  if (norm.replace(/[^а-яa-z]/g, '').length < 4) return null;
  const name = norm.replace(/(^|[\s-])([а-яa-z])/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
  return { name, tz: defaultTz };
}
