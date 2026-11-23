// Purchase optimizer: cheapest set of candidate items that yields N on-target outfits. Pure, browser-safe.
import type { DB, Item, OutfitPick, OutfitRating, Settings, Slot } from './types';
import { effectiveTags, outfitKey } from './types';
import { buildRating, combineNumbers, itemIsBlazer, pairScore, SLOT_FORMALITY_WEIGHT as W } from './scoring';

export interface ScoredOutfit { key: string; pick: OutfitPick; rating: OutfitRating; usesCandidates: string[] }

export interface PurchasePlan { itemIds: string[]; cost: number; outfitCount: number; outfits: ScoredOutfit[] }

export interface OptimizeResult {
  baseline: PurchasePlan;                 // owned only, cost 0
  best: PurchasePlan | null;              // cheapest set reaching settings.targetOutfits within settings.budget (null if impossible)
  bestWithinBudget: PurchasePlan;         // most outfits achievable within budget
  frontier: PurchasePlan[];               // Pareto: increasing cost -> strictly more outfits
  marginal: Record<string, { newOutfits: number; perDollar: number }>; // each candidate added alone to owned
}

// ---------------------------------------------------------------- helpers

const usable = (i: Item) => !i.processing && !!effectiveTags(i)?.slot;
const isOwned = (i: Item) => i.status === 'owned' || i.status === 'bought';
const isCandidate = (i: Item) => i.status === 'candidate';
const slotOf = (i: Item): Slot => effectiveTags(i)!.slot;
const hasPrice = (i: Item) => typeof i.price === 'number' && isFinite(i.price) && i.price >= 0;

const MAX_EXHAUSTIVE = 16;
const MAX_SEARCH = 30; // bitmask limit for greedy

interface Completion { pick: OutfitPick; rating: OutfitRating; mask: number; usesCandidates: string[] }
interface PairEntry { tb: string; comps: Completion[]; minMasks: number[] }

interface Model {
  pairs: PairEntry[];      // only pairs with at least one valid completion
}

/**
 * Build all valid (on-target) outfit completions over `pool`.
 * `bit` maps candidate item id -> bit index (items not in map are always available).
 */
