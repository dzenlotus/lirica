import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { closeHistory, history, redo, undo } from '@tiptap/pm/history';
import { createStressEdit } from './stress.ts';
import { mapReferenceLine } from './editor-transactions.ts';

const applyEdit = (text: string, from: number, to = from) => {
  const edit = createStressEdit(text, from, to);
  assert.ok(edit);
  return { text: text.slice(0, edit.from) + edit.text + text.slice(edit.to), caret: edit.caret };
};

test('toggles the Russian vowel before or after the caret without touching surrounding text', () => {
  for (const caret of [2, 3]) assert.deepEqual(applyEdit('Свет и тишина', caret), { text: 'Све́т и тишина', caret: 4 });
  assert.deepEqual(applyEdit('Ау', 1), { text: 'А́у', caret: 2 });
  assert.deepEqual(applyEdit('🙂а!', 2), { text: '🙂а́!', caret: 4 });
});

test('a selected vowel toggles off its existing acute even when the mark is outside the selection', () => {
  assert.deepEqual(applyEdit('Доро́га', 3, 4), { text: 'Дорога', caret: 4 });
  assert.deepEqual(applyEdit('Доро́га', 3, 5), { text: 'Дорога', caret: 4 });
  assert.deepEqual(applyEdit('Дорога', 3, 4), { text: 'Доро́га', caret: 5 });
});

test('repeated toggles remove the accent and preserve other combining marks', () => {
  const accented = applyEdit('луна', 4);
  assert.deepEqual(applyEdit(accented.text, accented.caret), { text: 'луна', caret: 4 });
  for (const caret of [1, 2, 3]) assert.deepEqual(applyEdit('а\u0300\u0301!', caret), { text: 'а\u0300!', caret: 2 });
  assert.deepEqual(applyEdit('а\u0300!', 2), { text: 'а\u0301\u0300!', caret: 3 });
  assert.deepEqual(applyEdit('а\u0301\u0301!', 3), { text: 'а!', caret: 1 });
});

test('rejects ambiguous or invalid selections and caret positions', () => {
  for (const [text, from, to] of [
    ['дорога', 0, 6], ['дом', 0, 3], ['а у', 0, 3], ['а\u0301', 1, 2],
    ['снег', 0, 0], ['снег', 4, 4], ['', 0, 0], ['а', -1, -1],
    ['а', 2, 2], ['а', 1, 0], ['а', 0.5, 0.5],
  ] as const) assert.equal(createStressEdit(text, from, to), null, `${text}: ${from}-${to}`);
});

test('ё is already stressed; only redundant acute marks can be removed', () => {
  for (const text of ['ё', 'Ё', 'е\u0308', 'Е\u0308']) {
    assert.equal(createStressEdit(text, 0, text.length), null);
    assert.equal(createStressEdit(text, text.length, text.length), null);
  }
  assert.deepEqual(applyEdit('мё\u0301д', 3), { text: 'мёд', caret: 2 });
  assert.deepEqual(applyEdit('е\u0308\u0301', 3), { text: 'е\u0308', caret: 2 });
});

test('an accent is one undo step between typing, preserves adjacent lines, and can be redone', () => {
  const schema = new Schema({
    nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', group: 'block' }, text: { group: 'inline' } },
  });
  let state = EditorState.create({
    schema, plugins: [history()],
    doc: schema.nodes.doc.create(null, ['луна', 'Другая строка'].map(text => schema.nodes.paragraph.create(null, schema.text(text)))),
  });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 5)));
  state = state.apply(state.tr.insertText('!'));
  const edit = createStressEdit(state.doc.child(0).textContent, 4, 4);
  assert.ok(edit);
  const transaction = closeHistory(state.tr).insertText(edit.text, edit.from + 1, edit.to + 1);
  transaction.setSelection(TextSelection.create(transaction.doc, edit.caret + 1));
  state = state.apply(transaction);
  state = state.apply(closeHistory(state.tr).setMeta('addToHistory', false));
  state = state.apply(state.tr.insertText('?'));
  const lines = () => [state.doc.child(0).textContent, state.doc.child(1).textContent];
  assert.deepEqual(lines(), ['луна́?!', 'Другая строка']);
  assert.equal(undo(state, tr => { state = state.apply(tr); }), true);
  assert.deepEqual(lines(), ['луна́!', 'Другая строка']);
  assert.equal(undo(state, tr => { state = state.apply(tr); }), true);
  assert.deepEqual(lines(), ['луна!', 'Другая строка']);
  assert.equal(undo(state, tr => { state = state.apply(tr); }), true);
  assert.deepEqual(lines(), ['луна', 'Другая строка']);
  assert.equal(redo(state, tr => { state = state.apply(tr); }), true);
  assert.deepEqual(lines(), ['луна!', 'Другая строка']);
  assert.equal(redo(state, tr => { state = state.apply(tr); }), true);
  assert.deepEqual(lines(), ['луна́!', 'Другая строка']);
});

test('removing an accent can be undone and leaves the manual line reference intact', () => {
  const schema = new Schema({
    nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', group: 'block' }, text: { group: 'inline' } },
  });
  let state = EditorState.create({
    schema, plugins: [history()],
    doc: schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('А́лая заря'))),
  });
  const edit = createStressEdit(state.doc.child(0).textContent, 0, 2);
  assert.ok(edit);
  const transaction = closeHistory(state.tr).insertText(edit.text, edit.from + 1, edit.to + 1);
  assert.equal(mapReferenceLine(transaction, 0), 0);
  state = state.apply(transaction);
  assert.equal(state.doc.textContent, 'Алая заря');
  assert.equal(undo(state, tr => { state = state.apply(tr); }), true);
  assert.equal(state.doc.textContent, 'А́лая заря');
  assert.equal(redo(state, tr => { state = state.apply(tr); }), true);
  assert.equal(state.doc.textContent, 'Алая заря');
});
