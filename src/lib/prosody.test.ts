import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Meter } from '../types.ts';
import {
  analyzeLineProsody, applyAutomaticStresses, stripAcutes, suggestAlternativeMeter, tokenizeWords,
  type LineProsody,
} from './prosody.ts';
import { METER_EXAMPLES } from './meter-examples.ts';

// A trusted pronunciation fixture, independent of the chosen metrical grid.
function pronunciation(accentedText: string): LineProsody {
  return {
    text: accentedText,
    words: tokenizeWords(accentedText).map(word => {
      const stress = word.vowels.find(offset => {
        const vowel = accentedText.slice(offset).match(/^[аеёиоуыэюя]\p{M}*/iu)?.[0] ?? '';
        return /ё/iu.test(vowel) || vowel.includes('\u0301') || (/е/iu.test(vowel) && vowel.includes('\u0308'));
      });
      return { start: word.start, end: word.end, stress: stress ?? null, status: stress === undefined ? 'weak' : 'known' };
    }),
  };
}

test('tokenizes Russian words and compounds with UTF-16 offsets and keeps original combining marks', () => {
  const text = '🙂Моро́з, из-за е\u0308лки и тишь! ABC 123 в';
  const words = tokenizeWords(text);
  assert.deepEqual(words.map(word => word.text), ['Моро́з', 'из-за', 'е\u0308лки', 'и', 'тишь']);
  assert.deepEqual(words.map(word => word.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(words[0], { index: 0, text: 'Моро́з', start: 2, end: 8, vowels: [3, 5] });
  for (const word of words) {
    assert.equal(text.slice(word.start, word.end), word.text);
    for (const offset of word.vowels) assert.match(text[offset], /[аеёиоуыэюя]/iu);
  }
  assert.equal(stripAcutes('е\u0308\u0301 а\u0300\u0301 ё'), 'е\u0308 а\u0300 ё');
});

test('classic examples keep natural stresses and accept masculine, feminine, and dactylic endings', () => {
  for (const [meter, example] of Object.entries(METER_EXAMPLES)) {
    if (meter === 'free') continue;
    for (const accentedLine of example.accentedText.split('\n')) {
      const line = stripAcutes(accentedLine);
      const result = analyzeLineProsody(line, pronunciation(accentedLine), meter as Meter, example.feet!);
      assert.deepEqual(result.issues, [], `${meter}: ${accentedLine}`);
      assert.equal(result.complete, true);
      assert.equal(result.text, line);
    }
  }
});

test('a pyrrhic in a four-foot iamb is not a missing-stress error', () => {
  const accented = 'И ду́м высо́кое стремле́нье';
  const result = analyzeLineProsody(stripAcutes(accented), pronunciation(accented), 'iamb', 4);
  assert.equal(result.syllables, 9);
  assert.deepEqual(result.issues, []);
  assert.equal(result.stresses.length, 3);
});

test('a trochaic classic highlights actual stressed vowels against the iambic grid', () => {
  const accented = 'Бу́ря мгло́ю не́бо кро́ет,';
  const result = analyzeLineProsody(stripAcutes(accented), pronunciation(accented), 'iamb', 4);
  assert.equal(result.issues.filter(issue => issue.kind === 'stress').length, 4);
  assert.deepEqual(result.issues.map(issue => result.text.slice(issue.start, issue.end)), ['у', 'о', 'е', 'о']);
});

test('iamb advice names the natural first-syllable stress and offers a pronunciation-preserving rewrite', () => {
  const text = 'Буря мглою небо кроет,';
  const analysis = pronunciation('Бу́ря мгло́ю не́бо кро́ет,');
  const originalAnalysis = structuredClone(analysis);
  const result = analyzeLineProsody(text, analysis, 'iamb', 4);
  const issue = result.issues[0];
  assert.equal(issue.word, 'Бу́ря');
  assert.equal(issue.syllable, 1);
  assert.deepEqual(issue.expectedSyllables, [2, 4, 6, 8]);
  assert.match(issue.message, /«Бу́ря» ударение на 1-м слоге слова \(1-й слог строки\)/);
  assert.match(issue.message, /Ямб ожидает ударение на 2-м слоге строки; 1-й слог должен быть безударным/);
  assert.match(issue.recommendation, /добавить перед «Бу́ря» один безударный слог/);
  assert.doesNotMatch(issue.message + issue.recommendation, /слабую долю|буря́/iu);
  assert.equal(result.text, text);
  assert.deepEqual(analysis, originalAnalysis);
});

test('trochee advice explains мороз as second-syllable stress without inventing мо́роз', () => {
  const text = 'мороз и солнце; день чудесный';
  const result = analyzeLineProsody(text, pronunciation('моро́з и со́лнце; де́нь чуде́сный'), 'trochee', 4);
  const issue = result.issues[0];
  assert.equal(issue.word, 'моро́з');
  assert.equal(issue.syllable, 2);
  assert.deepEqual(issue.expectedSyllables, [1, 3, 5, 7]);
  assert.match(issue.message, /«моро́з» ударение на 2-м слоге слова \(2-й слог строки\)/);
  assert.match(issue.message, /Хорей ожидает ударение на 1-м слоге строки/);
  assert.match(issue.recommendation, /заменить слово «моро́з» или изменить порядок слов/);
  assert.doesNotMatch(issue.message + issue.recommendation, /мо́роз/);
  assert.equal(result.text, text);
});

test('manual acute overrides the automatic pronunciation and an off-grid accent remains visible', () => {
  const text = 'за́мок';
  const result = analyzeLineProsody(text, pronunciation('замо́к'), 'iamb', 1);
  assert.equal(result.text, text);
  assert.deepEqual(result.stresses, [{ start: 1, end: 3, source: 'manual' }]);
  assert.deepEqual(result.issues.map(issue => ({ kind: issue.kind, marked: text.slice(issue.start, issue.end) })), [
    { kind: 'stress', marked: 'а́' },
  ]);
  assert.equal(result.complete, true);
  assert.equal(applyAutomaticStresses(text, pronunciation('замо́к')), text);
  assert.equal(result.issues[0].word, text);
  assert.match(result.issues[0].recommendation, /Проверьте ручную отметку ударения по смыслу\. Если она верна/);
  assert.doesNotMatch(result.issues[0].message + result.issues[0].recommendation, /замо́к/);
});

test('inherent ё and decomposed е with diaeresis are trusted without rewriting their spelling', () => {
  const text = '🙂е\u0308лка и ёлка';
  const analysis = pronunciation('🙂ёлка и ёлка');
  const result = analyzeLineProsody(text, analysis, 'free', 4);
  assert.equal(result.text, text);
  assert.deepEqual(result.stresses.map(stress => text.slice(stress.start, stress.end)), ['е\u0308', 'ё']);
  assert.ok(result.stresses.every(stress => stress.source === 'manual'));
  assert.equal(result.complete, true);
  assert.equal(applyAutomaticStresses(text, analysis), text);
});

test('several explicit accents in one word are preserved and suppress the automatic mark', () => {
  const text = 'по́ве́сти';
  const result = analyzeLineProsody(text, pronunciation('повести́'), 'free', 4);
  assert.deepEqual(result.stresses.map(stress => text.slice(stress.start, stress.end)), ['о́', 'е́']);
  assert.ok(result.stresses.every(stress => stress.source === 'manual'));
  assert.equal(applyAutomaticStresses(text, pronunciation('повести́')), text);
});

test('automatic offsets follow vowel ordinal after manual accents shift later words', () => {
  const text = 'ду́ма и тишина';
  const result = analyzeLineProsody(text, pronunciation('дума́ и тишина́'), 'free', 4);
  assert.deepEqual(result.stresses, [
    { start: 1, end: 3, source: 'manual' },
    { start: text.length - 1, end: text.length, source: 'auto' },
  ]);
  assert.equal(applyAutomaticStresses(text, pronunciation('дума́ и тишина́')), 'ду́ма и тишина́');
});

test('missing and stale analysis never add accents or unknown decorations, but retain manual checks', () => {
  for (const analysis of [undefined, pronunciation('луна́')]) {
    const result = analyzeLineProsody('рука', analysis, 'iamb', 1);
    assert.deepEqual(result.stresses, []);
    assert.deepEqual(result.unknown, []);
    assert.equal(result.complete, false);
    assert.equal(applyAutomaticStresses('рука', analysis), 'рука');
  }
  const manual = analyzeLineProsody('ру́ка', pronunciation('луна́'), 'iamb', 1);
  assert.equal(manual.issues[0]?.kind, 'stress');
  assert.equal(manual.complete, true);
});

test('compatible unknown pronunciations report uncertainty while length checks remain available', () => {
  const text = 'неведомо';
  const analysis: LineProsody = { text, words: [{ start: 0, end: text.length, stress: null, status: 'unknown' }] };
  const result = analyzeLineProsody(text, analysis, 'iamb', 4);
  assert.deepEqual(result.unknown, [{ start: 0, end: text.length }]);
  assert.equal(result.complete, false);
  assert.equal(result.issues[0]?.kind, 'short');
  assert.match(result.issues[0].message, /4/);
  assert.deepEqual(analyzeLineProsody('неве́домо', analysis, 'free', 4).unknown, []);
});

test('invalid backend stress positions fail closed rather than moving stress to the metrical grid', () => {
  const text = 'дорога';
  for (const stress of [0, 2, 99, null]) {
    const analysis: LineProsody = { text, words: [{ start: 0, end: text.length, stress, status: 'known' }] };
    const result = analyzeLineProsody(text, analysis, 'iamb', 2);
    assert.deepEqual(result.stresses, []);
    assert.deepEqual(result.unknown, [{ start: 0, end: text.length }]);
    assert.equal(result.complete, false);
  }
});

test('all five grids accept endings from the last strong syllable through two following syllables', () => {
  for (const [meter, lastStrongLength, expected] of [
    ['iamb', 8, 8], ['trochee', 7, 8], ['dactyl', 10, 12], ['amphibrach', 11, 12], ['anapest', 12, 12],
  ] as const) {
    for (let count = lastStrongLength; count <= lastStrongLength + 2; count++) {
      const text = Array(count).fill('и').join(' ');
      const result = analyzeLineProsody(text, pronunciation(text), meter, 4);
      assert.deepEqual(result.issues, [], `${meter}: ${count}`);
      assert.equal(result.expected, expected);
    }
  }
});

test('extra syllables have an actual span and a short line anchors its last full grapheme', () => {
  const text = Array(11).fill('и').join(' ');
  const extra = analyzeLineProsody(text, pronunciation(text), 'iamb', 4);
  assert.deepEqual(extra.issues.map(issue => ({ start: issue.start, end: issue.end, kind: issue.kind })), [
    { start: 20, end: 21, kind: 'extra' },
  ]);
  assert.match(extra.issues[0].message, /11/);
  const shortText = Array(7).fill('и').join(' ') + '🙂';
  const short = analyzeLineProsody(shortText, pronunciation(shortText), 'iamb', 4);
  assert.equal(short.issues[0]?.kind, 'short');
  assert.equal(shortText.slice(short.issues[0].start, short.issues[0].end), '🙂');
  assert.match(short.issues[0].message, /7/);
  assert.match(short.issues[0].message, /8/);
  assert.deepEqual(analyzeLineProsody('  ', undefined, 'iamb', 4).issues, []);
});

test('length advice gives the exact necessary change and the allowed ending range', () => {
  const short = analyzeLineProsody('Вечер', pronunciation('Ве́чер'), 'iamb', 4).issues.find(issue => issue.kind === 'short')!;
  assert.match(short.message, /2 слога — на 6 меньше необходимого/);
  assert.match(short.recommendation, /Добавьте минимум 6 слогов/);
  assert.match(short.recommendation, /8–10 слогов/);
  assert.equal(short.syllable, 3);
  assert.deepEqual(short.expectedSyllables, [2, 4, 6, 8]);

  const longText = Array(12).fill('и').join(' ');
  const extra = analyzeLineProsody(longText, pronunciation(longText), 'iamb', 4).issues[0];
  assert.match(extra.message, /12 слогов — на 2 больше допустимого/);
  assert.match(extra.recommendation, /Сократите строку минимум на 2 слога/);
  assert.match(extra.recommendation, /8–10 слогов/);
  assert.equal(extra.syllable, 11);
});

test('alternative meter requires complete pronunciation and a unique fit supported by several words', () => {
  const accented = 'Бу́ря мгло́ю не́бо кро́ет,';
  const text = stripAcutes(accented);
  assert.deepEqual(suggestAlternativeMeter(text, pronunciation(accented), 'iamb', 4), {
    meter: 'trochee', feet: 4, label: 'Хорей, 4 стопы',
  });
  assert.equal(suggestAlternativeMeter(text, undefined, 'iamb', 4), null);
  assert.equal(suggestAlternativeMeter(text, pronunciation(accented), 'trochee', 4), null);
  assert.equal(suggestAlternativeMeter(text, pronunciation(accented), 'free', 4), null);
  assert.equal(suggestAlternativeMeter('Я́ ты́ он мы', pronunciation('Я́ ты́ он мы'), 'iamb', 2), null);
  assert.equal(suggestAlternativeMeter('Бу́ря и и и', pronunciation('Бу́ря и и и'), 'iamb', 2), null);
});

test('automatic monosyllabic prominence does not overflag, while an explicit mono accent is checked', () => {
  const auto = analyzeLineProsody('Я вас любил', pronunciation('Я́ ва́с люби́л'), 'iamb', 2);
  assert.deepEqual(auto.issues, []);
  const manual = analyzeLineProsody('Я́ вас любил', pronunciation('Я ва́с люби́л'), 'iamb', 2);
  assert.equal(manual.issues[0]?.kind, 'stress');
  assert.equal(manual.text.slice(manual.issues[0].start, manual.issues[0].end), 'Я́');
});

test('free verse adds no meter errors and export adds only automatic acutes to the original text', () => {
  const text = '😀за́мок и ёлка, дорога!';
  const analysis = pronunciation('😀замо́к и ё́лка, доро́га!');
  const result = analyzeLineProsody(text, analysis, 'free', 4);
  assert.equal(result.text, text);
  assert.equal(result.expected, null);
  assert.deepEqual(result.issues, []);
  assert.equal(applyAutomaticStresses(text, analysis), '😀за́мок и ёлка, доро́га!');
  assert.equal(stripAcutes(applyAutomaticStresses(text, analysis)), stripAcutes(text));
});
