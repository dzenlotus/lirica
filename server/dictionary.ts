import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { stripAcutes } from '../src/lib/prosody.ts';
import { ApiError } from './generation.ts';

export const DICTIONARY_REVISION = 'b78ae5ea1e62beaf138bed1865cd8c3b0b5ca855';
export interface StressDictionary {
  accents: Record<string, string>;
  omographs: Record<string, string[]>;
  yoWords: Record<string, string>;
  yoHomographs: Record<string, string>;
}
export interface DictionaryReading { choices: number[]; ambiguous: boolean }
const unzip = promisify(gunzip);
const vowels = /[аеёиоуыэюя]/u;
let loading: Promise<StressDictionary> | undefined;

async function readDictionary(name: string, sha256: string, maxOutputLength: number): Promise<unknown> {
  const bytes = await readFile(new URL(`./data/ruaccent/${name}`, import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Dictionary checksum mismatch');
  const value: unknown = JSON.parse((await unzip(bytes, { maxOutputLength })).toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid dictionary');
  return value;
}

export function loadStressDictionary(): Promise<StressDictionary> {
  loading ??= Promise.all([
    readDictionary('accents.json.gz', 'aa460ebba90de00fbbf3d41d121961f605b98667e45efb7920f127473b15515e', 180_000_000),
    readDictionary('omographs.json.gz', '04a9e81c68d65f65ba493fe0110f99e79087548c2beeec3032e2b66e28706f36', 2_000_000),
    readDictionary('yo_words.json.gz', 'a19fa89a964a0691d9fe4ee384783e3934904891843d8f59a1c480d67947a82a', 5_000_000),
    readDictionary('yo_homographs.json.gz', 'c4ee777bbbab87f9eac838f370ad92974e079d02b21903e480c54b5f0c8c60d1', 1_000_000),
  ]).then(([accents, omographs, yoWords, yoHomographs]) => ({ accents, omographs, yoWords, yoHomographs }) as StressDictionary).catch(() => {
    loading = undefined;
    throw new ApiError(503, 'DICTIONARY_UNAVAILABLE', 'Словарь ударений недоступен или повреждён. Проверьте файлы сервера Лирики.');
  });
  return loading;
}

function normalized(word: string): string { return stripAcutes(word).normalize('NFC').toLocaleLowerCase('ru').replace(/[‐‑]/gu, '-'); }
function stressVowel(word: string, accented: unknown): number | null {
  if (typeof accented !== 'string' || normalized(accented.replaceAll('+', '')).replaceAll('ё', 'е') !== word.replaceAll('ё', 'е')) return null;
  let index = 0;
  let result: number | null = null;
  for (let position = 0; position < accented.length; position++) {
    if (accented[position] === '+') {
      if (result !== null || !vowels.test(accented[position + 1] ?? '')) return null;
      result = index;
    } else if (vowels.test(accented[position]!)) index++;
  }
  return result;
}

export function dictionaryReading(word: string, dictionary: StressDictionary): DictionaryReading {
  const original = normalized(word);
  const restored = dictionary.yoWords[original];
  const key = typeof restored === 'string' ? restored : original;
  const homographs = dictionary.omographs[key] ?? dictionary.omographs[original];
  const values: unknown[] = Array.isArray(homographs) ? [...homographs] : [dictionary.accents[key] ?? dictionary.accents[original]];
  const yoAlternative = dictionary.yoHomographs[original];
  if (typeof yoAlternative === 'string') values.push(...(dictionary.omographs[yoAlternative] ?? [dictionary.accents[yoAlternative]]));
  const choices = [...new Set(values.map(value => stressVowel(key, value)).filter((value): value is number => value !== null))].sort((a, b) => a - b);
  // A one-alternative homograph record is incomplete, rather than evidence of certainty.
  return { choices, ambiguous: choices.length > 1 || (Array.isArray(homographs) && homographs.length < 2) };
}
