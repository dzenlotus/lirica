import type { Meter } from '../types.ts';

export interface ProsodyWord {
  /** All offsets point into LineProsody.text and count UTF-16 code units. */
  start: number;
  end: number;
  stress: number | null;
  status: 'known' | 'weak' | 'unknown';
}
export interface LineProsody { text: string; words: ProsodyWord[] }
export interface ProsodyResponse { lines: LineProsody[]; mode: 'ai'; model: string }

const ACUTE = '\u0301';
type WordToken = {
  index: number; text: string; start: number; end: number; vowels: number[];
};
type Stress = { start: number; end: number; source: 'manual' | 'auto' };
export interface MeterIssue {
  start: number;
  end: number;
  kind: 'stress' | 'extra' | 'short';
  message: string;
  recommendation: string;
  /** The actual pronunciation, including the author's accents when present. */
  word?: string;
  /** One-based line position; for a short line, the first missing syllable. */
  syllable: number;
  /** One-based positions where the selected meter permits stress. */
  expectedSyllables: number[];
}

export function tokenizeWords(text: string): WordToken[] {
  const words: WordToken[] = [];
  for (const match of text.matchAll(/(?<![\p{L}\p{M}])[а-яё][а-яё\p{M}]*(?:[-‐‑][а-яё][а-яё\p{M}]*)*(?![\p{L}\p{M}])/giu)) {
    const vowels = [...match[0].matchAll(/[аеёиоуыэюя]/giu)].map(vowel => match.index + vowel.index);
    if (vowels.length) words.push({ index: words.length, text: match[0], start: match.index, end: match.index + match[0].length, vowels });
  }
  return words;
}

export function stripAcutes(text: string): string { return text.replaceAll(ACUTE, ''); }

function vowelSpan(text: string, start: number): { start: number; end: number } {
  return { start, end: start + (text.slice(start).match(/^[аеёиоуыэюя]\p{M}*/iu)?.[0].length ?? 1) };
}

function hasManualStress(vowel: string): boolean {
  return vowel.includes(ACUTE) || /ё/iu.test(vowel) || (/е/iu.test(vowel) && vowel.includes('\u0308'));
}

function syllableCountLabel(count: number): string {
  return count % 10 === 1 && count % 100 !== 11 ? 'слог'
    : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'слога' : 'слогов';
}

const PATTERNS: Record<Exclude<Meter, 'free'>, readonly number[]> = {
  iamb: [0, 1], trochee: [1, 0], dactyl: [1, 0, 0], amphibrach: [0, 1, 0], anapest: [0, 0, 1],
};
const METER_LABELS: Record<Exclude<Meter, 'free'>, string> = {
  iamb: 'Ямб', trochee: 'Хорей', dactyl: 'Дактиль', amphibrach: 'Амфибрахий', anapest: 'Анапест',
};
const graphemes = new Intl.Segmenter('ru', { granularity: 'grapheme' });

