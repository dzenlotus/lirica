import type { Meter, PoetrySettings, RhymeScheme } from '../types.ts';
import { getReferenceLine } from './poetry.ts';

type DetectedMeter = { meter: Meter | null; feet: number | null; perLine: ReadonlyArray<{ feet: number | null }> };
type DetectedRhyme = { scheme: string | null; labels: ReadonlyArray<string | null> };
export function resolveAutoSettings(settings: PoetrySettings, meter: DetectedMeter, rhyme: DetectedRhyme, lines: string[], activeLine: number): PoetrySettings {
  if (!settings.autoMeter) return settings;
  const feet = meter.perLine[activeLine]?.feet ?? meter.feet;
  const scheme: RhymeScheme = ['ABAB', 'AABB', 'ABBA', 'AAAA'].includes(rhyme.scheme ?? '') ? rhyme.scheme as RhymeScheme : 'free';
  let referenceLine = getReferenceLine(lines, activeLine, { scheme: 'free', referenceLine: settings.referenceLine });
  if (referenceLine === null) {
    const label = rhyme.labels[activeLine];
    let stanzaStart = activeLine;
    while (stanzaStart > 0 && lines[stanzaStart - 1]?.trim()) stanzaStart--;
    if (label) {
      for (let index = activeLine - 1; index >= stanzaStart; index--) {
        if (rhyme.labels[index] === label) { referenceLine = index; break; }
      }
    } else {
      // An unfinished line may follow the detected quatrain, never a previous rhyme group.
      const predicted = getReferenceLine(lines, activeLine, { scheme, referenceLine: null });
      const blockStart = stanzaStart + Math.floor((activeLine - stanzaStart) / 4) * 4;
      let compatible = true;
      for (let left = blockStart; left < Math.min(blockStart + 4, lines.length); left++) {
        for (let right = left + 1; right < Math.min(blockStart + 4, lines.length); right++) {
          if (rhyme.labels[left] && rhyme.labels[right] && (rhyme.labels[left] === rhyme.labels[right]) !== (scheme[(left - blockStart) % 4] === scheme[(right - blockStart) % 4])) compatible = false;
        }
      }
      if (compatible && predicted !== null && predicted >= blockStart) referenceLine = predicted;
    }
  }
  return { ...settings, autoStress: true, meter: meter.meter && feet ? meter.meter : 'free', feet: feet ?? settings.feet, scheme: referenceLine === null ? 'free' : scheme, referenceLine };
}
