import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef } from 'react';
import { EditorContent, Extension, useEditor } from '@tiptap/react';
import type { Editor, JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { splitBlock } from '@tiptap/pm/commands';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorSelection, PoetrySettings } from './types';
import { getRhymeLabel } from './lib/poetry';
import { mapReferenceLine, replaceOneLine } from './lib/editor-transactions';
import { analyzeLineProsody } from './lib/prosody';
import type { ProsodyResponse } from './lib/prosody';
import { createStressEdit } from './lib/stress';
import './editor.css';

export interface PoemEditorHandle {
  acceptSuggestion(text: string): boolean;
  replaceLine(line: number, expectedText: string, replacement: string): boolean;
  toggleStress(): boolean;
  focus(): void;
  insertStanza(): void;
  undo(): void;
  redo(): void;
}

export interface PoemEditorProps {
  poemId: string;
  lines: string[];
  settings: PoetrySettings;
  prosody?: ProsodyResponse;
  onChange(lines: string[], referenceLine?: number | null): void;
  onSelectionChange(selection: EditorSelection): void;
  onRequestSuggestions(): void;
  onDismissSuggestions(): void;
  onSuggestionNavigate(direction: 1 | -1): void;
  onAcceptSelectedSuggestion(): boolean;
  onStressResult?(success: boolean): void;
  onIssueSelect?(line: number, issueIndex: number): void;
  popupOpen: boolean;
}

const lineDecorationKey = new PluginKey('poemLines');
const normalizeLines = (lines: string[]) => (lines.length ? lines : ['']).flatMap(line => line.replace(/\r\n?/g, '\n').split('\n'));
const documentLines = (doc: ProseMirrorNode) => {
  const lines: string[] = [];
  doc.forEach(node => lines.push(node.textContent));
  return lines.length ? lines : [''];
};
const toDocument = (lines: string[]): JSONContent => ({
  type: 'doc',
  content: normalizeLines(lines).map(text => ({
    type: 'paragraph',
    ...(text ? { content: [{ type: 'text', text }] } : {}),
  })),
});
const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, index) => line === b[index]);

