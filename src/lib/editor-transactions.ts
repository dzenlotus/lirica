import type { Transaction } from '@tiptap/pm/state';

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
