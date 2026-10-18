export const SUGGESTION_IDLE_MS = 1_500;
export interface SuggestionDraft { poemId: string; textKey: string; editRevision: number }
export interface AutomaticSuggestionState extends SuggestionDraft {
  enabled: boolean;
  focused: boolean;
  hasText: boolean;
  dismissedRevision: number;
}
export function shouldScheduleAutomaticSuggestions(previous: SuggestionDraft | undefined, next: AutomaticSuggestionState): boolean {
  return !!previous && previous.poemId === next.poemId && previous.textKey !== next.textKey
    && next.editRevision > previous.editRevision && next.enabled && next.focused && next.hasText && next.editRevision > next.dismissedRevision;
}
