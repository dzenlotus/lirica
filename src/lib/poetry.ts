import type { Meter, PoetrySettings, RhymeScheme } from '../types.ts';

export function countSyllables(text: string): number {
  return (text.match(/[аеёиоуыэюя]/giu) ?? []).length;
}

export function getRhymeLabel(index: number, scheme: RhymeScheme, lines?: string[]): string | null {
  if (scheme === 'free' || !Number.isInteger(index) || index < 0) return null;
  let start = 0;
  if (lines) {
    for (let previous = index - 1; previous >= 0; previous--) {
      if (!lines[previous]?.trim()) { start = previous + 1; break; }
    }
  }
  return scheme[(index - start) % scheme.length] ?? null;
}

export function getReferenceLine(
  lines: string[], activeLine: number, settings: Pick<PoetrySettings, 'scheme' | 'referenceLine'>,
): number | null {
  const manual = settings.referenceLine;
  if (manual !== null) {
    return Number.isInteger(manual) && manual >= 0 && manual < lines.length && manual !== activeLine && lines[manual]?.trim()
      ? manual : null;
  }
  const label = getRhymeLabel(activeLine, settings.scheme, lines);
  if (label === null) return null;
  for (let index = activeLine - 1; index >= 0; index--) {
    if (!lines[index]?.trim()) break;
    if (getRhymeLabel(index, settings.scheme, lines) === label) return index;
  }
  return null;
}

export function analyzeMeter(text: string, meter: Meter, feet: number): {
  syllables: number; expected: number | null; status: 'free' | 'short' | 'long' | 'match';
} {
  const syllables = countSyllables(text);
  if (meter === 'free') return { syllables, expected: null, status: 'free' };
  // ponytail: vowel count checks length only; stress analysis needs a pronunciation dictionary.
  const expected = feet * (meter === 'iamb' || meter === 'trochee' ? 2 : 3);
  return { syllables, expected, status: syllables < expected ? 'short' : syllables > expected ? 'long' : 'match' };
}
