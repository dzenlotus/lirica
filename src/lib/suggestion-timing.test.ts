import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldScheduleAutomaticSuggestions } from './suggestion-timing.ts';
const previous = { poemId: 'one', textKey: '["Тихий"]', editRevision: 1 };
const edit = { poemId: 'one', textKey: '["Тихий вечер"]', enabled: true, focused: true, hasText: true, editRevision: 2, dismissedRevision: 0 };
test('only a real edit in the active poem schedules automatic suggestions', () => {
  assert.equal(shouldScheduleAutomaticSuggestions(previous, edit), true);
  assert.equal(shouldScheduleAutomaticSuggestions(undefined, edit), false);
  assert.equal(shouldScheduleAutomaticSuggestions(previous, { ...edit, editRevision: previous.editRevision }), false);
  assert.equal(shouldScheduleAutomaticSuggestions(previous, { ...edit, poemId: 'other' }), false);
  assert.equal(shouldScheduleAutomaticSuggestions(previous, { ...edit, textKey: previous.textKey }), false);
  for (const patch of [{ enabled: false }, { focused: false }, { hasText: false }]) assert.equal(shouldScheduleAutomaticSuggestions(previous, { ...edit, ...patch }), false);
});
test('accepting or dismissing after an edit prevents a delayed reopening, then new typing works', () => {
  assert.equal(shouldScheduleAutomaticSuggestions(previous, { ...edit, dismissedRevision: 2 }), false);
  assert.equal(shouldScheduleAutomaticSuggestions(previous, { ...edit, editRevision: 3, dismissedRevision: 2 }), true);
});
