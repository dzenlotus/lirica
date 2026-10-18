export interface StressEdit { from: number; to: number; text: string; caret: number }

export function createStressEdit(text: string, from: number, to: number): StressEdit | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > text.length) return null;
  for (const match of text.matchAll(/[аеёиоуыэюя]\p{M}*/giu)) {
    const start = match.index;
    const end = start + match[0].length;
    const targeted = from === to ? start <= from && from <= end : from === start && to > start && to <= end;
    if (!targeted) continue;
    const vowel = match[0][0];
    const marks = match[0].slice(1);
    const accented = marks.includes('\u0301');
    const inherentStress = /ё/i.test(vowel) || (/е/i.test(vowel) && marks.includes('\u0308'));
    if (inherentStress && !accented) return null;
    const replacement = accented ? vowel + marks.replaceAll('\u0301', '') : vowel + '\u0301' + marks;
    return { from: start, to: end, text: replacement, caret: start + replacement.length };
  }
  return null;
}