export const PoemEditor = forwardRef<PoemEditorHandle, PoemEditorProps>(function PoemEditor(props, ref) {
  const latest = useRef(props);
  latest.current = props;
  const shellRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const composing = useRef(false);
  const frame = useRef<number | null>(null);
  const lastPublished = useRef(normalizeLines(props.lines));
  const reference = useRef({ poemId: props.poemId, prop: props.settings.referenceLine, current: props.settings.referenceLine, published: props.settings.referenceLine });
  const pendingReference = useRef<number | null | undefined>(undefined);
  const syncingContent = useRef(false);
  if (reference.current.poemId !== props.poemId || reference.current.prop !== props.settings.referenceLine) {
    reference.current = { poemId: props.poemId, prop: props.settings.referenceLine, current: props.settings.referenceLine, published: props.settings.referenceLine };
    pendingReference.current = undefined;
  }
  const shortcutsId = useId();

  const reportSelection = (editor: Editor) => {
    if (editor.isDestroyed || composing.current || editor.view.composing) return;
    const { doc, selection } = editor.state;
    const $from = selection.$from.depth ? selection.$from : doc.resolve(Math.max(1, Math.min(selection.from + 1, doc.content.size - 1)));
    const line = $from.index(0);
    const node = editor.view.nodeDOM($from.before(1));
    const top = node instanceof HTMLElement && shellRef.current
      ? node.getBoundingClientRect().top - shellRef.current.getBoundingClientRect().top
      : line * 48;
    latest.current.onSelectionChange({
      line,
      prefix: $from.parent.textBetween(0, $from.parentOffset, '', ''),
      top,
      left: shellRef.current ? editor.view.coordsAtPos(selection.from).left - shellRef.current.getBoundingClientRect().left : 35,
      bottom: shellRef.current ? editor.view.coordsAtPos(selection.from).bottom - shellRef.current.getBoundingClientRect().top : top + 40,
      focused: editor.isFocused,
    });
  };

  const publish = (editor: Editor) => {
    if (editor.isDestroyed || composing.current || editor.view.composing) return;
    const lines = documentLines(editor.state.doc);
    if (!sameLines(lines, lastPublished.current) || pendingReference.current !== undefined) {
      const remappedReference = pendingReference.current;
      pendingReference.current = undefined;
      if (remappedReference !== undefined) reference.current.published = remappedReference;
      lastPublished.current = lines;
      latest.current.onChange(lines, remappedReference);
    }
    reportSelection(editor);
  };

  const toggleStress = () => {
    const current = editorRef.current;
    if (!current || current.isDestroyed || composing.current || current.view.composing) return false;
    latest.current.onDismissSuggestions();
    const { $from, $to } = current.state.selection;
    if (!$from.parent.isTextblock || !$from.sameParent($to)) return false;
    const edit = createStressEdit($from.parent.textContent, $from.parentOffset, $to.parentOffset);
    if (!edit) return false;
    const start = $from.start();
    const transaction = closeHistory(current.state.tr).insertText(edit.text, start + edit.from, start + edit.to);
    transaction.setSelection(TextSelection.create(transaction.doc, start + edit.caret));
    current.view.dispatch(transaction.scrollIntoView());
    current.view.dispatch(closeHistory(current.state.tr).setMeta('addToHistory', false));
    current.view.focus();
    return true;
  };

  const extensions = useMemo(() => [
    StarterKit.configure({
      blockquote: false, bold: false, bulletList: false, code: false, codeBlock: false,
      gapcursor: false, hardBreak: false, heading: false, horizontalRule: false,
      italic: false, link: false, listItem: false, listKeymap: false,
      orderedList: false, strike: false, underline: false, trailingNode: false,
    }),
    Placeholder.configure({ placeholder: 'Начните с первой строки…', showOnlyCurrent: false }),
    Extension.create({
      name: 'poemLines',
      addProseMirrorPlugins() {
        return [new Plugin({
          key: lineDecorationKey,
          props: {
            decorations(state) {
              const decorations: Decoration[] = [];
              const { scheme, meter, feet, autoStress = true } = latest.current.settings;
              const lines = documentLines(state.doc);
              const referenceLine = reference.current.current;
              state.doc.forEach((node, position, index) => {
                const isBlank = !node.textContent.trim();
                const rhyme = isBlank ? '' : getRhymeLabel(index, scheme, lines) ?? '';
                const active = state.selection.$from.index(0) === index;
                const analysis = analyzeLineProsody(node.textContent, autoStress ? latest.current.prosody?.lines[index] : undefined, meter, feet);
                decorations.push(Decoration.node(position, position + node.nodeSize, {
                  class: `poem-line${active ? ' is-active' : ''}${referenceLine === index ? ' is-reference' : ''}`,
                  'data-line-number': String(index + 1),
                  'data-rhyme': rhyme,
                  'data-syllables': String(analysis.syllables),
                }));
                const contentStart = position + 1;
                for (const stress of analysis.stresses) {
                  decorations.push(Decoration.inline(contentStart + stress.start, contentStart + stress.end, {
                    class: stress.source === 'manual' ? 'poem-stress' : 'auto-stress',
                    ...(stress.source === 'auto' ? { title: 'Автоматическое ударение; можно закрепить вручную' } : {}),
                  }));
                }
                for (const [issueIndex, issue] of analysis.issues.entries()) {
                  if (issue.end > issue.start) decorations.push(Decoration.inline(contentStart + issue.start, contentStart + issue.end, {
                    class: `poem-meter-issue is-${issue.kind}`,
                    'data-line-index': String(index),
                    'data-issue-index': String(issueIndex),
                    title: issue.message,
                  }));
                }
                if (autoStress) for (const word of analysis.unknown) {
                  decorations.push(Decoration.inline(contentStart + word.start, contentStart + word.end, {
                    class: 'poem-stress-unknown',
                    title: 'Не удалось определить ударение; можно поставить вручную',
                  }));
                }
              });
              return DecorationSet.create(state.doc, decorations);
            },
          },
        })];
      },
    }),
  ], []);

  const editor = useEditor({
    extensions,
    content: toDocument(props.lines),
    shouldRerenderOnTransaction: false,
    enableInputRules: false,
    enablePasteRules: false,
    editorProps: {
      attributes: {
        class: 'poem-prose',
        role: 'textbox',
        'aria-label': 'Текст стихотворения',
        'aria-multiline': 'true',
        'aria-describedby': shortcutsId,
        'aria-keyshortcuts': 'Control+Space Meta+Space Control+Shift+U Meta+Shift+U Alt+ArrowDown Alt+ArrowUp Tab Escape',
        lang: 'ru',
        spellcheck: 'true',
      },
      handleKeyDown(view, event) {
        if (event.isComposing || composing.current || view.composing) return false;
        if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.code === 'KeyU') {
          const success = toggleStress();
          latest.current.onStressResult?.(success);
          return true;
        }
        if ((event.metaKey || event.ctrlKey) && (event.code === 'Space' || event.key === ' ')) {
          latest.current.onRequestSuggestions();
          return true;
        }
        if (event.key === 'Escape' && latest.current.popupOpen) {
          latest.current.onDismissSuggestions();
          return true;
        }
        if (event.key === 'Tab' && !event.shiftKey && latest.current.popupOpen) {
          return latest.current.onAcceptSelectedSuggestion();
        }
        if (event.altKey && latest.current.popupOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          latest.current.onSuggestionNavigate(event.key === 'ArrowDown' ? 1 : -1);
          return true;
        }
        if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey) {
          return splitBlock(view.state, view.dispatch);
        }
        return false;
      },
      handlePaste(view, event) {
        const text = event.clipboardData?.getData('text/plain');
        if (text == null) return false;
        const lines = text.replace(/\r\n?/g, '\n').split('\n');
        const nodes = lines.map(line => view.state.schema.nodes.paragraph.create(null, line ? view.state.schema.text(line) : null));
        view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(nodes), 1, 1)).scrollIntoView());
        return true;
      },
      handleDOMEvents: {
        click(_view, event) {
          const issue = event.target instanceof Element ? event.target.closest<HTMLElement>('.poem-meter-issue') : null;
          if (issue) {
            const line = Number(issue.dataset.lineIndex);
            const issueIndex = Number(issue.dataset.issueIndex);
            if (Number.isInteger(line) && line >= 0 && Number.isInteger(issueIndex) && issueIndex >= 0) {
              latest.current.onIssueSelect?.(line, issueIndex);
            }
          }
          return false;
        },
        compositionstart() {
          composing.current = true;
          latest.current.onDismissSuggestions();
          return false;
        },
        compositionend() {
          composing.current = false;
          if (frame.current !== null) cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(() => {
            frame.current = null;
            const current = editorRef.current;
            if (current && !current.isDestroyed) {
              current.view.dispatch(current.state.tr.setMeta(lineDecorationKey, true));
              publish(current);
            }
          });
          return false;
        },
      },
    },
    onCreate: ({ editor }) => {
      editorRef.current = editor;
      lastPublished.current = documentLines(editor.state.doc);
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      reportSelection(editor);
    },
    onTransaction: ({ transaction, appendedTransactions }) => {
      if (syncingContent.current) return;
      for (const change of [transaction, ...appendedTransactions]) {
        reference.current.current = mapReferenceLine(change, reference.current.current);
      }
      pendingReference.current = reference.current.current === reference.current.published ? undefined : reference.current.current;
    },
    onUpdate: ({ editor }) => publish(editor),
    onSelectionUpdate: ({ editor }) => reportSelection(editor),
    onFocus: ({ editor }) => reportSelection(editor),
    onBlur: ({ editor }) => reportSelection(editor),
  }, [props.poemId]);
  editorRef.current = editor;

  useEffect(() => {
    if (!editor || editor.isDestroyed || composing.current) return;
    const next = normalizeLines(props.lines);
    if (!sameLines(next, documentLines(editor.state.doc))) {
      const position = editor.state.selection.from;
      syncingContent.current = true;
      try {
        editor.commands.setContent(toDocument(next), { emitUpdate: false });
        editor.commands.setTextSelection(Math.min(position, editor.state.doc.content.size - 1));
      } finally {
        syncingContent.current = false;
      }
      reference.current.current = props.settings.referenceLine;
      reference.current.published = props.settings.referenceLine;
      pendingReference.current = undefined;
      reportSelection(editor);
    }
    lastPublished.current = next;
  }, [editor, props.lines, props.poemId]);

  useEffect(() => {
    if (editor && !editor.isDestroyed && !composing.current && !editor.view.composing) {
      editor.view.dispatch(editor.state.tr.setMeta(lineDecorationKey, true));
    }
  }, [editor, props.settings.scheme, props.settings.referenceLine, props.settings.meter, props.settings.feet, props.settings.autoStress, props.prosody]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  useImperativeHandle(ref, () => ({
    toggleStress,
    replaceLine(line, expectedText, replacement) {
      const current = editorRef.current;
      if (!current || current.isDestroyed || composing.current || current.view.composing) return false;
      const transaction = replaceOneLine(current.state, line, expectedText, replacement);
      if (!transaction) return false;
      current.view.dispatch(transaction.scrollIntoView());
      current.view.dispatch(closeHistory(current.state.tr).setMeta('addToHistory', false));
      // Dispatch publishes onUpdate synchronously; dismiss afterwards so its debounce stays closed.
      latest.current.onDismissSuggestions();
      current.view.focus();
      return true;
    },
    acceptSuggestion(text) {
      const current = editorRef.current;
      if (!current || current.isDestroyed || composing.current || !current.state.selection.empty) return false;
      const { from, $from } = current.state.selection;
      const prefix = $from.parent.textBetween(0, $from.parentOffset, '', '');
      // Candidates are complete lines. A stale prefix must never replace the author's text.
      if (/[\r\n]/.test(text) || !text.startsWith(prefix)) {
        latest.current.onDismissSuggestions();
        return false;
      }
      const suffix = text.slice(prefix.length);
      if (suffix) {
        const transaction = closeHistory(current.state.tr).insertText(suffix, from);
        transaction.setSelection(TextSelection.create(transaction.doc, from + suffix.length));
        current.view.dispatch(transaction.scrollIntoView());
        current.view.dispatch(closeHistory(current.state.tr).setMeta('addToHistory', false));
      }
      latest.current.onDismissSuggestions();
      current.view.focus();
      return suffix.length > 0;
    },
    focus() { editorRef.current?.commands.focus(); },
    insertStanza() {
      const current = editorRef.current;
      if (!current || current.isDestroyed || composing.current) return;
      const { doc, selection } = current.state;
      const $from = selection.$from.depth ? selection.$from : doc.resolve(1);
      const at = $from.after(1);
      const count = $from.parent.content.size === 0 ? 1 : 2;
      const paragraphs = Array.from({ length: count }, () => current.schema.nodes.paragraph.create());
      const transaction = closeHistory(current.state.tr).insert(at, Fragment.fromArray(paragraphs));
      transaction.setSelection(TextSelection.create(transaction.doc, at + (count - 1) * 2 + 1));
      current.view.dispatch(transaction.scrollIntoView());
      latest.current.onDismissSuggestions();
      current.view.focus();
    },
    undo() { editorRef.current?.chain().focus().undo().run(); },
    redo() { editorRef.current?.chain().focus().redo().run(); },
  }), []);

  return (
    <div className="poem-editor-shell" ref={shellRef}>
      <EditorContent editor={editor} />
      <span id={shortcutsId} className="editor-shortcuts">
        Enter — новая строка. Control или Command и пробел — подсказки.
        Control или Command, Shift и U — поставить или снять ударение у гласной рядом с курсором.
        Alt и стрелки вверх или вниз — выбор подсказки. Tab — принять. Escape — закрыть.
      </span>
    </div>
  );
});

export default PoemEditor;