export function analyzeLineProsody(text: string, analysis: LineProsody | undefined, meter: Meter, feet: number): {
  text: string;
  stresses: Stress[];
  issues: MeterIssue[];
  unknown: Array<{ start: number; end: number }>;
  syllables: number;
  expected: number | null;
  complete: boolean;
} {
  const words = tokenizeWords(text);
  const vowels = [...text.matchAll(/[аеёиоуыэюя]\p{M}*/giu)];
  const stresses: Stress[] = [];
  const issues: MeterIssue[] = [];
  const unknown: Array<{ start: number; end: number }> = [];
  const compatible = analysis && stripAcutes(analysis.text).normalize('NFC') === stripAcutes(text).normalize('NFC');
  const sourceWords = compatible ? tokenizeWords(analysis.text) : [];
  let complete = true;

  for (const word of words) {
    const manual = word.vowels.map(offset => vowelSpan(text, offset)).filter(span => hasManualStress(text.slice(span.start, span.end)));
    if (manual.length) {
      stresses.push(...manual.map(span => ({ ...span, source: 'manual' as const })));
      continue;
    }
    const sourceWord = sourceWords[word.index];
    const entry = compatible ? analysis.words[word.index] : undefined;
    const aligned = entry && sourceWord && entry.start === sourceWord.start && entry.end === sourceWord.end;
    const stressOrdinal = aligned && entry.stress !== null ? sourceWord.vowels.indexOf(entry.stress) : -1;
    // An explicit accent anywhere in the word must never be overwritten.
    if (!word.text.includes(ACUTE) && aligned) {
      if (entry.status === 'weak' && entry.stress === null) continue;
      if (entry.status === 'known' && stressOrdinal >= 0 && stressOrdinal < word.vowels.length) {
        stresses.push({ ...vowelSpan(text, word.vowels[stressOrdinal]), source: 'auto' });
        continue;
      }
    }
    complete = false;
    // Loading and stale responses do not decorate the editor as dictionary failures.
    if (compatible) unknown.push({ start: word.start, end: word.end });
  }

  const safeFeet = Math.min(8, Math.max(1, Math.trunc(feet) || 1));
  const pattern = meter === 'free' ? null : PATTERNS[meter];
  const expected = pattern ? safeFeet * pattern.length : null;
  if (pattern && text.trim()) {
    const lastStrong = (safeFeet - 1) * pattern.length + pattern.indexOf(1);
    const minimum = lastStrong + 1;
    const maximum = minimum + 2;
    const expectedSyllables = Array.from({ length: safeFeet }, (_, index) => index * pattern.length + pattern.indexOf(1) + 1);
    const meterLabel = METER_LABELS[meter as Exclude<Meter, 'free'>];
    for (const stress of stresses) {
      const word = words.find(word => word.start <= stress.start && stress.start < word.end)!;
      // Monosyllables may lose/gain phrase stress; only an explicit author accent is decisive.
      if (word.vowels.length === 1 && !text.slice(stress.start, stress.end).includes(ACUTE)) continue;
      const syllable = vowels.findIndex(vowel => vowel.index === stress.start);
      if (syllable > lastStrong || pattern[syllable % pattern.length] === 0) {
        const stressInWord = word.vowels.indexOf(stress.start) + 1;
        const relativeStress = stress.start - word.start;
        const accentedWord = hasManualStress(text.slice(stress.start, stress.end))
          ? word.text
          : word.text.slice(0, relativeStress + 1) + ACUTE + word.text.slice(relativeStress + 1);
        const firstWordSyllable = syllable - stressInWord + 2;
        const wordExpected = expectedSyllables.filter(position => position >= firstWordSyllable && position < firstWordSyllable + word.vowels.length);
        const expectedDescription = syllable > lastStrong
          ? `${meterLabel}: последнее ударение ожидается на ${minimum}-м слоге строки, а ${syllable + 1}-й слог окончания должен быть безударным.`
          : `${meterLabel} ожидает ударение ${wordExpected.length ? `на ${wordExpected.map(position => `${position}-м`).join(' или ')} слоге строки` : `на слогах ${expectedSyllables.join(', ')}`}; ${syllable + 1}-й слог должен быть безударным.`;
        const beginning = syllable === 0 && pattern.indexOf(1) > 0
          ? `Попробуйте добавить перед «${accentedWord}» ${pattern.indexOf(1) === 1 ? 'один безударный слог' : 'два безударных слога'} или переформулировать начало строки, сохранив это произношение. Затем проверьте всю строку.`
          : `Попробуйте заменить слово «${accentedWord}» или изменить порядок слов, сохранив естественное произношение. Не переносите ударение в этом слове ради размера.`;
        const manualReview = stress.source === 'manual' && text.slice(stress.start, stress.end).includes(ACUTE)
          ? 'Проверьте ручную отметку ударения по смыслу. Если она верна, '
          : '';
        issues.push({
          start: stress.start, end: stress.end, kind: 'stress', word: accentedWord,
          syllable: syllable + 1, expectedSyllables,
          message: `В слове «${accentedWord}» ударение на ${stressInWord}-м слоге слова (${syllable + 1}-й слог строки). ${expectedDescription}`,
          recommendation: manualReview + (manualReview ? beginning[0].toLocaleLowerCase('ru') + beginning.slice(1) : beginning),
        });
      }
    }
    // Missing ictus stresses (pyrrhics) are normal; endings may trail the last ictus by 0–2 syllables.
    if (vowels.length > maximum) {
      const excess = vowels.length - maximum;
      issues.push({
        start: vowels[maximum].index, end: text.trimEnd().length, kind: 'extra',
        syllable: maximum + 1, expectedSyllables,
        message: `В строке ${vowels.length} ${syllableCountLabel(vowels.length)} — на ${excess} больше допустимого. Для ${safeFeet} стоп: ${minimum}–${maximum} слогов, включая 0–2 безударных слога после последнего ударения.`,
        recommendation: `Сократите строку минимум на ${excess} ${syllableCountLabel(excess)}: уберите слово или замените оборот более коротким, сохранив смысл и естественные ударения. Допустимая длина — ${minimum}–${maximum} слогов.`,
      });
    } else if (vowels.length < minimum) {
      const trimmed = text.trimEnd();
      const last = [...graphemes.segment(trimmed)].at(-1)!;
      const deficit = minimum - vowels.length;
      issues.push({
        start: last.index, end: trimmed.length, kind: 'short',
        syllable: vowels.length + 1, expectedSyllables,
        message: `В строке ${vowels.length} ${syllableCountLabel(vowels.length)} — на ${deficit} меньше необходимого. Для ${safeFeet} стоп: ${minimum}–${maximum} слогов, включая 0–2 безударных слога после последнего ударения.`,
        recommendation: `Добавьте минимум ${deficit} ${syllableCountLabel(deficit)}: дополните мысль или замените оборот более длинным. Сохраните естественные ударения и проверьте длину ${minimum}–${maximum} слогов.`,
      });
    }
  }
  return { text, stresses, issues, unknown, syllables: vowels.length, expected, complete };
}

