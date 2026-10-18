import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePoems, mergePoems, persistPoems, poemsToSave } from './storage.ts';
import type { Poem } from '../types.ts';
const poem: Poem = { id: 'one', title: 'Стих', lines: ['Первая строка'], favorite: false, updatedAt: '2026-10-18T10:00:00.000Z', settings: { meter: 'iamb', feet: 4, scheme: 'ABAB', precision: 'exact', referenceLine: null, autoSuggest: true } };
test('closing a stale tab preserves newer poems and newly created poems', () => {
  const newer = { ...poem, lines: ['Новая редакция'], updatedAt: '2026-10-18T10:01:00.000Z' };
  const added = { ...newer, id: 'two' };
  let raw = JSON.stringify([newer, added]);
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  assert.deepEqual(persistPoems(storage, [poem]), [newer, added]);
  assert.deepEqual(JSON.parse(raw), [newer, added]);
  assert.equal(mergePoems([newer], [poem])[0].lines[0], 'Новая редакция');
});
test('malformed storage is not overwritten by autosave', () => {
  let written = false;
  const storage = { getItem: () => '{broken', setItem: () => { written = true; } };
  assert.throws(() => persistPoems(storage, [poem]));
  assert.equal(written, false);
  for (const change of [{ updatedAt: 'bad-date' }, { lines: [] }, { settings: { ...poem.settings, feet: 0 } }, { favorite: 'yes' }]) assert.throws(() => decodePoems(JSON.stringify([{ ...poem, ...change }])));
  assert.throws(() => decodePoems(JSON.stringify([poem, poem])));
  assert.deepEqual(decodePoems(JSON.stringify([poem])), [poem]);
});
test('an empty saved library is valid', () => {
  assert.deepEqual(decodePoems('[]'), []);
  let raw: string | null = null;
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  assert.deepEqual(persistPoems(storage, []), []);
  assert.equal(raw, '[]');
});

test('fresh empty drafts stay out of the library while saved poems and authored drafts are preserved', () => {
  const draft = { ...poem, id: 'draft', title: '', lines: [''] };
  assert.deepEqual(poemsToSave([draft, poem], draft.id), [poem]);
  assert.deepEqual(poemsToSave([{ ...draft, title: '  ', lines: ['  ', ''] }, poem], draft.id), [poem]);
  for (const authored of [{ ...draft, title: 'Название' }, { ...draft, lines: ['Све́т'] }]) assert.deepEqual(poemsToSave([authored, poem], draft.id), [authored, poem]);
  const previouslySavedEmpty = { ...draft, id: 'saved-empty' };
  assert.deepEqual(poemsToSave([draft, previouslySavedEmpty], draft.id), [previouslySavedEmpty]);
});

test('clearing a draft after its first save replaces the old text', () => {
  const cleared = { ...poem, title: '', lines: [''], updatedAt: '2026-10-18T10:02:00.000Z' };
  let raw = JSON.stringify([poem]);
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  persistPoems(storage, poemsToSave([cleared], ''));
  assert.deepEqual(decodePoems(raw)[0].lines, ['']);
  assert.equal(decodePoems(raw)[0].title, '');
});
