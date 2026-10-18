export type Meter = 'free' | 'iamb' | 'trochee' | 'dactyl' | 'amphibrach' | 'anapest';
export type RhymeScheme = 'ABAB' | 'AABB' | 'ABBA' | 'AAAA' | 'free';
export type RhymePrecision = 'exact' | 'near' | 'loose';
export interface PoetrySettings {
  meter: Meter;
  feet: number;
  scheme: RhymeScheme;
  precision: RhymePrecision;
  referenceLine: number | null;
  autoSuggest: boolean;
  autoStress?: boolean;
}
export interface Suggestion { id: string; text: string; rhymeWord: string }
export interface SuggestionResponse {
  suggestions: Suggestion[];
  mode: 'demo' | 'ai';
  referenceLine: number | null;
}
export interface RepairSuggestion { id: string; text: string; accentedText: string; syllables: number }
export interface RepairResponse {
  source: string;
  suggestions: RepairSuggestion[];
  mode: 'ai';
  model: string;
}
export interface Poem {
  id: string;
  title: string;
  lines: string[];
  settings: PoetrySettings;
  updatedAt: string;
  favorite: boolean;
}
export interface EditorSelection { line: number; prefix: string; top: number; left?: number; bottom?: number; focused: boolean }
