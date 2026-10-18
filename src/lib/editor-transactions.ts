import { closeHistory } from '@tiptap/pm/history';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';

export function replaceOneLine(state: EditorState, line: number, expectedText: string, replacement: string): Transaction | false {
  if (!Number.isInteger(line) || line < 0 || line >= state.doc.childCount || /[\r\n]/.test(replacement) || replacement === expectedText) return false;
  const paragraph = state.doc.child(line);
  if (paragraph.type.name !== 'paragraph' || paragraph.textContent !== expectedText) return false;
  let start = 1;
  for (let index = 0; index < line; index++) start += state.doc.child(index).nodeSize;
  // Replace only content: the paragraph's identity and a manual rhyme reference remain intact.
  const transaction = closeHistory(state.tr).insertText(replacement, start, start + paragraph.content.size);
  return transaction.setSelection(TextSelection.create(transaction.doc, start + replacement.length));
}

export function mapReferenceLine(transaction: Transaction, referenceLine: number | null): number | null {
  if (referenceLine === null || !transaction.docChanged) return referenceLine;
  if (referenceLine < 0 || referenceLine >= transaction.before.childCount) return null;
  let start = 1;
  for (let index = 0; index < referenceLine; index++) start += transaction.before.child(index).nodeSize;
  const mapped = transaction.mapping.mapResult(start, 1);
  // Removing the paragraph's opening token deletes its identity; deleting only its text does not.
  if (mapped.deletedBefore) return null;
  const position = Math.max(1, Math.min(mapped.pos, transaction.doc.content.size - 1));
  const resolved = transaction.doc.resolve(position);
  return resolved.depth && resolved.parent.isTextblock ? resolved.index(0) : null;
}