function buildModel(db: DB, pool: Item[], bit: Map<string, number>, settings: Settings, allowNoShoes: boolean): Model {
  const n = pool.length;
  const by: Record<Slot, number[]> = { top: [], bottom: [], layer: [], shoes: [], belt: [] };
  pool.forEach((it, k) => by[slotOf(it)].push(k));
  const form = pool.map(it => effectiveTags(it)!.formality ?? 5);
  const blazer = pool.map(it => itemIsBlazer(it));
  const cand = pool.map(it => isCandidate(it));
  const bitMask = pool.map(it => { const b = bit.get(it.id); return b === undefined ? 0 : 1 << b; });

  // lazy symmetric pair-score matrix
  const cache = new Float32Array(n * n).fill(-1);
  const P = (a: number, b: number) => {
    const k = a * n + b;
    let v = cache[k];
    if (v < 0) { v = pairScore(db, pool[a], pool[b]).score; cache[k] = v; cache[b * n + a] = v; }
    return v;
  };

  const overrides = db.outfits && Object.keys(db.outfits).length > 0 ? db.outfits : null;
  const { minScore, formalityMin, formalityMax } = settings;
  const inBand = (score: number, f: number) => score >= minScore && f >= formalityMin && f <= formalityMax;

  const shoeOpts: number[] = [...by.shoes];
  if (allowNoShoes || by.shoes.length === 0) shoeOpts.push(-1);
  const layerOpts: number[] = [-1, ...by.layer];

  // Belts are optional accessories: attach the best owned belt (judged vs bottom + shoes), never required,
  // and they don't change outfit counts.
  const ownedBelts = by.belt.filter(k => !cand[k]);
  const beltMemo = new Map<number, number>();
  const bestBelt = (b: number, s: number): number => {
    if (!ownedBelts.length) return -1;
    const key = b * (n + 1) + (s + 1);
    const hit = beltMemo.get(key);
    if (hit !== undefined) return hit;
    let bestK = -1, bestV = -1;
    for (const k of ownedBelts) { const v = P(k, b) + (s >= 0 ? P(k, s) : 0); if (v > bestV) { bestV = v; bestK = k; } }
    beltMemo.set(key, bestK);
    return bestK;
  };

  const pairs: PairEntry[] = [];
  interface Raw { score: number; formality: number; l: number; s: number; rating?: OutfitRating }
  const mkPick = (t: number, b: number, l: number, s: number): OutfitPick => {
    const p: OutfitPick = { top: pool[t].id, bottom: pool[b].id };
    if (l >= 0) p.layer = pool[l].id;
    if (s >= 0) p.shoes = pool[s].id;
    return p;
  };
  for (const t of by.top) for (const b of by.bottom) {
    // only the best completion per candidate mask can ever be selected
    const best = new Map<number, Raw>();
    const tb = P(t, b);
    const fTB = W.top * form[t] + W.bottom * form[b];
    const mTB = bitMask[t] | bitMask[b];
    for (const s of shoeOpts) {
      const ts = s >= 0 ? P(t, s) : 0, bs = s >= 0 ? P(b, s) : 0;
      const mS = s >= 0 ? mTB | bitMask[s] : mTB;
      for (const l of layerOpts) {
        let sum = tb, min = tb, cnt = 1, fs = fTB, fw = W.top + W.bottom;
        if (s >= 0) { sum += ts + bs; cnt += 2; min = Math.min(min, ts, bs); fs += W.shoes * form[s]; fw += W.shoes; }
        if (l >= 0) {
          const tl = P(t, l), bl = P(b, l);
          sum += tl + bl; cnt += 2; min = Math.min(min, tl, bl); fs += W.layer * form[l]; fw += W.layer;
          if (s >= 0) { const ls = P(l, s); sum += ls; cnt++; if (ls < min) min = ls; }
        }
        let score: number, formality: number, rating: OutfitRating | undefined;
        const ov = overrides ? overrides[outfitKey(mkPick(t, b, l, s))] : undefined;
        if (ov?.thumbs === 'down') continue;
        rating = ov?.manualRating ?? ov?.aiRating;
        if (rating) { score = rating.score; formality = rating.formality; }
        else ({ score, formality } = combineNumbers(fs, fw, l >= 0 && blazer[l], sum, min, cnt, true));
        if (!inBand(score, formality)) continue;
        const mask = l >= 0 ? mS | bitMask[l] : mS;
        const prev = best.get(mask);
        if (!prev || score > prev.score) best.set(mask, { score, formality, l, s, rating });
      }
    }
    const comps: Completion[] = [];
    for (const [mask, r] of best) {
      const idxs = [t, b, r.l, r.s].filter(x => x >= 0);
      const pick = mkPick(t, b, r.l, r.s);
      const belt = bestBelt(b, r.s);
      if (belt >= 0) pick.belt = pool[belt].id;
      comps.push({
        pick,
        rating: r.rating ?? buildRating(r.score, r.formality, true, r.s >= 0),
        mask,
        usesCandidates: idxs.filter(x => cand[x]).map(x => pool[x].id),
      });
    }
    if (!comps.length) continue;
    // best first; prefer fewer candidates on ties
    comps.sort((x, y) => y.rating.score - x.rating.score || x.usesCandidates.length - y.usesCandidates.length);
    // minimal masks
    const uniq = [...new Set(comps.map(c => c.mask))].sort((x, y) => popcount(x) - popcount(y));
    const minMasks: number[] = [];
    for (const m of uniq) if (!minMasks.some(mm => (mm & m) === mm)) minMasks.push(m);
    pairs.push({ tb: `${pool[t].id}|${pool[b].id}`, comps, minMasks });
  }
  return { pairs };
}

function popcount(x: number) { x = x - ((x >>> 1) & 0x55555555); x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }

const sub = (m: number, S: number) => (m & ~S) === 0;

function outfitsFor(model: Model, S: number): ScoredOutfit[] {
  const out: ScoredOutfit[] = [];
  for (const p of model.pairs) {
    const c = p.comps.find(c => sub(c.mask, S));
    if (c) out.push({ key: outfitKey(c.pick), pick: c.pick, rating: c.rating, usesCandidates: c.usesCandidates });
  }
  return out.sort((a, b) => b.rating.score - a.rating.score);
}

