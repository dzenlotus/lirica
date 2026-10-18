import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRhyme } from './detect-rhyme.ts';
import { stripAcutes, tokenizeWords, type LineProsody } from './prosody.ts';

function pronunciation(text: string): LineProsody {
  return {
    text,
    words: tokenizeWords(text).map(word => {
      const stress = word.vowels.find(offset => /ё/iu.test(text[offset]) || text[offset + 1] === '\u0301');
      return { start: word.start, end: word.end, stress: stress ?? null, status: stress === undefined ? 'unknown' : 'known' };
    }),
  };
}

test('hears classic masculine and feminine rhymes instead of comparing final letters', () => {
  const lines = ['Моро́з и со́лнце; де́нь чуде́сный!', 'Ещё́ ты дре́млешь, дру́г преле́стный —', 'Пора́, краса́вица, просни́сь:', 'Откро́й сомкну́ты не́гой взо́ры', 'Навстре́чу се́верной Авро́ры,', 'Звездо́ю се́вера яви́сь!'];
  const detected = detectRhyme(lines.map(stripAcutes), lines.map(pronunciation));
  assert.equal(detected.status, 'detected');
  assert.equal(detected.scheme, 'AABCCB');
  assert.deepEqual(detected.labels, ['A', 'A', 'B', 'C', 'C', 'B']);

  assert.equal(detectRhyme(['чуде́сный', 'дру́г', 'преле́стный', 'ю́г']).scheme, 'ABAB');
  assert.equal(detectRhyme(['кро́ет', 'крутя́', 'заво́ет', 'дитя́']).scheme, 'ABAB');
});

test('keeps manual pronunciation, refuses unknown endings, and does not call arbitrary а endings rhymes', () => {
  const lines = ['за́мок', 'молоко́', 'пото́к', 'далеко́'];
  const wrongAutomatic = [pronunciation('замо́к'), ...lines.slice(1).map(pronunciation)];
  assert.equal(detectRhyme(lines, wrongAutomatic).scheme, 'ABCB');
  assert.equal(detectRhyme(['кроет', 'крутя', 'завоет', 'дитя']).status, 'unknown');
  assert.equal(detectRhyme(['весна́', 'рука́', 'трава́', 'игра́']).scheme, null);
  assert.equal(detectRhyme(['ве́чер hello', 'дру́г', 'ве́чер hello', 'ю́г']).status, 'partial');
});

test('reports partial evidence without inventing a four-line pattern', () => {
  assert.equal(detectRhyme([]).status, 'insufficient');
  const partial = detectRhyme(['кро́ет', 'крутя́', 'заво́ет']);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.scheme, null);
  assert.deepEqual(partial.labels, ['A', 'B', 'A']);
  const pending = detectRhyme(['кро́ет', 'крутя́', 'заво́ет', 'неизвестно']);
  assert.equal(pending.status, 'partial');
  assert.equal(pending.scheme, null);
  assert.deepEqual(pending.labels, ['A', 'B', 'A', null]);
});

test('resets stanza labels, combines equal patterns, and marks different patterns as mixed', () => {
  const first = ['кро́ет', 'крутя́', 'заво́ет', 'дитя́'];
  const second = ['чуде́сный', 'дру́г', 'преле́стный', 'ю́г'];
  const same = detectRhyme([...first, '', ...second]);
  assert.equal(same.status, 'detected');
  assert.equal(same.scheme, 'ABAB');
  assert.deepEqual(same.labels, ['A', 'B', 'A', 'B', null, 'A', 'B', 'A', 'B']);
  assert.deepEqual(same.stanzas.map(stanza => [stanza.startLine, stanza.endLine, stanza.scheme]), [[0, 3, 'ABAB'], [5, 8, 'ABAB']]);
  assert.equal(detectRhyme([...first, '', 'чуде́сный', 'преле́стный', 'дру́г', 'ю́г']).status, 'mixed');
});

test('recognizes repeated quatrains and retains completed evidence while the last line is being written', () => {
  const first = ['кро́ет', 'крутя́', 'заво́ет', 'дитя́'];
  const next = ['чуде́сный', 'дру́г', 'преле́стный', 'ю́г'];
  const repeated = detectRhyme([...first, ...next]);
  assert.equal(repeated.status, 'detected');
  assert.equal(repeated.scheme, 'ABAB');
  assert.deepEqual(repeated.labels, ['A', 'B', 'A', 'B', 'C', 'D', 'C', 'D']);
  const pending = detectRhyme([...first, 'продолжение']);
  assert.equal(pending.status, 'partial');
  assert.equal(pending.scheme, 'ABAB');
});

test('known endings in an unfinished block can contradict a previously completed pattern', () => {
  const first = ['кро́ет', 'крутя́', 'заво́ет', 'дитя́'];
  for (const separator of [[], ['']]) {
    const conflicting = detectRhyme([...first, ...separator, 'чуде́сный', 'преле́стный', 'дру́г', 'неизвестно']);
    assert.equal(conflicting.status, 'mixed');
    assert.equal(conflicting.scheme, null);
  }
  // ABAB also requires the third known ending to rhyme with the first.
  const missingPair = detectRhyme([...first, 'чуде́сный', 'дру́г', 'молоко́', 'неизвестно']);
  assert.equal(missingPair.status, 'mixed');
  assert.equal(missingPair.scheme, null);
  const stillPossible = detectRhyme([...first, 'чуде́сный', 'дру́г', 'неизвестно', 'неизвестно']);
  assert.equal(stillPossible.status, 'partial');
  assert.equal(stillPossible.scheme, 'ABAB');
});
