// THE contract between server, web, and shared logic. Change only with care.

export type Slot = 'top' | 'bottom' | 'layer' | 'shoes' | 'belt';

/** Nova Canvas garmentBasedMask.garmentClass values we use. */
export type GarmentClass =
  | 'UPPER_BODY' | 'LOWER_BODY' | 'FULL_BODY' | 'FOOTWEAR'
  | 'LONG_SLEEVE_SHIRT' | 'SHORT_SLEEVE_SHIRT' | 'NO_SLEEVE_SHIRT' | 'OTHER_UPPER_BODY'
  | 'LONG_PANTS' | 'SHORT_PANTS' | 'OTHER_LOWER_BODY'
  | 'SHOES' | 'BOOTS' | 'OTHER_FOOTWEAR'
  | 'BELT';

export type Pattern = 'solid' | 'stripe' | 'check' | 'plaid' | 'print' | 'texture' | 'other';

export interface ItemTags {
  slot: Slot;
  garmentClass: GarmentClass;
  type: string;            // e.g. "oxford button-down", "chinos", "chelsea boots", "crewneck sweater"
  primaryColor: string;    // plain color name, e.g. "navy"
  primaryHex: string;      // "#1f2a44"
  secondaryColors: string[];
  pattern: Pattern;
  material?: string;
  formality: number;       // 1–10, see SPEC scale
  seasons?: ('spring' | 'summer' | 'fall' | 'winter')[];
  notes?: string;          // short AI description
}

export type ItemStatus = 'owned' | 'candidate' | 'rejected' | 'bought';

export interface Item {
  id: string;
  status: ItemStatus;
  createdAt: number;
  originalImage: string;      // filename in data/images
  studioImage?: string;       // filename; absent while processing
  processing?: boolean;
  error?: string;
  tags?: ItemTags;            // AI tags
  manualTags?: Partial<ItemTags>; // user overrides; effective = {...tags, ...manualTags}
  // candidate-only
  price?: number;
  store?: string;
  priceTagImage?: string;
  starred?: boolean;
  rank?: number;              // lower = more wanted
  tryOnImage?: string;        // item alone on active base (background render)
}

export interface BasePhoto {
  id: string;
  originalImage: string;
  studioImage?: string;       // bg removed, studio backdrop
  neutralImage?: string;      // optional neutral-outfit version
  processing?: boolean;
  error?: string;
}

export interface OutfitPick { top?: string; bottom?: string; layer?: string; shoes?: string; belt?: string } // item ids

export interface OutfitRating {
  score: number;              // 0–100 how well it goes together
  formality: number;          // 1–10
  label: FormalityLabel;
  notes?: string;
  source: 'rules' | 'ai' | 'manual';
}

export type FormalityLabel = 'athletic' | 'lounge' | 'casual' | 'smart casual' | 'business casual' | 'business' | 'formal';

export interface Outfit {
  id: string;                 // deterministic: outfitKey(pick)
  pick: OutfitPick;
  aiRating?: OutfitRating;
  manualRating?: OutfitRating;
  thumbs?: 'up' | 'down';
  renders?: Record<string, string>; // baseImageFilename -> rendered try-on filename
  saved?: boolean;
}

/** Pairwise compatibility 0–100 between two item ids. Key = pairKey(a,b). */
export interface PairScore { score: number; source: 'rules' | 'ai' | 'manual' }

export interface Settings {
  activeBaseId?: string;
  useNeutralBase?: boolean;
  targetOutfits: number;      // default 8
  minScore: number;           // default 70
  formalityMin: number;       // default 4.5
  formalityMax: number;       // default 7.5
  budget: number;             // default 300
}

export interface DB {
  items: Item[];
  bases: BasePhoto[];
  outfits: Record<string, Outfit>;
  pairs: Record<string, PairScore>;
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  targetOutfits: 8, minScore: 70, formalityMin: 4.5, formalityMax: 7.5, budget: 300,
};

export const effectiveTags = (i: Item): ItemTags | undefined =>
  i.tags ? ({ ...i.tags, ...i.manualTags } as ItemTags) : (i.manualTags as ItemTags | undefined);

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
export const outfitKey = (p: OutfitPick) => [p.top, p.bottom, p.layer, p.shoes].map(x => x ?? '-').join('_') + (p.belt ? `_${p.belt}` : '');

export const formalityLabel = (f: number): FormalityLabel =>
  f < 1.5 ? 'athletic' : f < 2.5 ? 'lounge' : f < 4 ? 'casual' : f < 5.5 ? 'smart casual' : f < 7.5 ? 'business casual' : f < 8.5 ? 'business' : 'formal';

// ---------------- REST API (all JSON unless noted; all require x-app-password) ----------------
// GET    /api/db                         -> DB
// GET    /api/status                     -> { mock: boolean, region: string, models: {...} }
// GET    /api/images/:file               -> image bytes
// POST   /api/items          multipart: image (1..n files), status ('owned'|'candidate'), price?, store?
//                                        -> Item[]  (created immediately with processing:true; studio+tags run async)
// PATCH  /api/items/:id       Partial<Item> (status, manualTags, price, store, starred, rank)  -> Item
// DELETE /api/items/:id                  -> {ok:true}
// POST   /api/items/:id/retry            -> Item   (re-run studio + tags)
// POST   /api/items/:id/price-tag  multipart: image -> { price: number|null, text: string, item: Item }
// POST   /api/items/:id/compat           -> Record<itemId, number>  (AI pair scores vs owned wardrobe; also stored in db.pairs)
// POST   /api/bases          multipart: image -> BasePhoto (processing async)
// POST   /api/bases/:id/neutral          -> BasePhoto (async)
// DELETE /api/bases/:id                  -> {ok:true}
// PATCH  /api/settings        Partial<Settings> -> Settings
// POST   /api/outfits/rate   { pick }    -> Outfit  (AI rating, cached)
// POST   /api/outfits/render { pick }    -> Outfit  (try-on render on active base, cached; may take 10–40s)
// PATCH  /api/outfits/:id    Partial<Outfit> (thumbs, manualRating, saved) -> Outfit   (creates if absent; needs pick)
// Clients poll GET /api/db every 2s while anything is processing.