/** A line can suggest a different setting, but never silently change the poem's meter. */
export function suggestAlternativeMeter(text: string, analysis: LineProsody | undefined, currentMeter: Meter, feet: number): {
  meter: Exclude<Meter, 'free'>; feet: number; label: string;
} | null {
  const current = analyzeLineProsody(text, analysis, currentMeter, feet);
  if (currentMeter === 'free' || !current.complete || !current.issues.length) return null;
  const words = tokenizeWords(text);
  const reliableWords = words.filter(word => word.vowels.length > 1
    && current.stresses.filter(stress => word.start <= stress.start && stress.start < word.end).length === 1);
  if (reliableWords.length < 2) return null;
  const alternatives: Array<{ meter: Exclude<Meter, 'free'>; feet: number; label: string }> = [];
  for (const meter of Object.keys(PATTERNS) as Array<Exclude<Meter, 'free'>>) {
    if (meter === currentMeter) continue;
    for (let candidateFeet = 1; candidateFeet <= 8; candidateFeet++) {
      if (!analyzeLineProsody(text, analysis, meter, candidateFeet).issues.length) {
        alternatives.push({ meter, feet: candidateFeet, label: `${METER_LABELS[meter]}, ${candidateFeet} ${candidateFeet === 1 ? 'стопа' : candidateFeet < 5 ? 'стопы' : 'стоп'}` });
      }
    }
  }
  return alternatives.length === 1 ? alternatives[0] : null;
}

/** Export-only projection; the editor's saved source stays unchanged. */
export function applyAutomaticStresses(text: string, analysis: LineProsody | undefined): string {
  const automatic = analyzeLineProsody(text, analysis, 'free', 1).stresses.filter(stress => stress.source === 'auto');
  let result = text;
  for (const stress of automatic.reverse()) result = result.slice(0, stress.start + 1) + ACUTE + result.slice(stress.start + 1);
  return result;
}
