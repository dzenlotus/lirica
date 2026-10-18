import { analyzeLineProsody, stripAcutes, tokenizeWords, type LineProsody } from './prosody.ts';

export type RhymeStatus = 'detected' | 'partial' | 'insufficient' | 'unknown' | 'mixed';
export interface RhymeStanza {
  startLine: number;
  endLine: number;
  status: RhymeStatus;
  scheme: string | null;
  labels: Array<string | null>;
}
export interface DetectedRhyme {
  status: RhymeStatus;
  /** A completed pattern; partial trailing lines never supply a guessed pattern. */
  scheme: string | null;
  /** Original line indices; labels restart after an empty line. */
  labels: Array<string | null>;
  stanzas: RhymeStanza[];
  reason: string;
}

const vowels = /[аеёиоуыэюя]/u;
const stressedVowels: Record<string, string> = { а: 'а', о: 'о', э: 'э', е: 'э', ё: 'о', у: 'у', ю: 'у', и: 'и', ы: 'ы', я: 'а' };
const unvoiced: Record<string, string> = { б: 'п', в: 'ф', г: 'к', д: 'т', ж: 'ш', з: 'с' };

function endingKey(text: string, analysis: LineProsody | undefined): string | null {
  const lastWord = tokenizeWords(text).at(-1);
  if (!lastWord || /[\p{L}\p{N}]/u.test(text.slice(lastWord.end))) return null;
  const stresses = analyzeLineProsody(text, analysis, 'free', 1).stresses
    .filter(stress => stress.start >= lastWord.start && stress.start < lastWord.end);
  if (stresses.length !== 1) return null;
  const stress = stresses[0];
  const word = stripAcutes(lastWord.text).normalize('NFC').toLocaleLowerCase('ru');
  const before = stripAcutes(text.slice(lastWord.start, stress.start)).normalize('NFC').toLocaleLowerCase('ru');
  let tail = stripAcutes(text.slice(stress.start, lastWord.end)).normalize('NFC').toLocaleLowerCase('ru');
  // ponytail: conservative spelling-to-sound approximation; approximate/author rhymes stay uncertain.
  tail = tail.replaceAll('стн', 'сн').replaceAll('здн', 'зн').replaceAll('лнц', 'нц').replaceAll('рдц', 'рц')
    .replace(/(?:тьс|тс)/gu, 'ц').replace(/[сз]ч/gu, 'щ');
  let key = stressedVowels[tail[0]];
  for (let index = 1; index < tail.length; index++) {
    const letter = tail[index];
    if (vowels.test(letter)) {
      if (/[еёюя]/u.test(letter) && /[аеёиоуыэюяьъ]/u.test(tail[index - 1])) key += 'й';
      key += /[аоя]/u.test(letter) ? 'а' : /[еиэ]/u.test(letter) ? 'и' : stressedVowels[letter];
    } else if (/[бвгджзйклмнпрстфхцчшщ]/u.test(letter)) {
      key += letter;
      if (!/[жшцчщй]/u.test(letter) && /[ьеёиюя]/u.test(tail[index + 1] ?? '')) key += 'ь';
    }
  }
  key = key.replace(/([бвгджз])(ь?)(?=[пфктсшхцчщ]|$)/gu, (_match, consonant: string, soft: string) => unvoiced[consonant] + soft);
  // A lone final vowel needs its support consonant: крутя/дитя, but not весна/рука.
  if ([...key].length === 1) {
    const previous = before.at(-1);
    if (previous && /[бвгджзйклмнпрстфхцчшщ]/u.test(previous)) {
      key = previous + (/[еёюя]/u.test(word[before.length]) && !/[жшцчщй]/u.test(previous) ? 'ь' : '') + key;
    } else if (previous && vowels.test(previous) && /[еёюя]/u.test(word[before.length])) key = 'й' + key;
    else return null;
  }
  return key;
}

function labelKeys(keys: Array<string | null>): Array<string | null> {
  const groups = new Map<string, string>();
  return keys.map(key => {
    if (key === null) return null;
    if (!groups.has(key)) {
      const index = groups.size;
      groups.set(key, (index >= 26 ? String.fromCharCode(64 + Math.floor(index / 26)) : '') + String.fromCharCode(65 + index % 26));
    }
    return groups.get(key)!;
  });
}