function countFor(model: Model, S: number): number {
  let n = 0;
  for (const p of model.pairs) for (const m of p.minMasks) if (sub(m, S)) { n++; break; }
  return n;
}

const avgScore = (o: ScoredOutfit[]) => (o.length ? o.reduce((a, x) => a + x.rating.score, 0) / o.length : 0);

// ---------------------------------------------------------------- public API

/** On-target outfits (score >= minScore, formality within band) from the given item ids; one best outfit per distinct (top,bottom). */
export function enumerateOutfits(db: DB, itemIds: string[], settings: Settings): ScoredOutfit[] {
  const ids = new Set(itemIds);
  const pool = db.items.filter(i => ids.has(i.id) && usable(i));
  const model = buildModel(db, pool, new Map(), settings, false);
  return outfitsFor(model, 0);
}

/** Full optimization over owned + non-rejected candidates. Must run < 200ms for ~60 owned + 16 candidates. */
export function optimize(db: DB, settings: Settings): OptimizeResult {
  const owned = db.items.filter(i => isOwned(i) && usable(i));
  const allCands = db.items.filter(i => isCandidate(i) && usable(i));
  const priced = allCands.filter(hasPrice);
  // search set: priced candidates, most-wanted first, capped
  const search = [...priced]
    .sort((a, b) => Number(!!b.starred) - Number(!!a.starred) || (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.createdAt - b.createdAt)
    .slice(0, MAX_SEARCH);
  const bit = new Map(search.map((c, k) => [c.id, k]));
  const allowNoShoes = !owned.some(i => slotOf(i) === 'shoes');
  const model = buildModel(db, [...owned, ...search], bit, settings, allowNoShoes);
  const n = search.length;

  const plan = (S: number): PurchasePlan => {
    const itemIds: string[] = []; let cost = 0;
    for (let k = 0; k < n; k++) if (S & (1 << k)) { itemIds.push(search[k].id); cost += search[k].price!; }
    const outfits = outfitsFor(model, S);
    return { itemIds, cost: round2(cost), outfitCount: outfits.length, outfits };
  };

  const baseline = plan(0);
  const baseCount = baseline.outfitCount;

  // marginal per candidate (search set from model; others computed directly)
  const marginal: OptimizeResult['marginal'] = {};
  for (let k = 0; k < n; k++) {
    const c = search[k];
    const newOutfits = countFor(model, 1 << k) - baseCount;
    marginal[c.id] = { newOutfits, perDollar: c.price! > 0 ? newOutfits / c.price! : newOutfits };
  }
  for (const c of allCands) {
    if (marginal[c.id]) continue;
    const newOutfits = enumerateWithAllowed(db, [...owned, c], settings, allowNoShoes).length - baseCount;
    marginal[c.id] = { newOutfits, perDollar: hasPrice(c) && c.price! > 0 ? newOutfits / c.price! : newOutfits };
  }

  const target = settings.targetOutfits, budget = settings.budget;
  let frontierSets: number[];
  let bestS: number | null = null;
  let bwbS = 0;

  if (n <= MAX_EXHAUSTIVE) {
    const N = 1 << n;
    const cost = new Float64Array(N);
    for (let S = 1; S < N; S++) { const low = S & -S; cost[S] = cost[S ^ low] + search[31 - Math.clz32(low)].price!; }
    const count = countAll(model, n, baseCount);
    // best: cheapest reaching target within budget; ties -> more outfits -> higher avg score
    let bestTies: number[] = [];
    let bwbTies: number[] = [0];
    for (let S = 0; S < N; S++) {
      const c = cost[S];
      if (c > budget + 1e-9) continue;
      const k = count[S];
      if (k >= target) {
        if (!bestTies.length) bestTies = [S];
        else {
          const b0 = bestTies[0];
          if (c < cost[b0] - 1e-9 || (Math.abs(c - cost[b0]) < 1e-9 && k > count[b0])) bestTies = [S];
          else if (Math.abs(c - cost[b0]) < 1e-9 && k === count[b0]) bestTies.push(S);
        }
      }
      const w0 = bwbTies[0];
      if (k > count[w0] || (k === count[w0] && c < cost[w0] - 1e-9)) bwbTies = [S];
      else if (k === count[w0] && Math.abs(c - cost[w0]) < 1e-9) bwbTies.push(S);
    }
    const byAvg = (ties: number[]) => ties.slice(0, 50).reduce((best, S) =>
      avgScore(outfitsFor(model, S)) > avgScore(outfitsFor(model, best)) ? S : best, ties[0]);
    bestS = bestTies.length ? byAvg(bestTies) : null;
    bwbS = byAvg(bwbTies);

    // Pareto frontier over all subsets in O(N): cheapest set per outfit count, then suffix-min
    let maxC = 0;
    for (let S = 0; S < N; S++) if (count[S] > maxC) maxC = count[S];
    const minCost = new Float64Array(maxC + 1).fill(Infinity);
    const arg = new Int32Array(maxC + 1).fill(-1);
    for (let S = 0; S < N; S++) { const k = count[S]; if (cost[S] < minCost[k]) { minCost[k] = cost[S]; arg[k] = S; } }
    const chosen: number[] = [];
    let nextCost = Infinity;
    for (let k = maxC; k >= 0; k--) {
      if (arg[k] >= 0 && minCost[k] < nextCost - 1e-9) { chosen.push(arg[k]); nextCost = minCost[k]; }
    }
    frontierSets = chosen.reverse();
  } else {
    // greedy by marginal outfits per dollar (with pair lookahead), then swap improvement
    const g = greedy(model, search, baseCount);
    frontierSets = g.sequence;
    const reach = g.sequence.find(S => countFor(model, S) >= target && setCost(search, S) <= budget + 1e-9);
    bestS = reach !== undefined ? improveCheapest(model, search, reach, target, budget) : null;
    const within = [...g.sequence].reverse().find(S => setCost(search, S) <= budget + 1e-9) ?? 0;
    bwbS = improveCount(model, search, within, budget);
  }

  return {
    baseline,
    best: bestS === null ? null : plan(bestS),
    bestWithinBudget: plan(bwbS),
    frontier: frontierSets.map(plan),
    marginal,
  };
}

/** For the Shop result card: how a single item (usually a candidate) fits with owned wardrobe. */
export function itemImpact(db: DB, itemId: string, settings: Settings): {
  worksWith: string[];            // owned item ids with pair score >= 65
  newOutfits: ScoredOutfit[];     // on-target outfits that exist only with this item
  baselineCount: number;
} {
  const item = db.items.find(i => i.id === itemId);
  const owned = db.items.filter(i => isOwned(i) && usable(i) && i.id !== itemId);
  const allowNoShoes = !owned.some(i => slotOf(i) === 'shoes');
  const base = enumerateWithAllowed(db, owned, settings, allowNoShoes);
  if (!item || !usable(item)) return { worksWith: [], newOutfits: [], baselineCount: base.length };
  const slot = slotOf(item);
  const worksWith = owned
    .filter(o => slotOf(o) !== slot && pairScore(db, item, o).score >= 65)
    .sort((a, b) => pairScore(db, item, b).score - pairScore(db, item, a).score)
    .map(o => o.id);
  const baseTB = new Set(base.map(o => `${o.pick.top}|${o.pick.bottom}`));
  const withItem = enumerateWithAllowed(db, [...owned, item], settings, allowNoShoes);
  const newOutfits = withItem.filter(o => !baseTB.has(`${o.pick.top}|${o.pick.bottom}`));
  return { worksWith, newOutfits, baselineCount: base.length };
}

// ---------------------------------------------------------------- internals

function enumerateWithAllowed(db: DB, pool: Item[], settings: Settings, allowNoShoes: boolean): ScoredOutfit[] {
  return outfitsFor(buildModel(db, pool, new Map(), settings, allowNoShoes), 0);
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function setCost(search: Item[], S: number) {
  let c = 0;
  for (let k = 0; k < search.length; k++) if (S & (1 << k)) c += search[k].price!;
  return c;
}

/** count[S] for all subsets via inclusion–exclusion weights + subset-sum (zeta) transform. */
function countAll(model: Model, n: number, baseCount: number): Int32Array {
  const N = 1 << n;
  const w = new Int32Array(N);
  const direct: number[][] = [];
  for (const p of model.pairs) {
    const ms = p.minMasks;
    if (ms.length === 1 && ms[0] === 0) continue; // baseline pair
    if (ms.length > 12) { direct.push(ms); continue; }
    const k = ms.length;
    for (let T = 1; T < 1 << k; T++) {
      let u = 0;
      for (let j = 0; j < k; j++) if (T & (1 << j)) u |= ms[j];
      w[u] += popcount(T) & 1 ? 1 : -1;
    }
  }
  for (let i = 0; i < n; i++) {
    const b = 1 << i;
    for (let S = 0; S < N; S++) if (S & b) w[S] += w[S ^ b];
  }
  for (let S = 0; S < N; S++) w[S] += baseCount;
  for (const ms of direct) for (let S = 0; S < N; S++) if (ms.some(m => sub(m, S))) w[S]++;
  return w;
}

function greedy(model: Model, search: Item[], baseCount: number): { sequence: number[] } {
  const n = search.length;
  let S = 0, cur = baseCount;
  const sequence = [0];
  const price = (k: number) => search[k].price!;
  for (;;) {
    let bestGain = 0, bestRatio = -1, bestAdd = 0;
    for (let k = 0; k < n; k++) {
      if (S & (1 << k)) continue;
      const gain = countFor(model, S | (1 << k)) - cur;
      if (gain <= 0) continue;
      const r = price(k) > 0 ? gain / price(k) : Infinity;
      if (r > bestRatio) { bestRatio = r; bestGain = gain; bestAdd = 1 << k; }
    }
    if (bestGain === 0) {
      // lookahead: best pair of items (e.g. a top that needs new shoes)
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
        if (S & ((1 << a) | (1 << b))) continue;
        const add = (1 << a) | (1 << b);
        const gain = countFor(model, S | add) - cur;
        if (gain <= 0) continue;
        const c = price(a) + price(b);
        const r = c > 0 ? gain / c : Infinity;
        if (r > bestRatio) { bestRatio = r; bestGain = gain; bestAdd = add; }
      }
    }
    if (bestGain === 0) break;
    S |= bestAdd; cur += bestGain;
    sequence.push(S);
  }
  return { sequence };
}

/** Drop/swap items to reduce cost while keeping >= target outfits. */
function improveCheapest(model: Model, search: Item[], S: number, target: number, budget: number): number {
  const n = search.length;
  let improved = true;
  while (improved) {
    improved = false;
    const cost = setCost(search, S);
    for (let k = 0; k < n && !improved; k++) {
      if (!(S & (1 << k))) continue;
      const T = S & ~(1 << k);
      if (countFor(model, T) >= target) { S = T; improved = true; break; }
      for (let j = 0; j < n; j++) {
        if (S & (1 << j)) continue;
        const U = T | (1 << j);
        const c = setCost(search, U);
        if (c < cost - 1e-9 && c <= budget + 1e-9 && countFor(model, U) >= target) { S = U; improved = true; break; }
      }
    }
  }
  return S;
}

/** Swap items to increase outfit count within budget. */
function improveCount(model: Model, search: Item[], S: number, budget: number): number {
  const n = search.length;
  let cur = countFor(model, S), improved = true;
  while (improved) {
    improved = false;
    for (let j = 0; j < n && !improved; j++) {
      if (S & (1 << j)) continue;
      const add = S | (1 << j);
      if (setCost(search, add) <= budget + 1e-9) {
        const c = countFor(model, add);
        if (c > cur) { S = add; cur = c; improved = true; break; }
      }
      for (let k = 0; k < n; k++) {
        if (!(S & (1 << k))) continue;
        const U = (S & ~(1 << k)) | (1 << j);
        if (setCost(search, U) > budget + 1e-9) continue;
        const c = countFor(model, U);
        if (c > cur) { S = U; cur = c; improved = true; break; }
      }
    }
  }
  return S;
}
