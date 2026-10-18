import type { Poem } from '../types.ts';

export const STORAGE_KEY = 'lirica.poems.v1';
export function decodePoems(raw: string): Poem[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every(p => p && typeof p.id === 'string' && p.id.length > 0 && typeof p.title === 'string' && Array.isArray(p.lines) && p.lines.length > 0 && p.lines.every((l: unknown) => typeof l === 'string') && typeof p.favorite === 'boolean' && typeof p.updatedAt === 'string' && Number.isFinite(Date.parse(p.updatedAt)) && p.settings && ['free', 'iamb', 'trochee', 'dactyl', 'amphibrach', 'anapest'].includes(p.settings.meter) && ['ABAB', 'AABB', 'ABBA', 'AAAA', 'free'].includes(p.settings.scheme) && ['exact', 'near', 'loose'].includes(p.settings.precision) && Number.isInteger(p.settings.feet) && p.settings.feet >= 1 && p.settings.feet <= 8 && (p.settings.referenceLine === null || (Number.isInteger(p.settings.referenceLine) && p.settings.referenceLine >= 0)) && typeof p.settings.autoSuggest === 'boolean' && (p.settings.autoStress === undefined || typeof p.settings.autoStress === 'boolean')) || new Set(value.map(p => p.id)).size !== value.length) throw new Error('Повреждённое хранилище стихов');
  return value as Poem[];
}

// Merge per poem so closing an unchanged tab cannot replace newer work in another tab.
export function mergePoems(local: Poem[], saved: Poem[]): Poem[] {
  const savedById = new Map(saved.map(p => [p.id, p]));
  const localIds = new Set(local.map(p => p.id));
  return [...local.map(p => {
    const remote = savedById.get(p.id);
    return remote && Date.parse(remote.updatedAt) > Date.parse(p.updatedAt) ? remote : p;
  }), ...saved.filter(p => !localIds.has(p.id))];
}
export function persistPoems(storage: Pick<Storage, 'getItem' | 'setItem'>, local: Poem[]): Poem[] {
  const raw = storage.getItem(STORAGE_KEY);
  const merged = mergePoems(local, raw ? decodePoems(raw) : []);
  const serialized = JSON.stringify(merged);
  if (raw !== serialized) storage.setItem(STORAGE_KEY, serialized);
  return merged;
}

export function poemsToSave(poems: Poem[], transientDraftId: string): Poem[] {
  return poems.filter(p => p.id !== transientDraftId || p.title.trim() || p.lines.some(line => line.trim()));
}
