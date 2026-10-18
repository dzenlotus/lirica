import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { closeHistory, history, undo } from '@tiptap/pm/history';
import { mapReferenceLine } from './editor-transactions.ts';

const schema = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', group: 'block' }, text: { group: 'inline' } },
});
const paragraph = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : null);

test('manual rhyme reference follows its paragraph and clears only when that paragraph is removed', () => {
  const doc = schema.nodes.doc.create(null, ['Первая', 'Цель', 'Последняя'].map(paragraph));
  const state = EditorState.create({ schema, doc });
  const targetStart = doc.child(0).nodeSize;
  assert.equal(mapReferenceLine(state.tr.insert(0, paragraph('Новая')), 1), 2);
  assert.equal(mapReferenceLine(state.tr.delete(0, targetStart), 1), 0);
  assert.equal(mapReferenceLine(state.tr.delete(targetStart, targetStart + doc.child(1).nodeSize), 1), null);
  assert.equal(mapReferenceLine(state.tr.delete(targetStart + 1, targetStart + 5), 1), 1);
  assert.equal(mapReferenceLine(state.tr.split(targetStart + 1), 1), 2);
  assert.equal(mapReferenceLine(state.tr.join(targetStart), 1), null);
  // Composition defers publishing, so every intermediate mapping must still be applied.
  const first = state.tr.insert(0, paragraph('Новая'));
  const intermediate = state.apply(first);
  assert.equal(mapReferenceLine(intermediate.tr.insert(0, paragraph('Ещё')), mapReferenceLine(first, 1)), 3);
});

test('accepting a suggestion preserves the suffix and isolates following punctuation in undo history', () => {
  let state = EditorState.create({
    schema, plugins: [history()],
    doc: schema.nodes.doc.create(null, ['Несёт хвост', 'Другой стих'].map(paragraph)),
  });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 6)));
  const suffix = ' дыхание рассвета';
  const inserted = closeHistory(state.tr).insertText(suffix, state.selection.from);
  inserted.setSelection(TextSelection.create(inserted.doc, 6 + suffix.length));
  state = state.apply(inserted);
  state = state.apply(closeHistory(state.tr).setMeta('addToHistory', false));
  assert.equal(state.doc.child(0).textContent, 'Несёт дыхание рассвета хвост');
  assert.equal(state.doc.child(1).textContent, 'Другой стих');
  state = state.apply(state.tr.insertText('.'));
  assert.equal(undo(state, transaction => { state = state.apply(transaction); }), true);
  assert.equal(state.doc.child(0).textContent, 'Несёт дыхание рассвета хвост');
  assert.equal(undo(state, transaction => { state = state.apply(transaction); }), true);
  assert.equal(state.doc.child(0).textContent, 'Несёт хвост');
  assert.equal(state.doc.child(1).textContent, 'Другой стих');
});
