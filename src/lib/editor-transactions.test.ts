import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { closeHistory, history, redo, undo } from '@tiptap/pm/history';
import { mapReferenceLine } from './editor-transactions.ts';
import * as editorTransactions from './editor-transactions.ts';

const schema = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', group: 'block', attrs: { id: { default: null } } }, text: { group: 'inline' } },
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

test('replacing one line preserves other paragraphs, accents, reference identity and separate undo/redo', () => {
  assert.equal(typeof editorTransactions.replaceOneLine, 'function');
  const original = [' пе\u0301рвая  ', 'Тихо льётся вода', '\tпосле\u0301дняя, '];
  const doc = schema.nodes.doc.create(null, original.map((text, index) =>
    schema.nodes.paragraph.create({ id: `line-${index}` }, schema.text(text))));
  let state = EditorState.create({ schema, plugins: [history()], doc });
  let referenceLine: number | null = 1;
  const apply = (transaction: import('@tiptap/pm/state').Transaction) => {
    referenceLine = mapReferenceLine(transaction, referenceLine);
    state = state.apply(transaction);
  };
  const replacement = 'Вода струится в тишине';
  const transaction = editorTransactions.replaceOneLine(state, 1, original[1], replacement);
  assert.ok(transaction);
  apply(transaction);
  apply(closeHistory(state.tr).setMeta('addToHistory', false));
  assert.equal(state.doc.child(1).textContent, replacement);
  assert.deepEqual(state.doc.child(1).attrs, doc.child(1).attrs);
  assert.equal(state.selection.from, doc.child(0).nodeSize + 1 + replacement.length);
  assert.strictEqual(state.doc.child(0), doc.child(0));
  assert.strictEqual(state.doc.child(2), doc.child(2));
  assert.equal(referenceLine, 1);

  apply(state.tr.insertText('!'));
  assert.equal(undo(state, apply), true);
  assert.equal(state.doc.child(1).textContent, replacement);
  assert.equal(undo(state, apply), true);
  assert.equal(state.doc.child(1).textContent, original[1]);
  assert.equal(redo(state, apply), true);
  assert.equal(state.doc.child(1).textContent, replacement);
  assert.equal(redo(state, apply), true);
  assert.equal(state.doc.child(1).textContent, replacement + '!');
  assert.equal(state.doc.child(0).textContent, original[0]);
  assert.equal(state.doc.child(2).textContent, original[2]);
  assert.equal(referenceLine, 1);
});

test('one-line replacement rejects stale text, invalid indices and multiline candidates without changing the document', () => {
  assert.equal(typeof editorTransactions.replaceOneLine, 'function');
  const state = EditorState.create({ schema, doc: schema.nodes.doc.create(null, ['Одна', 'Другая'].map(paragraph)) });
  const original = state.doc;
  for (const [line, expected, replacement] of [
    [1, 'Устарела', 'Новая'], [-1, 'Одна', 'Новая'], [2, 'Другая', 'Новая'],
    [0.5, 'Одна', 'Новая'], [0, 'Одна', 'Первая\nВторая'], [0, 'Одна', 'Первая\rВторая'],
    [0, 'Одна', 'Одна'],
  ] as const) {
    assert.equal(editorTransactions.replaceOneLine(state, line, expected, replacement), false);
    assert.strictEqual(state.doc, original);
  }
  const empty = editorTransactions.replaceOneLine(state, 0, 'Одна', '');
  assert.ok(empty);
  assert.equal(empty.doc.child(0).textContent, '');
  assert.equal(empty.doc.child(1).textContent, 'Другая');
  assert.equal(mapReferenceLine(empty, 0), 0);
});
