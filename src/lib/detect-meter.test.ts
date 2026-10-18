import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMeter } from './detect-meter.ts';
import { METER_EXAMPLES } from './meter-examples.ts';
import { stripAcutes, tokenizeWords, type LineProsody } from './prosody.ts';

// Trusted pronunciations are independent from the grid being detected.
function pronunciation(accentedText: string): LineProsody {
  return {
    text: accentedText,
    words: tokenizeWords(accentedText).map(word => {
      const stress = word.vowels.find(offset => /[ёЁ]|\u0301/.test(accentedText.slice(offset).match(/^[аеёиоуыэюя]\p{M}*/iu)?.[0] ?? ''));
      return { start: word.start, end: word.end, stress: stress ?? null, status: stress === undefined ? 'weak' : 'known' };
    }),
  };
}
function detect(accentedLines: string[]) {
  return detectMeter(accentedLines.map(stripAcutes), accentedLines.map(pronunciation));
}

test('detects all five classic meters and their feet, including normal endings and skipped stresses', () => {
  for (const [meter, example] of Object.entries(METER_EXAMPLES)) {
    if (meter === 'free') continue;
    const result = detect(example.accentedText.split('\n'));
    assert.equal(result.status, 'detected', meter);
    assert.equal(result.meter, meter);
    assert.equal(result.feet, example.feet, meter);
    assert.equal(result.analyzedLines, 2);
    assert.ok(result.perLine.every(line => line.meter === meter && line.feet === example.feet));
  }
  const pyrrhic = detect(['И ду́м высо́кое стремле́нье']);
  assert.equal(pyrrhic.meter, 'iamb');
  assert.equal(pyrrhic.feet, 4);
});

test('keeps a detected meter when the last line is unfinished without claiming it was analyzed', () => {
  const example = METER_EXAMPLES.trochee.accentedText.split('\n');
  const lines = [...example.map(stripAcutes), '', 'новое'];
  const result = detectMeter(lines, example.map(pronunciation));
  assert.equal(result.status, 'detected');
  assert.equal(result.meter, 'trochee');
  assert.equal(result.feet, 4);
  assert.equal(result.analyzedLines, 2);
  assert.equal(result.totalLines, 3);
  assert.equal(result.perLine.length, lines.length);
  assert.equal(result.perLine[3].status, 'insufficient');
  assert.equal(result.perLine[3].meter, null);
  assert.equal(result.perLine[3].feet, null);
});

test('distinguishes variable feet from conflicting meters', () => {
  const variable = detect(['Моро́з и со́лнце; де́нь чуде́сный!', 'Моя́ душа́']);
  assert.equal(variable.status, 'detected');
  assert.equal(variable.meter, 'iamb');
  assert.equal(variable.feet, null);
  assert.deepEqual(variable.perLine.map(line => line.feet), [4, 2]);

  const mixed = detect(['Моро́з и со́лнце; де́нь чуде́сный!', 'Бу́ря мгло́ю не́бо кро́ет,']);
  assert.equal(mixed.status, 'mixed');
  assert.equal(mixed.meter, null);
  assert.equal(mixed.feet, null);
});

test('does not invent a meter from empty, single-word, unknown, stale, or weak-only evidence', () => {
  assert.equal(detectMeter(['', '   ']).status, 'insufficient');
  assert.equal(detect(['Моро́з']).status, 'insufficient');
  assert.equal(detect(['и и и и и и и и']).status, 'insufficient');
  const text = 'Мороз и солнце; день чудесный!';
  assert.equal(detectMeter([text]).status, 'insufficient');
  assert.equal(detectMeter([text], [pronunciation('Бу́ря мгло́ю не́бо кро́ет,')]).status, 'insufficient');
  const unknown = pronunciation('Моро́з и со́лнце; де́нь чуде́сный!');
  unknown.words[0] = { ...unknown.words[0], stress: null, status: 'unknown' };
  assert.equal(detectMeter([text], [unknown]).status, 'insufficient');
});

test('reports ambiguous grids instead of choosing the first match, and respects author accents', () => {
  const ambiguous = detect(['Бу́ря и и и и ти́хо']);
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.meter, null);
  assert.equal(ambiguous.feet, null);
  const manual = ['Бу́ря мгло́ю не́бо кро́ет,'];
  const result = detectMeter(manual, [pronunciation('Буря́ мглою́ небо́ крое́т,')]);
  assert.equal(result.meter, 'trochee');
  assert.equal(result.feet, 4);
  assert.deepEqual(manual, ['Бу́ря мгло́ю не́бо кро́ет,']);
});

test('foreign letters and spoken numbers remain uncertain without rejecting punctuation or combining accents', () => {
  for (const extra of ['hello', 'hola', 'κόσμε', 'привіт', '2026', '２０', 'XIV', '1-й', 'hеllo']) {
    const result = detectMeter([`Моя́ ${extra} душа́`]);
    assert.equal(result.status, 'insufficient', extra);
    assert.equal(result.meter, null, extra);
    assert.equal(result.perLine[0].status, 'insufficient', extra);
    assert.equal(result.analyzedLines, 0, extra);
  }
  const punctuated = detectMeter(['«Моя́» — душа́! 🙂']);
  assert.equal(punctuated.status, 'detected');
  assert.equal(punctuated.meter, 'iamb');
  assert.equal(punctuated.feet, 2);
});
