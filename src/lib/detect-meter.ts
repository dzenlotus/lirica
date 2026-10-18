import type { Meter } from '../types.ts';
import { analyzeLineProsody, tokenizeWords, type LineProsody } from './prosody.ts';

type RegularMeter = Exclude<Meter, 'free'>;
type Candidate = { meter: RegularMeter; feet: number };
export type MeterDetectionStatus = 'detected' | 'ambiguous' | 'insufficient' | 'mixed';
export interface LineMeterDetection {
  status: MeterDetectionStatus;
  meter: RegularMeter | null;
  feet: number | null;
}
export interface MeterDetection extends LineMeterDetection {
  /** Same indexes as the source lines; unfinished lines stay insufficient. */
  perLine: LineMeterDetection[];
  /** Nonempty lines whose complete pronunciation provides enough evidence. */
  analyzedLines: number;
  totalLines: number;
}
const GRIDS: Record<RegularMeter, { width: number; firstStrong: number }> = {
  iamb: { width: 2, firstStrong: 1 }, trochee: { width: 2, firstStrong: 0 },
  dactyl: { width: 3, firstStrong: 0 }, amphibrach: { width: 3, firstStrong: 1 }, anapest: { width: 3, firstStrong: 2 },
};
const METERS = Object.keys(GRIDS) as RegularMeter[];

function commonValue<T>(values: T[]): T | null {
  return values.length && values.every(value => value === values[0]) ? values[0] : null;
}
function summarize(candidates: Candidate[]): LineMeterDetection {
  if (!candidates.length) return { status: 'mixed', meter: null, feet: null };
  const meter = commonValue(candidates.map(candidate => candidate.meter));
  return { status: meter ? 'detected' : 'ambiguous', meter, feet: meter ? commonValue(candidates.map(candidate => candidate.feet)) : null };
}

/**
 * A conservative fit to five regular grids, never a new pronunciation.
 * Skipped ictus stresses and 0–2 trailing unstressed syllables use the existing
 * analyzer's rules. A line needs two independently stressed polysyllabic words;
 * weak monosyllables alone cannot establish its rhythm. Multiple fits stay
 * ambiguous. Unfinished/unknown lines cannot erase evidence in finished lines.
 */
export function detectMeter(lines: string[], analyses?: LineProsody[]): MeterDetection {
  const candidatesByLine: Array<Candidate[] | null> = [];
  let totalLines = 0;
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    if (text.trim()) totalLines++;
    // The Russian analyzer omits other alphabets and digits; their spoken
    // syllables are unknown. Combining accents and punctuation remain allowed.
    if (/[\p{L}\p{N}]/u.test(text.replace(/[а-яё]/giu, ''))) {
      candidatesByLine.push(null);
      continue;
    }
    const words = tokenizeWords(text);
    const free = analyzeLineProsody(text, analyses?.[index], 'free', 1);
    const reliableWords = words.filter(word => word.vowels.length > 1
      && free.stresses.filter(stress => word.start <= stress.start && stress.start < word.end).length === 1);
    if (!free.complete || reliableWords.length < 2) {
      candidatesByLine.push(null);
      continue;
    }
    const candidates: Candidate[] = [];
    for (const meter of METERS) {
      const { width, firstStrong } = GRIDS[meter];
      for (let feet = 1; feet <= 8; feet++) {
        // Reject impossible lengths before another tokenization/analyzer pass.
        const minimum = (feet - 1) * width + firstStrong + 1;
        if (free.syllables < minimum || free.syllables > minimum + 2) continue;
        if (!analyzeLineProsody(text, analyses?.[index], meter, feet).issues.length) candidates.push({ meter, feet });
      }
    }
    candidatesByLine.push(candidates);
  }
  const analyzed = candidatesByLine.filter((candidates): candidates is Candidate[] => candidates !== null);
  const perLine = candidatesByLine.map(candidates => candidates === null
    ? { status: 'insufficient' as const, meter: null, feet: null }
    : summarize(candidates));
  const counts = { analyzedLines: analyzed.length, totalLines };
  if (!analyzed.length) return { status: 'insufficient', meter: null, feet: null, perLine, ...counts };
  const commonMeters = METERS.filter(meter => analyzed.every(candidates => candidates.some(candidate => candidate.meter === meter)));
  if (!commonMeters.length) return { status: 'mixed', meter: null, feet: null, perLine, ...counts };
  if (commonMeters.length > 1) return { status: 'ambiguous', meter: null, feet: null, perLine, ...counts };
  const meter = commonMeters[0];
  const resolvedLines = candidatesByLine.map((candidates, index) => candidates === null
    ? perLine[index]
    : summarize(candidates.filter(candidate => candidate.meter === meter)));
  const feet = commonValue(resolvedLines.filter(line => line.status === 'detected').map(line => line.feet));
  return { status: 'detected', meter, feet, perLine: resolvedLines, ...counts };
}
