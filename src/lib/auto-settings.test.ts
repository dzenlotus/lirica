import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAutoSettings } from './auto-settings.ts';
import type { PoetrySettings } from '../types.ts';

const settings: PoetrySettings = { meter: 'iamb', feet: 5, scheme: 'ABBA', precision: 'exact', referenceLine: null, autoSuggest: true };
const meter = { meter: 'trochee' as const, feet: 4, perLine: [] };
test('auto mode uses actual meter and feet without leaking manual defaults when evidence is missing', () => {
  assert.deepEqual(resolveAutoSettings(settings, meter, { scheme: 'ABAB', labels: [] }, ['строка'], 0), settings);
  const auto = { ...settings, autoMeter: true };
  const detected = resolveAutoSettings(auto, meter, { scheme: null, labels: [] }, ['строка'], 0);
  assert.equal(detected.meter, 'trochee');
  assert.equal(detected.feet, 4);
  assert.equal(detected.scheme, 'free');
  const unresolved = resolveAutoSettings(auto, { meter: null, feet: null, perLine: [] }, { scheme: null, labels: [] }, ['строка'], 0);
  assert.equal(unresolved.meter, 'free');
  assert.equal(settings.feet, 5);
  assert.equal(resolveAutoSettings(auto, { ...meter, feet: null, perLine: [{ feet: 2 }] }, { scheme: null, labels: [] }, ['строка'], 0).feet, 2);
});
test('actual rhyme groups and stanza boundaries control auto reference, with manual choice taking priority', () => {
  const auto = { ...settings, autoMeter: true };
  const lines = ['один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь'];
  const rhyme = { scheme: 'ABAB', labels: ['A', 'B', 'A', 'B', 'C', 'D', 'C'] };
  assert.equal(resolveAutoSettings(auto, meter, rhyme, lines, 6).referenceLine, 4);
  assert.equal(resolveAutoSettings(auto, meter, rhyme, lines, 4).scheme, 'free');
  assert.equal(resolveAutoSettings({ ...auto, referenceLine: 1 }, meter, rhyme, lines, 4).referenceLine, 1);
  assert.equal(resolveAutoSettings(auto, meter, { scheme: 'ABAB', labels: ['A', 'B', 'A', 'B', null, 'A'] }, [...lines.slice(0, 4), '', 'один'], 5).referenceLine, null);
  assert.equal(resolveAutoSettings(auto, meter, { scheme: 'ABAB', labels: ['A', 'B', null] }, lines.slice(0, 3), 2).referenceLine, 0);
  assert.equal(resolveAutoSettings(auto, meter, { scheme: 'ABAB', labels: ['A', 'B', 'A', 'B', 'C', 'C', 'D', null] }, [...lines, 'восемь'], 7).referenceLine, null);
});
