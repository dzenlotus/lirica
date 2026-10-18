import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Copy, CornerDownLeft, Download, Focus, HelpCircle, MoreHorizontal, Plus, RefreshCw, Search, Star, X } from 'lucide-react';
import PoemEditor from './PoemEditor';
import type { PoemEditorHandle } from './PoemEditor';
import type { EditorSelection, Meter, Poem, PoetrySettings, RepairResponse, RepairSuggestion, RhymePrecision, RhymeScheme, SuggestionResponse } from './types';
import { analyzeMeter, countSyllables, getReferenceLine } from './lib/poetry';
import { decodePoems, mergePoems, persistPoems, poemsToSave, STORAGE_KEY } from './lib/storage';
import { METER_EXAMPLES } from './lib/meter-examples';
import { analyzeLineProsody, applyAutomaticStresses, stripAcutes, suggestAlternativeMeter } from './lib/prosody';
import type { ProsodyResponse } from './lib/prosody';
import { SUGGESTION_IDLE_MS, shouldScheduleAutomaticSuggestions } from './lib/suggestion-timing';
import type { SuggestionDraft } from './lib/suggestion-timing';
import { detectMeter } from './lib/detect-meter';
import { detectRhyme } from './lib/detect-rhyme';
import { resolveAutoSettings } from './lib/auto-settings';

