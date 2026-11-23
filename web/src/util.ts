import { createContext, useContext } from 'react';
import type { BasePhoto, DB, Item, OutfitPick, OutfitRating, Settings, Slot } from '../../shared/types';
import { DEFAULT_SETTINGS, effectiveTags, formalityLabel } from '../../shared/types';
import { bestRating } from '../../shared/scoring';
import type { OptimizeResult, ScoredOutfit } from '../../shared/optimizer';
import { enumerateOutfits, itemImpact, optimize } from '../../shared/optimizer';

/** Run shared logic defensively — the logic module may still be a stub that throws. */
export function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export const EMPTY_DB: DB = { items: [], bases: [], outfits: {}, pairs: {}, settings: DEFAULT_SETTINGS };

export interface AppCtx {
  db: DB;
  setDb: (fn: (db: DB) => DB) => void;
  refresh: () => Promise<void>;
  toast: (msg: string) => void;
  mock: boolean;
}
export const Ctx = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(Ctx);

export const settingsOf = (db: DB): Settings => ({ ...DEFAULT_SETTINGS, ...(db.settings || {}) });

export const slotOf = (i: Item): Slot | undefined => effectiveTags(i)?.slot;

export const isWearable = (i: Item) => i.status === 'owned' || i.status === 'bought';
export const isOption = (i: Item) => isWearable(i) || i.status === 'candidate';

export const SLOTS: Slot[] = ['top', 'bottom', 'layer', 'shoes', 'belt'];
export const SLOT_LABEL: Record<Slot, string> = { top: 'Top', bottom: 'Bottom', layer: 'Layer', shoes: 'Shoes', belt: 'Belt' };
export const SLOT_PLURAL: Record<Slot, string> = { top: 'Tops', bottom: 'Bottoms', layer: 'Layers', shoes: 'Shoes', belt: 'Belts' };

export const DEFAULT_GARMENT: Record<Slot, NonNullable<Item['tags']>['garmentClass']> = {
  top: 'UPPER_BODY', bottom: 'LONG_PANTS', layer: 'UPPER_BODY', shoes: 'SHOES', belt: 'BELT',
};

export const money = (n?: number) =>
  n == null || Number.isNaN(n) ? '—' : `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;

export const inBand = (f: number | undefined, s: Settings) =>
  f != null && f >= s.formalityMin && f <= s.formalityMax;

export const fmtLabel = (f?: number) => (f == null ? '—' : formalityLabel(f));

export const rating = (db: DB, pick: OutfitPick): OutfitRating | null =>
  pick.top && pick.bottom ? safe(() => bestRating(db, pick), null) : null;

export const optionIds = (db: DB) =>
  db.items.filter(i => isOption(i) && !i.processing && effectiveTags(i)).map(i => i.id);

export const allOutfits = (db: DB, s: Settings): ScoredOutfit[] =>
  safe(() => enumerateOutfits(db, optionIds(db), s), []);

export const runOptimize = (db: DB, s: Settings): OptimizeResult | null => safe(() => optimize(db, s), null);

export const impactOf = (db: DB, id: string, s: Settings) => safe(() => itemImpact(db, id, s), null);

/** Image filename of the active base to render on (neutral if chosen and ready). */
export function activeBase(db: DB): { base?: BasePhoto; file?: string } {
  const s = settingsOf(db);
  const base = db.bases.find(b => b.id === s.activeBaseId) ?? db.bases.find(b => b.studioImage);
  if (!base) return {};
  const file = s.useNeutralBase && base.neutralImage ? base.neutralImage : base.studioImage;
  return { base, file };
}

export function renderFor(db: DB, pick: OutfitPick, outfitId: string): string | undefined {
  const o = db.outfits[outfitId];
  if (!o?.renders) return undefined;
  const { file } = activeBase(db);
  return (file && o.renders[file]) || undefined;
}

export const itemName = (i?: Item) => {
  const t = i && effectiveTags(i);
  if (!t) return 'Item';
  return [t.primaryColor, t.type].filter(Boolean).join(' ');
};

export const byId = (db: DB) => new Map(db.items.map(i => [i.id, i] as const));

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);