function hasPair(keys: Array<string | null>): boolean {
  const known = keys.filter(key => key !== null);
  return new Set(known).size < known.length;
}

function contradictsPattern(keys: Array<string | null>, pattern: string): boolean {
  for (let start = 0; start < keys.length; start += pattern.length) {
    const block = keys.slice(start, start + pattern.length);
    for (let index = 0; index < block.length; index++) {
      for (let previous = 0; previous < index; previous++) {
        if (block[index] !== null && block[previous] !== null
          && (block[index] === block[previous]) !== (pattern[index] === pattern[previous])) return true;
      }
    }
  }
  return false;
}

function stanzaResult(keys: Array<string | null>, startLine: number): RhymeStanza {
  const pair = hasPair(keys);
  const known = keys.every(key => key !== null);
  const labels = pair ? labelKeys(keys) : keys.map(() => null);
  const blocks: string[] = [];
  for (let start = 0; start + 4 <= keys.length; start += 4) {
    const block = keys.slice(start, start + 4);
    if (block.every(key => key !== null) && hasPair(block)) blocks.push(labelKeys(block).join(''));
  }
  const repeatedBlock = blocks.length && new Set(blocks).size === 1 ? blocks[0] : null;
  let status: RhymeStatus;
  let scheme: string | null = null;
  if (keys.length < 4) status = pair ? 'partial' : 'insufficient';
  else if (known && pair) {
    status = 'detected';
    scheme = keys.length % 4 === 0 && blocks.length === keys.length / 4 && repeatedBlock
      ? repeatedBlock : labels.join('');
  } else if (pair) {
    status = repeatedBlock && contradictsPattern(keys, repeatedBlock) ? 'mixed' : 'partial';
    scheme = status === 'partial' ? repeatedBlock : null;
  } else status = 'unknown';
  return { startLine, endLine: startLine + keys.length - 1, status, scheme, labels };
}

/** Infers actual ending sounds; it does not use the author's requested rhyme setting. */
export function detectRhyme(lines: string[], analyses: LineProsody[] = []): DetectedRhyme {
  const stanzas: RhymeStanza[] = [];
  const stanzaKeys: Array<Array<string | null>> = [];
  const labels: Array<string | null> = lines.map(() => null);
  for (let start = 0; start < lines.length;) {
    if (!lines[start].trim()) { start++; continue; }
    let end = start;
    while (end < lines.length && lines[end].trim()) end++;
    const keys = lines.slice(start, end).map((line, offset) => endingKey(line, analyses[start + offset]));
    const stanza = stanzaResult(keys, start);
    stanzas.push(stanza);
    stanzaKeys.push(keys);
    labels.splice(start, end - start, ...stanza.labels);
    start = end;
  }
  const completePatterns = new Set(stanzas.map(stanza => stanza.scheme).filter(scheme => scheme !== null));
  let scheme = completePatterns.size === 1 ? [...completePatterns][0] : null;
  let status: RhymeStatus;
  if (completePatterns.size > 1 || stanzas.some(stanza => stanza.status === 'mixed')
    || (scheme?.length === 4 && stanzaKeys.some(keys => contradictsPattern(keys, scheme!)))) {
    status = 'mixed';
    scheme = null;
  }
  else if (stanzas.length && stanzas.every(stanza => stanza.status === 'detected')) status = 'detected';
  else if (scheme || stanzas.some(stanza => stanza.status === 'partial')) status = 'partial';
  else if (!stanzas.length || stanzas.every(stanza => stanza.status === 'insufficient')) status = 'insufficient';
  else status = 'unknown';
  const reason = status === 'detected' ? 'Предположительно: по звучанию окончаний от последнего ударения.'
    : status === 'partial' ? 'Есть совпадения; допишите строки или уточните ударения в окончаниях.'
    : status === 'insufficient' ? 'Для схемы нужно хотя бы четыре строки в строфе.'
    : status === 'mixed' ? 'В разных частях стиха получаются разные схемы рифмовки.'
    : 'Надёжная рифма пока не найдена. Проверьте ударения в последних словах.';
  return { status, scheme, labels, stanzas, reason };
}