const EMPTY_METER_DETECTION = detectMeter([]);
const EMPTY_RHYME_DETECTION = detectRhyme([]);
const DEFAULT_SETTINGS: PoetrySettings = { meter: 'iamb', feet: 5, scheme: 'ABAB', precision: 'exact', referenceLine: null, autoSuggest: true, autoStress: true };
const METERS: { value: Meter; label: string; pattern: string }[] = [
  { value: 'free', label: 'Свободный стих', pattern: 'свой ритм' },
  { value: 'iamb', label: 'Ямб', pattern: '∪ —' },
  { value: 'trochee', label: 'Хорей', pattern: '— ∪' },
  { value: 'dactyl', label: 'Дактиль', pattern: '— ∪ ∪' },
  { value: 'amphibrach', label: 'Амфибрахий', pattern: '∪ — ∪' },
  { value: 'anapest', label: 'Анапест', pattern: '∪ ∪ —' },
];
const SCHEMES: { value: RhymeScheme; label: string }[] = [
  { value: 'ABAB', label: 'Перекрёстная' }, { value: 'AABB', label: 'Парная' },
  { value: 'ABBA', label: 'Кольцевая' }, { value: 'AAAA', label: 'Монорим' }, { value: 'free', label: 'Без схемы' },
];
const PRECISIONS: { value: RhymePrecision; label: string; description: string }[] = [
  { value: 'exact', label: 'Точная', description: 'Близкое совпадение звучания: света — лета' },
  { value: 'near', label: 'Неточная', description: 'Созвучия с небольшими различиями' },
  { value: 'loose', label: 'Свободная', description: 'Ассонансы и неожиданные созвучия' },
];
function makeDraft(): Poem {
  return { id: crypto.randomUUID(), title: '', lines: [''], settings: { ...DEFAULT_SETTINGS }, updatedAt: new Date().toISOString(), favorite: false };
}
function loadPoems(): { poems: Poem[]; draft: Poem; error: boolean } {
  const draft = makeDraft();
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { poems: [draft], draft, error: false };
    return { poems: [draft, ...decodePoems(stored)], draft, error: false };
  } catch { return { poems: [draft], draft, error: true }; }
}
function lastWord(text: string) { return text.match(/[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*/gu)?.at(-1) ?? ''; }
function plural(n: number, one: string, few: string, many: string) { const m = n % 100; return m >= 11 && m <= 14 ? many : n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many; }
function AccentedText({ text }: { text: string }) {
  return <>{text.split(/([аеёиоуыэюя]\u0301|[ёЁ])/giu).map((part, index) => /\u0301|[ёЁ]/u.test(part) ? <strong key={index}>{part}</strong> : part)}</>;
}
function StructureHint({ meter, feet, rhyme, note }: { meter: string; feet: string; rhyme: string; note: string }) {
  return <section className="structure-hint" aria-label="Автоопределение размера и рифмовки" aria-live="polite">
    <dl><div><dt title="Размер — порядок ударных и безударных слогов: например, в ямбе ударение приходится на каждый второй слог.">Размер</dt><dd>{meter}</dd></div><div><dt title="Стопа — один повтор ритмического рисунка. Число стоп показывает, сколько таких повторов в строке.">Стопы</dt><dd>{feet}</dd></div><div><dt title="Одинаковые буквы обозначают рифмующиеся окончания строк: ABAB — через строку, AABB — парами.">Рифмовка</dt><dd>{rhyme}</dd></div></dl>
    {note && <p>{note}</p>}
  </section>;
}

export default function App() {
  const [initial] = useState(loadPoems);
  const [poems, setPoems] = useState(initial.poems);
  const [activeId, setActiveId] = useState(initial.draft.id);
  const [draftId, setDraftId] = useState(initial.draft.id);
  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;
  const poem = poems.find(p => p.id === activeId) ?? poems[0];
  const [selection, setSelection] = useState<EditorSelection>({ line: poem.lines.length - 1, prefix: poem.lines.at(-1) ?? '', top: 0, focused: false });
  const [filter, setFilter] = useState<'all' | 'favorites'>('all');
  const [search, setSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestionResponse | null>(null);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionError, setSuggestionError] = useState('');
  const [prosody, setProsody] = useState<{ poemId: string; signature: string; data: ProsodyResponse } | null>(null);
  const [prosodyState, setProsodyState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [prosodyError, setProsodyError] = useState('');
  const [prosodyRetry, setProsodyRetry] = useState(0);
  const [selectedIssue, setSelectedIssue] = useState<{ line: number; source: string; index: number } | null>(null);
  const [repairs, setRepairs] = useState<{ context: string; status: 'loading' | 'ready' | 'error'; data?: RepairResponse; error?: string } | null>(null);
  const repairAbort = useRef<AbortController | null>(null);
  const [variation, setVariation] = useState(0);
  const [manualRequest, setManualRequest] = useState(0);
  const [suggestionTicket, setSuggestionTicket] = useState<{ context: string; revision: number } | null>(null);
  const [provider, setProvider] = useState<{ mode: 'demo' | 'ai'; model?: string; provider?: string } | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>(initial.error ? 'error' : 'saved');
  const [storageRecovery, setStorageRecovery] = useState(initial.error);
  const [modal, setModal] = useState<'help' | 'settings' | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toast, setToast] = useState('');
  const editor = useRef<PoemEditorHandle>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const poemsRef = useRef(poems);
  poemsRef.current = poems;
  const requestId = useRef(0);
  const prosodyRequestId = useRef(0);
  const autoMeter = poem.settings.autoMeter === true;
  const autoStress = autoMeter || poem.settings.autoStress !== false;
  const prosodySignature = JSON.stringify({ id: poem.id, lines: poem.lines });
  const prosodyContext = JSON.stringify(poem.lines.map(line => stripAcutes(line).normalize('NFC')));
  const currentProsody = autoStress && prosody?.poemId === poem.id && prosody.signature === prosodyContext ? prosody.data : undefined;
  const detectedMeter = useMemo(() => autoMeter ? detectMeter(poem.lines, currentProsody?.lines) : EMPTY_METER_DETECTION, [autoMeter, poem.lines, currentProsody]);
  const detectedRhyme = useMemo(() => autoMeter ? detectRhyme(poem.lines, currentProsody?.lines) : EMPTY_RHYME_DETECTION, [autoMeter, poem.lines, currentProsody]);
  const activeLine = Math.min(selection.line, poem.lines.length - 1);
  const analysisMeter = autoMeter ? detectedMeter.meter ?? 'free' : poem.settings.meter;
  const resolvedSettings = useMemo(() => resolveAutoSettings(poem.settings, detectedMeter, detectedRhyme, poem.lines, activeLine), [poem.settings, detectedMeter, detectedRhyme, poem.lines, activeLine]);
  const autoLineFeet = useMemo(() => autoMeter ? detectedMeter.perLine.map(line => line.meter === detectedMeter.meter ? line.feet : null) : undefined, [autoMeter, detectedMeter]);
  const lineProsodies = useMemo(() => poem.lines.map((line, i) => analyzeLineProsody(line, currentProsody?.lines[i], autoMeter && autoLineFeet?.[i] == null ? 'free' : analysisMeter, autoLineFeet?.[i] ?? resolvedSettings.feet)), [poem.lines, currentProsody, autoMeter, autoLineFeet, analysisMeter, resolvedSettings.feet]);
  const issueCount = lineProsodies.reduce((total, line) => total + line.issues.length, 0);
  const unknownCount = lineProsodies.reduce((total, line) => total + line.unknown.length, 0);
  const exportLines = useMemo(() => poem.lines.map((line, i) => applyAutomaticStresses(line, currentProsody?.lines[i])), [poem.lines, currentProsody]);
  const activeIssues = lineProsodies[activeLine]?.issues ?? [];
  const issueIndex = selectedIssue?.line === activeLine && selectedIssue.source === poem.lines[activeLine] ? Math.min(selectedIssue.index, Math.max(0, activeIssues.length - 1)) : 0;
  const activeIssue = activeIssues[issueIndex];
  const alternativeMeter = useMemo(() => autoMeter ? null : suggestAlternativeMeter(poem.lines[activeLine], currentProsody?.lines[activeLine], poem.settings.meter, poem.settings.feet), [autoMeter, poem.lines, activeLine, currentProsody, poem.settings.meter, poem.settings.feet]);
  const repairContext = JSON.stringify({ id: poem.id, lines: poem.lines, activeLine, settings: resolvedSettings });
  const latestRepairContext = useRef(repairContext);
  latestRepairContext.current = repairContext;
  const currentRepairs = repairs?.context === repairContext ? repairs : null;
  const manualReference = resolvedSettings.referenceLine;
  const effectiveSettings = { ...resolvedSettings, referenceLine: manualReference !== null && manualReference !== activeLine && poem.lines[manualReference]?.trim() ? manualReference : null };
  const requestLines = poem.lines.map((line, index) => index === activeLine ? selection.prefix : line);
  const inputSignature = JSON.stringify({ id: poem.id, lines: requestLines, activeLine, settings: poem.settings });
  const contentSignature = JSON.stringify({ id: poem.id, lines: requestLines, activeLine, settings: effectiveSettings });
  const suggestionTextKey = JSON.stringify(poem.lines.map(stripAcutes));
  const suggestionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestionAbort = useRef<AbortController | null>(null);
  const previousSuggestionDraft = useRef<SuggestionDraft | undefined>(undefined);
  const previousSuggestionContext = useRef<string | undefined>(undefined);
  const previousSuggestionInput = useRef<string | undefined>(undefined);
  const editorEditRevision = useRef(0);
  const dismissedEditRevision = useRef(0);
  const ticketRevision = useRef(0);
  const suggestionContext = useRef({ signature: contentSignature, input: inputSignature, lines: requestLines, activeLine, settings: effectiveSettings, variation });
  suggestionContext.current = { signature: contentSignature, input: inputSignature, lines: requestLines, activeLine, settings: effectiveSettings, variation };
  const referenceLine = getReferenceLine(requestLines, activeLine, effectiveSettings);
  const meter = METERS.find(m => m.value === analysisMeter)!;
  const meterExample = autoMeter && !detectedMeter.meter ? null : METER_EXAMPLES[autoMeter ? detectedMeter.meter! : poem.settings.meter];
  const detectedMeterLabel = detectedMeter.meter ? METERS.find(m => m.value === detectedMeter.meter)!.label : detectedMeter.status === 'mixed' ? 'Нет единого размера' : detectedMeter.status === 'ambiguous' ? 'Неоднозначно' : 'Пока недостаточно текста';
  const detectedFeetLabel = detectedMeter.feet ? String(detectedMeter.feet) : detectedMeter.meter ? detectedMeter.perLine.some(line => line.meter && line.feet === null) ? 'Неоднозначно' : 'Переменное число' : '—';
  const detectedRhymeName = SCHEMES.find(s => s.value === detectedRhyme.scheme)?.label;
  const detectedRhymeLabel = detectedRhyme.scheme ? `${detectedRhyme.scheme}${detectedRhymeName ? ` · ${detectedRhymeName.toLocaleLowerCase('ru')}` : ''}` : detectedRhyme.status === 'mixed' ? 'Нет единой схемы' : detectedRhyme.status === 'partial' ? 'Пока неполная' : 'Пока не определена';
  const structureNote = [
    detectedMeter.analyzedLines < detectedMeter.totalLines && detectedMeter.meter ? `Размер найден по ${detectedMeter.analyzedLines} ${plural(detectedMeter.analyzedLines, 'строке', 'строкам', 'строкам')} из ${detectedMeter.totalLines}.` : '',
    detectedMeter.meter && !detectedMeter.feet && detectedMeter.perLine[activeLine]?.feet ? `Строка ${activeLine + 1}: ${detectedMeter.perLine[activeLine].feet} ${plural(detectedMeter.perLine[activeLine].feet!, 'стопа', 'стопы', 'стоп')}.` : '',
    detectedRhyme.status === 'detected' ? 'Рифмовка определена приблизительно по звучанию окончаний.' : detectedRhyme.status === 'partial' ? 'Рифмовка предварительная: допишите строки или уточните ударения в окончаниях.' : !detectedRhyme.scheme && detectedRhyme.status !== 'mixed' ? 'Для схемы рифмовки нужны хотя бы четыре строки с понятными ударениями в окончаниях.' : '',
  ].filter(Boolean).join(' ');

  const notify = useCallback((message: string) => setToast(message), []);
  const cancelSuggestionWork = useCallback(() => {
    if (suggestionTimer.current !== null) clearTimeout(suggestionTimer.current);
    suggestionTimer.current = null;
    suggestionAbort.current?.abort();
    suggestionAbort.current = null;
    requestId.current++;
    setSuggestionTicket(null);
    setPopupOpen(false);
    setSuggestions(null);
    setSelectedSuggestion(0);
    setSuggestionError('');
    setSuggesting(false);
  }, []);
  const dismissSuggestions = useCallback(() => {
    dismissedEditRevision.current = editorEditRevision.current;
    cancelSuggestionWork();
  }, [cancelSuggestionWork]);
  const updatePoem = useCallback((patch: Partial<Poem>) => {
    setSaveState('saving');
    setPoems(current => current.map(p => p.id === activeId ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p));
  }, [activeId]);
  const setSettings = (patch: Partial<PoetrySettings>) => {
    const refresh = popupOpen && Object.keys(patch).some(key => ['meter', 'feet', 'scheme', 'precision', 'referenceLine', 'autoMeter'].includes(key));
    if (refresh) cancelSuggestionWork();
    updatePoem({ settings: { ...poem.settings, ...patch } });
    if (refresh) setManualRequest(n => n + 1);
  };
  const openPoem = (id: string) => {
    const next = poems.find(p => p.id === id)!;
    setActiveId(id);
    setSelection({ line: next.lines.length - 1, prefix: next.lines.at(-1) ?? '', top: 0, focused: false });
    setSuggestions(null); setSuggestionError(''); dismissSuggestions(); setSidebarOpen(false); setMoreOpen(false);
  };
  const createPoem = useCallback(() => {
    const next = makeDraft();
    const previousDraftId = draftIdRef.current;
    draftIdRef.current = next.id;
    setPoems(current => [next, ...poemsToSave(current, previousDraftId)]); setDraftId(next.id); setActiveId(next.id);
    setSelection({ line: 0, prefix: '', top: 0, focused: false });
    setSuggestions(null); setSuggestionError(''); dismissSuggestions(); setSidebarOpen(false); setFilter('all'); setSearch(''); setSaveState('saving');
    requestAnimationFrame(() => document.getElementById('poem-title')?.focus());
  }, [dismissSuggestions]);

  useEffect(() => {
    if (storageRecovery) return;
    const timer = window.setTimeout(() => {
      try {
        const merged = persistPoems(localStorage, poemsToSave(poemsRef.current, draftIdRef.current));
        setPoems(current => { const next = mergePoems(current, merged); return JSON.stringify(current) === JSON.stringify(next) ? current : next; });
        if (draftIdRef.current && merged.some(p => p.id === draftIdRef.current)) { draftIdRef.current = ''; setDraftId(''); }
        setSaveState('saved');
      }
      catch { setSaveState('error'); }
    }, 350);
    return () => clearTimeout(timer);
  }, [poems, draftId, storageRecovery]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/config', { signal: controller.signal }).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(setProvider).catch(e => { if (e.name !== 'AbortError') setProvider(null); });
    return () => controller.abort();
  }, []);
  // Selection changes invalidate old work; they never schedule a generation.
  useEffect(() => {
    const changed = previousSuggestionInput.current !== undefined && previousSuggestionInput.current !== inputSignature;
    const inferredChanged = previousSuggestionContext.current !== undefined && previousSuggestionContext.current !== contentSignature;
    previousSuggestionInput.current = inputSignature;
    previousSuggestionContext.current = contentSignature;
    if (changed || (!selection.focused && suggestionTimer.current !== null)) { cancelSuggestionWork(); return; }
    if (inferredChanged && popupOpen) {
      cancelSuggestionWork();
      setPopupOpen(true);
      setSuggesting(true);
      setSuggestionTicket({ context: contentSignature, revision: ++ticketRevision.current });
    }
  }, [inputSignature, contentSignature, selection.focused, popupOpen, cancelSuggestionWork]);
  useEffect(() => {
    const previous = previousSuggestionDraft.current;
    const next = { poemId: poem.id, textKey: suggestionTextKey, editRevision: editorEditRevision.current };
    previousSuggestionDraft.current = next;
    if (!shouldScheduleAutomaticSuggestions(previous, { ...next, enabled: poem.settings.autoSuggest, focused: selection.focused, hasText: poem.lines.some(line => line.trim()), editRevision: editorEditRevision.current, dismissedRevision: dismissedEditRevision.current })) return;
    cancelSuggestionWork();
    const context = inputSignature;
    suggestionTimer.current = setTimeout(() => {
      suggestionTimer.current = null;
      if (suggestionContext.current.input !== context) return;
      setPopupOpen(true);
      setSuggesting(true);
      setSuggestionTicket({ context: suggestionContext.current.signature, revision: ++ticketRevision.current });
    }, SUGGESTION_IDLE_MS);
    return () => { if (suggestionTimer.current !== null) clearTimeout(suggestionTimer.current); suggestionTimer.current = null; };
  }, [poem.id, suggestionTextKey, poem.settings.autoSuggest, cancelSuggestionWork]);
  useEffect(() => {
    if (manualRequest === 0) return;
    cancelSuggestionWork();
    setPopupOpen(true);
    setSuggesting(true);
    setSuggestionTicket({ context: suggestionContext.current.signature, revision: ++ticketRevision.current });
  }, [manualRequest, cancelSuggestionWork]);
  useEffect(() => {
    const id = ++requestId.current;
    if (!suggestionTicket || suggestionTicket.context !== contentSignature || !requestLines.some(line => line.trim())) { setSuggesting(false); return; }
    const controller = new AbortController();
    suggestionAbort.current = controller;
    const { lines, activeLine, settings, variation } = suggestionContext.current;
    setSuggesting(true);
    setSuggestionError('');
    void (async () => {
      try {
        const response = await fetch('/api/suggestions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines, activeLine, settings, variation }), signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Не удалось получить подсказки. Попробуйте ещё раз.');
        if (!Array.isArray(data.suggestions) || data.suggestions.length !== 10) throw new Error('Не удалось получить десять вариантов. Попробуйте ещё раз.');
        if (id === requestId.current && !controller.signal.aborted) { setSuggestions(data); setSelectedSuggestion(0); }
      } catch (error) {
        if (id === requestId.current && !controller.signal.aborted) setSuggestionError(error instanceof Error ? error.message : 'Сервис подсказок недоступен.');
      } finally { if (id === requestId.current && !controller.signal.aborted) setSuggesting(false); }
    })();
    return () => { controller.abort(); if (suggestionAbort.current === controller) suggestionAbort.current = null; };
  }, [suggestionTicket, contentSignature]);
  useEffect(() => () => { if (suggestionTimer.current !== null) clearTimeout(suggestionTimer.current); suggestionAbort.current?.abort(); }, []);
  useEffect(() => {
    repairAbort.current?.abort();
    repairAbort.current = null;
    setRepairs(null);
    return () => repairAbort.current?.abort();
  }, [repairContext]);
  useEffect(() => {
    const id = ++prosodyRequestId.current;
    const controller = new AbortController();
    setProsodyError('');
    if (!autoStress || !poem.lines.some(line => line.trim())) {
      setProsodyState('idle');
      return () => controller.abort();
    }
    setProsodyState('loading');
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/prosody', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: poem.lines }), signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Не удалось определить ударения.');
        if (data.mode !== 'ai' || !Array.isArray(data.lines) || data.lines.length !== poem.lines.length || !data.lines.every((line: { text?: unknown; words?: unknown }) => typeof line.text === 'string' && Array.isArray(line.words))) throw new Error('Сервис вернул неполный анализ ударений.');
        if (id === prosodyRequestId.current && !controller.signal.aborted) {
          setProsody({ poemId: poem.id, signature: prosodyContext, data });
          setProsodyState('ready');
        }
      } catch (error) {
        if (id === prosodyRequestId.current && !controller.signal.aborted) {
          setProsodyError(error instanceof TypeError ? 'Сервис ударений недоступен. Попробуйте ещё раз.' : error instanceof Error ? error.message : 'Не удалось определить ударения.');
          setProsodyState('error');
        }
      }
    }, 900);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [prosodySignature, autoStress, prosodyRetry]);
  useEffect(() => {
    if (storageRecovery) return;
    const flush = () => { try { persistPoems(localStorage, poemsToSave(poemsRef.current, draftIdRef.current)); } catch { /* Preserve the original storage and offer text export. */ } };
    const sync = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try { const incoming = decodePoems(event.newValue); setPoems(current => { const merged = mergePoems(current, incoming); return JSON.stringify(merged) === JSON.stringify(current) ? current : merged; }); } catch { setSaveState('error'); }
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener('pagehide', flush); window.removeEventListener('storage', sync); };
  }, [storageRecovery]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = modalRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button, input, select, a[href], [tabindex="0"]') ?? []).filter(el => !el.hasAttribute('disabled'));
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const targets = focusable(); const first = targets[0]; const last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [modal]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (showSearch) searchInput.current?.focus(); }, [showSearch]);
  useEffect(() => {
    document.querySelector<HTMLElement>('.suggestion-option.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selectedSuggestion]);
  useEffect(() => {
    if (!sidebarOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    searchInput.current?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const targets = Array.from(document.querySelectorAll<HTMLElement>('.library button, .library input'));
      const first = targets[0], last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [sidebarOpen]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (modal && event.key !== 'Escape') return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setShowSearch(true); setSidebarOpen(true); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); createPoem(); }
      if (event.key === 'Escape') { setModal(null); setMoreOpen(false); setSidebarOpen(false); setFocusMode(false); dismissSuggestions(); }
    };
    document.addEventListener('keydown', keydown); return () => document.removeEventListener('keydown', keydown);
  }, [createPoem, modal, dismissSuggestions]);

  function requestSuggestions() { cancelSuggestionWork(); setManualRequest(n => n + 1); setVariation(n => n + 1); }
  async function requestRepairs() {
    if (!activeIssue) return;
    dismissSuggestions();
    repairAbort.current?.abort();
    const controller = new AbortController();
    repairAbort.current = controller;
    const context = repairContext;
    setRepairs({ context, status: 'loading' });
    try {
      const response = await fetch('/api/repairs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: poem.lines, activeLine, settings: resolvedSettings }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Не удалось подобрать исправления. Попробуйте ещё раз.');
      if (data.mode !== 'ai' || data.source !== poem.lines[activeLine] || !Array.isArray(data.suggestions) || data.suggestions.length < 1 || data.suggestions.length > 3 || !data.suggestions.every((item: RepairSuggestion) => typeof item.id === 'string' && typeof item.text === 'string' && typeof item.accentedText === 'string' && Number.isInteger(item.syllables))) throw new Error('Сервис вернул некорректные исправления. Попробуйте ещё раз.');
      if (!controller.signal.aborted && latestRepairContext.current === context) setRepairs({ context, status: 'ready', data });
    } catch (error) {
      if (!controller.signal.aborted && latestRepairContext.current === context) setRepairs({ context, status: 'error', error: error instanceof TypeError ? 'Сервис исправлений недоступен. Попробуйте ещё раз.' : error instanceof Error ? error.message : 'Не удалось подобрать исправления.' });
    } finally { if (repairAbort.current === controller) repairAbort.current = null; }
  }
  function applyRepair(candidate: RepairSuggestion) {
    if (currentRepairs?.status !== 'ready' || !currentRepairs.data || latestRepairContext.current !== currentRepairs.context) return;
    if (!editor.current?.replaceLine(activeLine, currentRepairs.data.source, candidate.text)) { setRepairs(null); notify('Строка изменилась. Запросите новые исправления.'); return; }
    setRepairs(null);
    dismissSuggestions();
    notify(`Строка ${activeLine + 1} заменена. ⌘/Ctrl+Z — отменить`);
  }
  function acceptSuggestion(index: number) {
    const candidate = suggestions?.suggestions[index];
    if (!candidate || suggesting || !candidate.text.startsWith(selection.prefix)) return false;
    if (!editor.current?.acceptSuggestion(candidate.text)) return false;
    dismissSuggestions(); return true;
  }
  function exportPoem() {
    const text = `${poem.title || 'Без названия'}\n\n${exportLines.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${(poem.title || 'Без названия').replace(/[/\\?%*:|"<>]/g, '-')}.txt`; anchor.click(); URL.revokeObjectURL(url); setMoreOpen(false); notify('Стихотворение скачано');
  }
  const visiblePoems = poemsToSave(poems, draftId).filter(p => (filter === 'all' || p.favorite) && `${p.title} ${p.lines.join(' ')}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')));

  return <div className={`app ${focusMode ? 'is-focused' : ''}`}>
    {sidebarOpen && <>
      <button className="library-scrim" aria-label="Закрыть библиотеку" onClick={() => setSidebarOpen(false)} />
      <aside className="library" role="dialog" aria-modal="true" aria-label="Стихи">
        <div className="library-header"><h2>Стихи</h2><button className="new-poem" onClick={createPoem}><Plus size={15}/>Новый</button><button className="icon-button" aria-label="Закрыть библиотеку" onClick={() => setSidebarOpen(false)}><X size={17}/></button></div>
        <div className="search-field"><Search size={15}/><input ref={searchInput} value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск" aria-label="Поиск стихотворений"/></div>
        <nav className="library-nav" aria-label="Фильтр стихов"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Все</button><button className={filter === 'favorites' ? 'active' : ''} onClick={() => setFilter('favorites')}>Избранное</button></nav>
        <div className="poem-list">{visiblePoems.map(p => <button key={p.id} className={`poem-item ${p.id === poem.id ? 'selected' : ''}`} onClick={() => openPoem(p.id)}><span className="poem-item-title">{p.title || 'Без названия'}{p.favorite && <Star size={11} fill="currentColor"/>}</span><span className="poem-excerpt">{p.lines.find(l => l.trim()) || 'Пустой черновик'}</span></button>)}{!visiblePoems.length && <p className="library-empty">Ничего не найдено</p>}</div>
      </aside>
    </>}
    <div className="workspace" inert={sidebarOpen ? true : undefined}>
      <header className="topbar">
        <div className="topbar-left"><button className="brand" onClick={createPoem} aria-label="Новый стих">лирика</button><span className="header-separator"/><button className="library-toggle" aria-label="Открыть библиотеку" aria-expanded={sidebarOpen} onClick={() => { dismissSuggestions(); setMoreOpen(false); setSidebarOpen(true); }}>Стихи<ChevronDown size={13}/></button></div>
        <div className="topbar-right"><span className={`save-status ${saveState === 'error' || storageRecovery ? 'has-error' : ''}`} role="status">{!storageRecovery && saveState === 'saving' ? 'Сохраняем…' : storageRecovery || saveState === 'error' ? 'Не сохранено' : 'Сохранено'}</span>{focusMode && <button className="exit-focus" onClick={() => setFocusMode(false)}>Выйти из фокуса</button>}<div className="more-container"><button className="icon-button" aria-label="Действия со стихотворением" aria-expanded={moreOpen} onClick={() => { dismissSuggestions(); setMoreOpen(v => !v); }}><MoreHorizontal size={20}/></button>{moreOpen && <><button className="menu-scrim" aria-label="Закрыть меню" onClick={() => setMoreOpen(false)}/><div className="more-menu"><button onClick={exportPoem}><Download size={15}/>Скачать .txt</button><button onClick={() => { navigator.clipboard.writeText(`${poem.title}\n\n${exportLines.join('\n')}`).then(() => notify('Скопировано')).catch(() => notify('Не удалось скопировать текст')); setMoreOpen(false); }}><Copy size={15}/>Копировать</button><button onClick={() => { updatePoem({ favorite: !poem.favorite }); setMoreOpen(false); }}><Star size={15}/>{poem.favorite ? 'Убрать из избранного' : 'В избранное'}</button><button onClick={() => { const copy = { ...poem, id: crypto.randomUUID(), title: `${poem.title || 'Без названия'} — копия`, updatedAt: new Date().toISOString() }; setPoems(current => [copy, ...current]); setActiveId(copy.id); setMoreOpen(false); dismissSuggestions(); }}><Plus size={15}/>Создать копию</button><span className="menu-divider"/><button onClick={() => { setFocusMode(v => !v); setMoreOpen(false); dismissSuggestions(); }}><Focus size={15}/>{focusMode ? 'Выйти из фокуса' : 'Режим фокуса'}</button><button onClick={() => { setModal('help'); setMoreOpen(false); }}><HelpCircle size={15}/>Клавиатура и справка</button></div></>}</div></div>
      </header>
      {(saveState === 'error' || storageRecovery) && <div className="storage-warning" role="alert">{storageRecovery ? 'Не удалось прочитать сохранённые стихи. Исходные данные сохранены в браузере.' : 'Не удалось сохранить изменения.'}<button onClick={exportPoem}>Скачать текст</button>{storageRecovery && <button onClick={() => { try { localStorage.removeItem(STORAGE_KEY); setStorageRecovery(false); } catch { notify('Хранилище браузера недоступно'); } }}>Начать новое хранилище</button>}</div>}
      <main className="main-content">
        <input id="poem-title" className="poem-title" aria-label="Название стихотворения" placeholder="Без названия" value={poem.title} onFocus={() => dismissSuggestions()} onChange={e => updatePoem({ title: e.target.value })}/>
        <div className="document-toolbar"><button className="configuration-button" aria-label="Настройки рифмы и размера" onClick={() => { setModal('settings'); dismissSuggestions(); }}>{autoMeter ? 'Автоопределение' : <>{meter.label}{poem.settings.meter !== 'free' && <> · {poem.settings.feet} {plural(poem.settings.feet, 'стопа', 'стопы', 'стоп')}</>}<span>·</span>{poem.settings.scheme === 'free' ? 'Без схемы' : poem.settings.scheme}</>}<ChevronDown size={12}/></button><div className="writing-actions"><button className="stress-button" title="Выделите гласную или поставьте курсор после неё. ⌘/Ctrl+Shift+U" aria-label="Поставить или снять ударение" onMouseDown={e => e.preventDefault()} onClick={() => { if (!editor.current?.toggleStress()) notify('Выделите гласную или поставьте курсор сразу после неё. Ё уже под ударением.'); }}><span aria-hidden="true">а́</span>Ударение</button><button className={`rhyme-toggle ${popupOpen ? 'active' : ''}`} aria-pressed={popupOpen} onClick={() => popupOpen ? dismissSuggestions() : requestSuggestions()}>Рифмы<ChevronDown size={12}/></button></div></div>
        <div className="writing-area">
          <section className="poetry-column" aria-label="Стихотворение"><PoemEditor key={poem.id} ref={editor} poemId={poem.id} lines={poem.lines} settings={{ ...resolvedSettings, meter: analysisMeter, referenceLine: poem.settings.referenceLine }} prosody={currentProsody} lineFeet={autoLineFeet} rhymeLabels={autoMeter ? detectedRhyme.labels : undefined} onChange={(lines, mappedReference) => { editorEditRevision.current++; updatePoem({ lines, ...(mappedReference !== undefined ? { settings: { ...poem.settings, referenceLine: mappedReference } } : {}) }); }} onSelectionChange={setSelection} onIssueSelect={(line, index) => { dismissSuggestions(); setSelectedIssue({ line, source: poem.lines[line], index }); }} onStressResult={success => { if (!success) notify('Выделите гласную или поставьте курсор сразу после неё. Ё уже под ударением.'); }} onRequestSuggestions={requestSuggestions} onDismissSuggestions={() => dismissSuggestions()} onSuggestionNavigate={direction => setSelectedSuggestion(current => (current + direction + 10) % 10)} onAcceptSelectedSuggestion={() => acceptSuggestion(selectedSuggestion)} popupOpen={popupOpen}/></section>
          {popupOpen && <aside className="suggestion-popover" style={{ top: (selection.bottom ?? selection.top + 40) + 8, left: Math.max(0, Math.min(selection.left ?? 35, 280)) }} aria-label="Продолжения строки">
            <div className="suggestion-header"><h2>Продолжения</h2><select aria-label="Рифмовать со строкой" value={poem.settings.referenceLine === null || poem.settings.referenceLine === activeLine ? 'auto' : poem.settings.referenceLine} onChange={e => setSettings({ referenceLine: e.target.value === 'auto' ? null : Number(e.target.value) })}><option value="auto">{referenceLine !== null ? `К «${lastWord(poem.lines[referenceLine])}» · авто` : 'Без опоры · авто'}</option>{poem.lines.map((line, i) => i !== activeLine && line.trim() ? <option key={i} value={i}>{i + 1} · {lastWord(line)}</option> : null)}</select><button className="icon-button" aria-label="Скрыть подсказки" onClick={() => dismissSuggestions()}><X size={14}/></button></div>
            <div className="suggestion-body" aria-live="polite" aria-busy={suggesting}>{suggesting ? <p className="suggestion-message">Подбор продолжений<span className="loading-dots">…</span></p> : suggestionError ? <div className="suggestion-message error-state"><p>{suggestionError}</p><button onClick={requestSuggestions}>Повторить</button></div> : suggestions ? <div className="suggestion-options" role="listbox" aria-label="Варианты продолжения">{suggestions.suggestions.map((s, i) => <button key={s.id} role="option" aria-selected={i === selectedSuggestion} className={`suggestion-option ${i === selectedSuggestion ? 'selected' : ''}`} onMouseDown={e => e.preventDefault()} onMouseEnter={() => setSelectedSuggestion(i)} onClick={() => acceptSuggestion(i)}><span className="suggestion-number">{i + 1}</span><span className="suggestion-text"><span className="suggestion-prefix">{selection.prefix}</span>{s.text.slice(selection.prefix.length)}</span>{i === selectedSuggestion && <CornerDownLeft size={13} className="insert-arrow"/>}</button>)}</div> : <p className="suggestion-message">{poem.settings.autoSuggest ? 'Введите начало строки' : 'Автоматические подсказки выключены'}</p>}</div>
            <div className="suggestion-footer"><span><kbd>tab</kbd> вставить</span><button aria-label="Ещё десять вариантов" disabled={suggesting || !requestLines.some(l => l.trim())} onClick={requestSuggestions}><RefreshCw size={12}/>Ещё 10</button></div>
          </aside>}
        </div>
        {autoMeter && <StructureHint meter={detectedMeterLabel} feet={detectedFeetLabel} rhyme={detectedRhymeLabel} note={structureNote}/>}
        <div className="prosody-status" role="status" aria-live="polite">{poem.lines.some(line => line.trim()) && (autoStress && prosodyState === 'loading' ? 'Определяю ударения…' : autoStress && prosodyState === 'error' ? <><span>{prosodyError}</span><button onClick={() => setProsodyRetry(n => n + 1)}>Повторить анализ</button></> : !activeIssue && issueCount ? `${issueCount} ${plural(issueCount, 'отклонение', 'отклонения', 'отклонений')} от размера. Выберите строку с подчёркиванием, чтобы увидеть рекомендации.` : autoStress && unknownCount ? 'Неуверенные ударения отмечены пунктиром. Их можно поставить вручную.' : null)}</div>
        {activeIssue && <section className="rhythm-guidance" aria-label={`Исправление ритма строки ${activeLine + 1}`}>
          <div className="rhythm-heading"><span>Строка {activeLine + 1}</span>{activeIssues.length > 1 && <div className="issue-navigation"><button className="icon-button" aria-label="Предыдущее отклонение" onClick={() => setSelectedIssue({ line: activeLine, source: poem.lines[activeLine], index: (issueIndex + activeIssues.length - 1) % activeIssues.length })}><ChevronLeft size={14}/></button><span aria-live="polite">{issueIndex + 1} / {activeIssues.length}</span><button className="icon-button" aria-label="Следующее отклонение" onClick={() => setSelectedIssue({ line: activeLine, source: poem.lines[activeLine], index: (issueIndex + 1) % activeIssues.length })}><ChevronRight size={14}/></button></div>}</div>
          <p className="rhythm-explanation"><AccentedText text={activeIssue.message}/></p>
          <p className="rhythm-recommendation">{activeIssue.recommendation}</p>
          <div className="rhythm-actions"><button className="repair-request" disabled={currentRepairs?.status === 'loading'} onClick={requestRepairs}>{currentRepairs?.status === 'loading' ? 'Подбираю исправления…' : currentRepairs?.status === 'ready' ? 'Другие исправления' : 'Предложить исправления'}</button>{alternativeMeter && <button className="alternative-meter" onClick={() => { dismissSuggestions(); setSettings({ meter: alternativeMeter.meter, feet: alternativeMeter.feet, autoMeter: false }); }}>Выбрать «{alternativeMeter.label}» для всего стиха</button>}</div>
          <div className="repair-results" aria-live="polite" aria-busy={currentRepairs?.status === 'loading'}>{currentRepairs?.status === 'error' ? <p className="repair-error" role="alert">{currentRepairs.error}</p> : currentRepairs?.status === 'ready' && currentRepairs.data && <><p className="repair-caption">Варианты под выбранный размер. Сравните смысл перед заменой.</p><ul className="repair-options">{currentRepairs.data.suggestions.map((candidate, index) => <li key={candidate.id}><div><p><AccentedText text={candidate.accentedText}/></p><span>{candidate.syllables} {plural(candidate.syllables, 'слог', 'слога', 'слогов')} · {meter.label.toLocaleLowerCase('ru')}, {resolvedSettings.feet} {plural(resolvedSettings.feet, 'стопа', 'стопы', 'стоп')}</span></div><button aria-label={`Применить исправление ${index + 1}`} onClick={() => applyRepair(candidate)}>Применить</button></li>)}</ul></>}</div>
        </section>}
      </main>
    </div>
    {toast && <div className="toast" role="status">{toast}</div>}
    {modal && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setModal(null); }}><div ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-header"><h2 id="modal-title">{modal === 'help' ? 'Клавиатура и справка' : 'Рифма и размер'}</h2><button className="icon-button" aria-label="Закрыть окно" onClick={() => setModal(null)}><X size={18}/></button></div>{modal === 'help' ? <><div className="shortcut-row"><span>Новая строка</span><kbd>enter</kbd></div><div className="shortcut-row"><span>Запросить продолжения</span><kbd>⌘ / ctrl + пробел</kbd></div><div className="shortcut-row"><span>Выбрать вариант</span><kbd>alt + ↑ / ↓</kbd></div><div className="shortcut-row"><span>Вставить выбранный вариант</span><kbd>tab</kbd></div><div className="shortcut-row"><span>Закрыть подсказки</span><kbd>esc</kbd></div><div className="shortcut-row"><span>Поставить / снять ударение</span><kbd>⌘ / ctrl + shift + U</kbd></div><p className="modal-note">Выделите гласную или поставьте курсор сразу после неё. Ё уже под ударением.</p><p className="modal-note">Пустая строка отделяет строфы. Подсказка дописывает текст от курсора. Стихи хранятся в этом браузере; скачать текст можно через меню ···.</p><p className="modal-note">Выберите «Автоопределение» в размере, чтобы увидеть найденные размер, число стоп и рифмовку. Стопа — один повтор рисунка ударений; одинаковые буквы схемы обозначают рифмующиеся строки. При коротком тексте вывод предварительный.</p><p className="modal-note">Нажмите на подчёркнутое слово, чтобы увидеть объяснение и рекомендации. «Предложить исправления» подбирает замены выбранной строки; «Применить» вставляет выбранный вариант. ⌘/Ctrl+Z отменяет замену.</p><p className="modal-note">Автоматические ударения определяются по контексту. Ручная отметка закрепляет ударение во всём слове. Пропуски ударений в сильных долях и обычные окончания строк допускаются.</p></> : <><label className="setting-row"><span>Размер</span><select aria-label="Стихотворный размер" value={autoMeter ? 'auto' : poem.settings.meter} onChange={e => setSettings(e.target.value === 'auto' ? { autoMeter: true, autoStress: true } : { meter: e.target.value as Meter, autoMeter: false })}><option value="auto">Автоопределение</option>{METERS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>{autoMeter && <StructureHint meter={detectedMeterLabel} feet={detectedFeetLabel} rhyme={detectedRhymeLabel} note={structureNote}/>} {meterExample && <figure className="meter-example" aria-label={`Пример: ${meter.label.toLocaleLowerCase('ru')}`}><blockquote>{meterExample.accentedText.split(/([аеёиоуыэюя]\u0301|[ёЁ])/giu).map((part, index) => /\u0301|[ёЁ]/u.test(part) ? <strong key={index}>{part}</strong> : part)}</blockquote><figcaption><a href={meterExample.source} target="_blank" rel="noreferrer">{meterExample.author}, «{meterExample.title}»</a><span>{meter.label}{meterExample.feet !== null && <> · {meterExample.feet} {plural(meterExample.feet, 'стопа', 'стопы', 'стоп')}</>}</span></figcaption>{analysisMeter !== 'free' && <div className="meter-pattern" aria-label={`Схема: ${meter.label}`}><span className="pattern-feet">{Array.from({ length: meterExample.feet ?? 1 }, (_, index) => <span key={index}>{meter.pattern.split(' ').map((beat, i) => beat === '—' ? <strong key={i}>—</strong> : <span key={i}>∪</span>)}</span>)}</span><small>— ударный · ∪ безударный</small></div>}</figure>}{!autoMeter && poem.settings.meter !== 'free' && <label className="setting-row"><span>Стопы</span><select aria-label="Количество стоп" value={poem.settings.feet} onChange={e => setSettings({ feet: Number(e.target.value) })}>{[1, 2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n}</option>)}</select></label>}{!autoMeter && <label className="setting-row"><span>Рифмовка</span><select aria-label="Схема рифмовки" value={poem.settings.scheme} onChange={e => setSettings({ scheme: e.target.value as RhymeScheme, referenceLine: null })}>{SCHEMES.map(s => <option key={s.value} value={s.value}>{s.value === 'free' ? s.label : `${s.value} · ${s.label}`}</option>)}</select></label>}<label className="setting-row"><span>Точность рифмы</span><select aria-label="Точность рифмы" value={poem.settings.precision} onChange={e => setSettings({ precision: e.target.value as RhymePrecision })}>{PRECISIONS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label><label className="setting-row automatic-setting"><span>Автоматические ударения</span><input type="checkbox" role="switch" checked={autoStress} disabled={autoMeter} onChange={e => setSettings({ autoStress: e.target.checked })}/></label><p className="modal-note">{autoMeter && 'Автоопределение использует словесные ударения. '}Ручные ударения имеют приоритет. Волнистая линия отмечает отклонение от размера; пунктир — неуверенное произношение.</p><label className="setting-row automatic-setting"><span>Подсказки при наборе</span><input type="checkbox" role="switch" checked={poem.settings.autoSuggest} onChange={e => { setSettings({ autoSuggest: e.target.checked }); dismissSuggestions(); }}/></label><p className="modal-note">Строка {activeLine + 1}: {countSyllables(poem.lines[activeLine] ?? '')} {plural(countSyllables(poem.lines[activeLine] ?? ''), 'слог', 'слога', 'слогов')}{resolvedSettings.meter !== 'free' && <> из ~{analyzeMeter(poem.lines[activeLine] ?? '', resolvedSettings.meter, resolvedSettings.feet).expected}</>}.</p><p className="modal-note provider-info">{provider?.mode === 'ai' ? `${provider.provider || 'ChatMock'} · ${provider.model || 'gpt-6-luna'}` : provider?.mode === 'demo' ? 'Деморежим без нейросети' : 'Сервис генерации недоступен'}. Для подсказок отправляется только текущий стих.</p></>}</div></div>}
  </div>;
}
