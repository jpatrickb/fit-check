// Outfit scoring: rule-based pair compatibility + outfit ratings. Pure, browser-safe.
import type { DB, Item, ItemTags, OutfitPick, OutfitRating, PairScore, Slot } from './types';
import { effectiveTags, formalityLabel, outfitKey, pairKey } from './types';

// ---------------------------------------------------------------- features

interface Features {
  tags: ItemTags;
  type: string;          // lowercase type + material
  color: string;         // lowercase color name
  h: number; s: number; l: number;
  neutral: boolean;
  boldPattern: boolean;
}

const NEUTRAL_WORDS = [
  'navy', 'gray', 'grey', 'charcoal', 'black', 'white', 'cream', 'ivory', 'off-white', 'ecru', 'beige',
  'khaki', 'tan', 'stone', 'sand', 'camel', 'taupe', 'brown', 'chocolate', 'cognac', 'walnut', 'olive',
  'denim', 'indigo', 'chambray', 'oatmeal', 'heather', 'silver', 'slate',
];
const BROWNISH = ['brown', 'tan', 'cognac', 'walnut', 'chocolate', 'camel', 'chestnut', 'oxblood', 'burgundy suede'];
const BOTTOM_GOOD_WITH_BROWN = ['navy', 'gray', 'grey', 'charcoal', 'khaki', 'tan', 'stone', 'olive', 'denim', 'indigo', 'blue'];

