import type { Meter } from '../types.ts';

// Accents follow a natural verse reading, including the traditional «и́з лесу».
// They mark spoken stress, so a metrical strong position may remain unstressed.
export const METER_EXAMPLES: Record<Meter, {
  text: string;
  accentedText: string;
  author: string;
  title: string;
  feet: number | null;
  source: string;
  pattern?: string;
}> = {
  free: {
    text: 'Она пришла с мороза,\nРаскрасневшаяся,',
    accentedText: 'Она́ пришла́ с моро́за,\nРаскрасне́вшаяся,',
    author: 'Александр Блок',
    title: 'Она пришла с мороза…',
    feet: null,
    source: 'https://www.culture.ru/poems/2663/ona-prishla-s-moroza',
  },
  iamb: {
    text: 'Мороз и солнце; день чудесный!\nЕще ты дремлешь, друг прелестный —',
    accentedText: 'Моро́з и со́лнце; де́нь чуде́сный!\nЕще́ ты дре́млешь, дру́г преле́стный —',
    author: 'Александр Пушкин',
    title: 'Зимнее утро',
    feet: 4,
    source: 'https://www.culture.ru/poems/5363/zimnee-utro',
  },
  trochee: {
    text: 'Буря мглою небо кроет,\nВихри снежные крутя;',
    accentedText: 'Бу́ря мгло́ю не́бо кро́ет,\nВи́хри сне́жные крутя́;',
    author: 'Александр Пушкин',
    title: 'Зимний вечер',
    feet: 4,
    source: 'https://www.culture.ru/poems/5364/zimnii-vecher',
  },
  dactyl: {
    text: 'Тучки небесные, вечные странники!\nСтепью лазурною, цепью жемчужною',
    accentedText: 'Ту́чки небе́сные, ве́чные стра́нники!\nСте́пью лазу́рною, це́пью жемчу́жною',
    author: 'Михаил Лермонтов',
    title: 'Тучи',
    feet: 4,
    source: 'https://www.culture.ru/poems/36606/tuchi',
  },
  amphibrach: {
    text: 'Однажды, в студеную зимнюю пору\nЯ из лесу вышел; был сильный мороз.',
    accentedText: 'Одна́жды, в студе́ную зи́мнюю по́ру\nЯ и́з лесу вы́шел; был си́льный моро́з.',
    author: 'Николай Некрасов',
    title: 'Крестьянские дети',
    feet: 4,
    source: 'https://www.culture.ru/poems/40019/odnazhdy-v-studenuyu-zimnyuyu-poru-otryvok-iz-stikhotvoreniya-krestyanskie-deti',
  },
  anapest: {
    text: 'Что ты жадно глядишь на дорогу\nВ стороне от веселых подруг?',
    accentedText: 'Что ты жа́дно гляди́шь на доро́гу\nВ стороне́ от весе́лых подру́г?',
    author: 'Николай Некрасов',
    title: 'Тройка',
    feet: 3,
    source: 'https://www.culture.ru/poems/39562/troika',
  },
};
