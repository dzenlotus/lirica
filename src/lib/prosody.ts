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
type Issue = { start: number; end: number; kind: 'stress' | 'extra' | 'short'; message: string };

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

const PATTERNS: Record<Exclude<Meter, 'free'>, readonly number[]> = {
  iamb: [0, 1], trochee: [1, 0], dactyl: [1, 0, 0], amphibrach: [0, 1, 0], anapest: [0, 0, 1],
};
const graphemes = new Intl.Segmenter('ru', { granularity: 'grapheme' });

export function analyzeLineProsody(text: string, analysis: LineProsody | undefined, meter: Meter, feet: number): {
  text: string;
  stresses: Stress[];
  issues: Issue[];
  unknown: Array<{ start: number; end: number }>;
  syllables: number;
  expected: number | null;
  complete: boolean;
} {
  const words = tokenizeWords(text);
  const vowels = [...text.matchAll(/[аеёиоуыэюя]\p{M}*/giu)];
  const stresses: Stress[] = [];
  const issues: Issue[] = [];
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
    for (const stress of stresses) {
      const word = words.find(word => word.start <= stress.start && stress.start < word.end)!;
      // Monosyllables may lose/gain phrase stress; only an explicit author accent is decisive.
      if (word.vowels.length === 1 && !text.slice(stress.start, stress.end).includes(ACUTE)) continue;
      const syllable = vowels.findIndex(vowel => vowel.index === stress.start);
      if (syllable > lastStrong || pattern[syllable % pattern.length] === 0) {
        issues.push({ start: stress.start, end: stress.end, kind: 'stress', message: 'Ударение попадает на слабую долю выбранного размера.' });
      }
    }
    // Missing ictus stresses (pyrrhics) are normal; endings may trail the last ictus by 0–2 syllables.
    if (vowels.length > maximum) {
      issues.push({ start: vowels[maximum].index, end: text.trimEnd().length, kind: 'extra', message: `Лишние слоги: в строке ${vowels.length}, допустимо ${minimum}–${maximum}.` });
    } else if (vowels.length < minimum) {
      const trimmed = text.trimEnd();
      const last = [...graphemes.segment(trimmed)].at(-1)!;
      issues.push({ start: last.index, end: trimmed.length, kind: 'short', message: `В строке ${vowels.length} слогов; минимум для ${safeFeet} стоп — ${minimum}.` });
    }
  }
  return { text, stresses, issues, unknown, syllables: vowels.length, expected, complete };
}

/** Export-only projection; the editor's saved source stays unchanged. */
export function applyAutomaticStresses(text: string, analysis: LineProsody | undefined): string {
  const automatic = analyzeLineProsody(text, analysis, 'free', 1).stresses.filter(stress => stress.source === 'auto');
  let result = text;
  for (const stress of automatic.reverse()) result = result.slice(0, stress.start + 1) + ACUTE + result.slice(stress.start + 1);
  return result;
}