function hexToHsl(hex: string | undefined): [number, number, number] | null {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  let h6 = m[1];
  if (h6.length === 3) h6 = h6.split('').map(c => c + c).join('');
  const r = parseInt(h6.slice(0, 2), 16) / 255, g = parseInt(h6.slice(2, 4), 16) / 255, b = parseInt(h6.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

const has = (s: string, words: string[]) => words.some(w => s.includes(w));

const featCache = new WeakMap<Item, Features | null>();
function features(item: Item): Features | null {
  if (featCache.has(item)) return featCache.get(item)!;
  const tags = effectiveTags(item);
  let f: Features | null = null;
  if (tags && tags.slot) {
    const color = (tags.primaryColor ?? '').toLowerCase();
    const hsl = hexToHsl(tags.primaryHex) ?? [0, 0, 0.5];
    const [h, s, l] = hsl;
    const neutral = has(color, NEUTRAL_WORDS) || s < 0.18 || l < 0.13 || l > 0.92 ||
      // navy-ish dark blues
      (h >= 200 && h <= 250 && l < 0.3);
    const pattern = tags.pattern ?? 'solid';
    f = {
      tags,
      type: `${tags.type ?? ''} ${tags.material ?? ''}`.toLowerCase(),
      color, h, s, l, neutral,
      boldPattern: !['solid', 'texture'].includes(pattern),
    };
  }
  featCache.set(item, f);
  return f;
}

const hueDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

const isAthletic = (t: string) => /athletic|gym|jogger|sweatpant|track ?pant|running|legging|basketball|hoodie|sweatshort/.test(t);
const isSneaker = (t: string) => /sneaker|trainer|running shoe|tennis shoe/.test(t);
const isTailored = (t: string) => /wool|dress pant|dress trouser|trouser|slack/.test(t);
const isBlazer = (t: string) => /blazer|sport ?coat|suit jacket/.test(t);
const isDenimJacket = (t: string) => /denim jacket|jean jacket|trucker/.test(t);
const isJeans = (t: string, color: string) => /jean|denim/.test(t) || /denim/.test(color);
const isShorts = (t: string) => /short/.test(t) && !/short.sleeve/.test(t);

function shoesBottom(shoes: Features, bottom: Features): number {
  let d = 0;
  const sc = shoes.color;
  if (has(sc, BROWNISH) && has(bottom.color, BOTTOM_GOOD_WITH_BROWN)) d += 8;
  if (sc.includes('black') && has(bottom.color, ['brown', 'khaki', 'tan', 'stone', 'camel'])) d -= 6;
  if (isSneaker(shoes.type) && isTailored(bottom.type)) d -= 6;
  if (isShorts(bottom.type) && !isSneaker(shoes.type) && /loafer|oxford|derby|brogue|monk/.test(shoes.type)) d -= 4;
  return d;
}

/** Leather matching: brown belt + brown shoes is a classic; black with brown is off. */
function beltShoes(belt: Features, shoes: Features): number {
  const bb = has(belt.color, BROWNISH), sb = has(shoes.color, BROWNISH);
  const bk = belt.color.includes('black'), sk = shoes.color.includes('black');
  if ((bb && sb) || (bk && sk)) return 10;
  if ((bk && sb) || (bb && sk)) return -8;
  return 0;
}

/** Belts are only judged against shoes and bottoms. */
export const beltPairCounts = (a: Slot, b: Slot) =>
  a !== 'belt' && b !== 'belt' ? true : (a === 'belt' ? b : a) === 'shoes' || (a === 'belt' ? b : a) === 'bottom';

/** Rule-based compatibility of two items, 0–100 (color harmony, formality gap, pattern clash, type pairing). */
export function ruleCompat(a: Item, b: Item): number {
  const fa = features(a), fb = features(b);
  if (!fa || !fb) return 50;
  let score = 80;

  // formality gap
  const gap = Math.abs((fa.tags.formality ?? 5) - (fb.tags.formality ?? 5));
  if (gap > 2.5) score -= 12 + (gap - 2.5) * 20;
  else if (gap > 1) score -= (gap - 1) * 8;

  // color harmony
  if (fa.neutral && fb.neutral) score += 8;
  else if (fa.neutral || fb.neutral) score += 5;
  else {
    const d = hueDiff(fa.h, fb.h);
    const slots = new Set<Slot>([fa.tags.slot, fb.tags.slot]);
    const adjacentGarments = slots.has('bottom') && (slots.has('top') || slots.has('layer'));
    const bothVivid = fa.s > 0.5 && fb.s > 0.5;
    if (d < 20) score -= adjacentGarments ? 18 : 6;          // matching non-neutrals
    else if (d <= 50) score += 3;                              // analogous
    else if (d >= 60 && d <= 120) score -= bothVivid ? 12 : 5; // awkward / triadic clash
    else if (d >= 150) score -= bothVivid ? 4 : 0;             // complementary: bold
  }

  // patterns
  if (fa.boldPattern && fb.boldPattern) {
    const pats = new Set([fa.tags.pattern, fb.tags.pattern]);
    score -= pats.size === 2 && pats.has('stripe') && (pats.has('check') || pats.has('plaid')) ? 8 : 14;
  }

  // type pairing heuristics (order-independent)
  const pair = (x: Features, y: Features) => {
    let d = 0;
    if (x.tags.slot === 'shoes' && y.tags.slot === 'bottom') d += shoesBottom(x, y);
    if (x.tags.slot === 'belt' && y.tags.slot === 'shoes') d += beltShoes(x, y);
    if (x.tags.slot === 'layer' && isDenimJacket(x.type) && y.tags.slot === 'bottom' && isJeans(y.type, y.color)) d -= 15;
    if (isBlazer(x.type) && (isAthletic(y.type) || isShorts(y.type))) d -= 25;
    if (isBlazer(x.type) && y.tags.slot === 'bottom' && isTailored(y.type)) d += 4;
    if (isAthletic(x.type) && y.tags.slot !== x.tags.slot && (y.tags.formality ?? 5) >= 6) d -= 10;
    return d;
  };
  score += pair(fa, fb) + pair(fb, fa);

  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Best known pair score: manual > ai > rules (db.pairs, falling back to ruleCompat). */
export function pairScore(db: DB, a: Item, b: Item): PairScore {
  const p = db.pairs?.[pairKey(a.id, b.id)];
  if (p) return p;
  return { score: ruleCompat(a, b), source: 'rules' };
}

// ---------------------------------------------------------------- outfit rating

const SLOT_WEIGHT: Record<Slot, number> = { top: 1, bottom: 1, layer: 1.4, shoes: 1.2, belt: 0.5 };
const ORDER: Slot[] = ['top', 'bottom', 'layer', 'shoes', 'belt'];

export interface PickedItem { slot: Slot; item: Item }

export const SLOT_FORMALITY_WEIGHT = SLOT_WEIGHT;
export const BLAZER_FORMALITY_LIFT = 0.4;
export const itemIsBlazer = (item: Item) => isBlazer((effectiveTags(item)?.type ?? '').toLowerCase());

/** Numeric core shared by rateItems and the optimizer's fast path. */
export function combineNumbers(fSum: number, fW: number, blazerLayer: boolean, pairSum: number, pairMin: number, pairCount: number, hasTopAndBottom: boolean): { score: number; formality: number } {
  let formality = fW ? fSum / fW : 5;
  if (blazerLayer) formality += BLAZER_FORMALITY_LIFT;
  formality = Math.max(1, Math.min(10, Math.round(formality * 10) / 10));
  let score = pairCount ? 0.7 * (pairSum / pairCount) + 0.3 * pairMin : 50;
  if (!hasTopAndBottom) score = Math.min(score, 40);
  return { score: Math.max(0, Math.min(100, Math.round(score))), formality };
}

export function buildRating(score: number, formality: number, hasTopAndBottom: boolean, hasShoes: boolean): OutfitRating {
  const notes: string[] = [];
  if (!hasTopAndBottom) notes.push('needs a top and a bottom');
  if (!hasShoes) notes.push('no shoes picked');
  return { score, formality, label: formalityLabel(formality), notes: notes.length ? notes.join('; ') : undefined, source: 'rules' };
}

/** Shared core used by rateOutfitRules and the optimizer. */
export function rateItems(picked: PickedItem[], pair: (a: Item, b: Item) => number): OutfitRating {
  const present = new Set(picked.map(p => p.slot));
  let fw = 0, fs = 0, blazer = false;
  for (const p of picked) {
    const w = SLOT_WEIGHT[p.slot];
    fw += w; fs += w * (effectiveTags(p.item)?.formality ?? 5);
    if (p.slot === 'layer' && itemIsBlazer(p.item)) blazer = true;
  }
  let sum = 0, min = 101, cnt = 0;
  for (let i = 0; i < picked.length; i++)
    for (let j = i + 1; j < picked.length; j++) {
      if (!beltPairCounts(picked[i].slot, picked[j].slot)) continue;
      const v = pair(picked[i].item, picked[j].item); sum += v; cnt++; if (v < min) min = v;
    }
  const tb = present.has('top') && present.has('bottom');
  const { score, formality } = combineNumbers(fs, fw, blazer, sum, min, cnt, tb);
  return buildRating(score, formality, tb, present.has('shoes'));
}

function pickedItems(db: DB, pick: OutfitPick): PickedItem[] {
  const byId = new Map(db.items.map(i => [i.id, i]));
  const out: PickedItem[] = [];
  for (const slot of ORDER) {
    const id = pick[slot];
    const item = id ? byId.get(id) : undefined;
    if (item) out.push({ slot, item });
  }
  return out;
}

/** Instant rule-based outfit rating from pair scores + formality coherence. */
export function rateOutfitRules(db: DB, pick: OutfitPick): OutfitRating {
  return rateItems(pickedItems(db, pick), (a, b) => pairScore(db, a, b).score);
}

/** manual > ai > rules for an outfit pick. */
export function bestRating(db: DB, pick: OutfitPick): OutfitRating {
  const o = db.outfits?.[outfitKey(pick)];
  return o?.manualRating ?? o?.aiRating ?? rateOutfitRules(db, pick);
}
