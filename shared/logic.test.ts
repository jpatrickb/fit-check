import { describe, expect, it } from 'vitest';
import type { DB, Item, ItemTags, Pattern, Slot } from './types';
import { DEFAULT_SETTINGS } from './types';
import { rateOutfitRules, ruleCompat, bestRating } from './scoring';
import { enumerateOutfits, itemImpact, optimize } from './optimizer';

let seq = 0;
function item(slot: Slot, type: string, color: string, hex: string, formality: number, extra: Partial<Item> = {}, pattern: Pattern = 'solid'): Item {
  const garmentClass = slot === 'shoes' ? 'SHOES' : slot === 'bottom' ? 'LONG_PANTS' : 'UPPER_BODY';
  const tags: ItemTags = { slot, garmentClass, type, primaryColor: color, primaryHex: hex, secondaryColors: [], pattern, formality };
  return { id: `i${++seq}`, status: 'owned', createdAt: seq, originalImage: 'x.jpg', tags, ...extra };
}
const mkdb = (items: Item[]): DB => ({ items, bases: [], outfits: {}, pairs: {}, settings: { ...DEFAULT_SETTINGS } });

describe('scoring', () => {
  it('navy blazer + gray trousers + brown loafers + white OCBD scores high, business casual', () => {
    const top = item('top', 'oxford button-down shirt', 'white', '#f5f5f2', 6);
    const bottom = item('bottom', 'wool trousers', 'gray', '#8a8d91', 7);
    const layer = item('layer', 'unstructured blazer', 'navy', '#1f2a44', 7);
    const shoes = item('shoes', 'penny loafers', 'brown', '#6b3e1f', 7);
    const db = mkdb([top, bottom, layer, shoes]);
    const r = rateOutfitRules(db, { top: top.id, bottom: bottom.id, layer: layer.id, shoes: shoes.id });
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.label).toBe('business casual');
    expect(r.formality).toBeGreaterThanOrEqual(4.5);
    expect(r.formality).toBeLessThanOrEqual(7.5);
  });

  it('graphic tee + gym shorts lands out of band', () => {
    const top = item('top', 'graphic tee', 'red', '#d22b2b', 2, {}, 'print');
    const bottom = item('bottom', 'athletic gym shorts', 'black', '#111111', 1);
    const shoes = item('shoes', 'running sneakers', 'white', '#ffffff', 2);
    const db = mkdb([top, bottom, shoes]);
    const r = rateOutfitRules(db, { top: top.id, bottom: bottom.id, shoes: shoes.id });
    expect(r.formality).toBeLessThan(DEFAULT_SETTINGS.formalityMin);
    expect(['athletic', 'lounge', 'casual']).toContain(r.label);
  });

  it('penalizes clashing formality and matching vivid colors', () => {
    const tee = item('top', 'graphic tee', 'red', '#d22b2b', 2);
    const trousers = item('bottom', 'wool dress trousers', 'charcoal', '#36393d', 8);
    const redPants = item('bottom', 'chinos', 'red', '#cc2222', 4);
    const chinos = item('bottom', 'chinos', 'khaki', '#c3b091', 5);
    expect(ruleCompat(tee, trousers)).toBeLessThan(ruleCompat(tee, chinos));
    expect(ruleCompat(tee, redPants)).toBeLessThan(ruleCompat(tee, chinos));
  });

  it('bestRating prefers manual over ai over rules', () => {
    const t = item('top', 'polo', 'navy', '#1f2a44', 5);
    const b = item('bottom', 'chinos', 'khaki', '#c3b091', 5);
    const db = mkdb([t, b]);
    const pick = { top: t.id, bottom: b.id };
    expect(bestRating(db, pick).source).toBe('rules');
    const key = `${t.id}_${b.id}_-_-`;
    db.outfits[key] = { id: key, pick, aiRating: { score: 55, formality: 5, label: 'smart casual', source: 'ai' } };
    expect(bestRating(db, pick).source).toBe('ai');
    db.outfits[key].manualRating = { score: 99, formality: 5, label: 'smart casual', source: 'manual' };
    expect(bestRating(db, pick).score).toBe(99);
  });
});

function baseWardrobe() {
  const owned = [
    item('top', 'oxford button-down', 'light blue', '#a9c6e8', 6),
    item('bottom', 'chinos', 'khaki', '#c3b091', 5.5),
    item('shoes', 'leather derby shoes', 'brown', '#6b3e1f', 6.5),
  ];
  return owned;
}

describe('optimizer', () => {
  it('picks the cheaper of two equivalent candidates', () => {
    const owned = baseWardrobe();
    const cheap = item('bottom', 'chinos', 'navy', '#1f2a44', 5.5, { status: 'candidate', price: 30 });
    const pricey = item('bottom', 'chinos', 'navy', '#1f2a44', 5.5, { status: 'candidate', price: 80 });
    const db = mkdb([...owned, cheap, pricey]);
    const s = { ...db.settings, targetOutfits: 2, budget: 300 };
    const r = optimize(db, s);
    expect(r.baseline.outfitCount).toBe(1);
    expect(r.best).not.toBeNull();
    expect(r.best!.itemIds).toEqual([cheap.id]);
    expect(r.best!.cost).toBe(30);
    expect(r.best!.outfitCount).toBe(2);
    expect(r.marginal[cheap.id].newOutfits).toBe(1);
  });

  it('frontier is monotonic and starts at baseline', () => {
    const owned = baseWardrobe();
    const cands = [
      item('top', 'polo', 'navy', '#1f2a44', 5, { status: 'candidate', price: 25 }),
      item('top', 'crewneck sweater', 'gray', '#888888', 5.5, { status: 'candidate', price: 40 }),
      item('bottom', 'wool trousers', 'charcoal', '#36393d', 7, { status: 'candidate', price: 60 }),
      item('layer', 'unstructured blazer', 'navy', '#1f2a44', 7, { status: 'candidate', price: 90 }),
    ];
    const db = mkdb([...owned, ...cands]);
    const r = optimize(db, { ...db.settings, targetOutfits: 4, budget: 600 });
    expect(r.frontier[0].cost).toBe(0);
    for (let i = 1; i < r.frontier.length; i++) {
      expect(r.frontier[i].cost).toBeGreaterThan(r.frontier[i - 1].cost);
      expect(r.frontier[i].outfitCount).toBeGreaterThan(r.frontier[i - 1].outfitCount);
    }
    expect(r.bestWithinBudget.outfitCount).toBe(r.frontier.at(-1)!.outfitCount);
  });

  it('respects budget: returns null best when target unreachable', () => {
    const owned = baseWardrobe();
    const c = item('bottom', 'chinos', 'navy', '#1f2a44', 5.5, { status: 'candidate', price: 50 });
    const db = mkdb([...owned, c]);
    const r = optimize(db, { ...db.settings, targetOutfits: 2, budget: 20 });
    expect(r.best).toBeNull();
    expect(r.bestWithinBudget.itemIds).toEqual([]);
  });

  it('itemImpact counts new outfits and works-with', () => {
    const owned = baseWardrobe();
    const c = item('top', 'polo', 'navy', '#1f2a44', 5, { status: 'candidate', price: 25 });
    const db = mkdb([...owned, c]);
    const imp = itemImpact(db, c.id, db.settings);
    expect(imp.baselineCount).toBe(1);
    expect(imp.newOutfits.length).toBe(1);
    expect(imp.worksWith).toContain(owned[1].id);
    expect(enumerateOutfits(db, db.items.map(i => i.id), db.settings).length).toBe(2);
  });

  it('greedy path works with > 16 candidates', () => {
    const owned = baseWardrobe();
    const cands = Array.from({ length: 20 }, (_, k) =>
      item(k % 2 ? 'top' : 'bottom', k % 2 ? 'polo' : 'chinos', 'navy', '#1f2a44', 5.5, { status: 'candidate', price: 20 + k }));
    const db = mkdb([...owned, ...cands]);
    const r = optimize(db, { ...db.settings, targetOutfits: 6, budget: 600 });
    expect(r.best).not.toBeNull();
    expect(r.best!.outfitCount).toBeGreaterThanOrEqual(6);
  });

  it('belts are optional and matched to shoes', () => {
    const top = item('top', 'oxford button-down', 'white', '#f5f5f2', 6);
    const bottom = item('bottom', 'chinos', 'navy', '#1f2a44', 5.5);
    const shoes = item('shoes', 'leather derby shoes', 'brown', '#6b3e1f', 6.5);
    const brownBelt = item('belt', 'leather belt', 'brown', '#6b3e1f', 6);
    const blackBelt = item('belt', 'leather belt', 'black', '#111111', 6);
    const db = mkdb([top, bottom, shoes, brownBelt, blackBelt]);
    const outs = enumerateOutfits(db, db.items.map(i => i.id), db.settings);
    expect(outs.length).toBe(1);
    expect(outs[0].pick.belt).toBe(brownBelt.id);
    const noBelt = mkdb([top, bottom, shoes]);
    expect(enumerateOutfits(noBelt, noBelt.items.map(i => i.id), noBelt.settings).length).toBe(1);
  });

  it('perf: 60 owned + 16 candidates under 200ms', () => {
    const colors: [string, string][] = [['navy', '#1f2a44'], ['gray', '#888888'], ['white', '#f5f5f2'], ['light blue', '#a9c6e8'],
      ['olive', '#5b6236'], ['khaki', '#c3b091'], ['charcoal', '#36393d'], ['burgundy', '#7a1f2b'], ['brown', '#6b3e1f'], ['black', '#111111']];
    const types: Record<Slot, string[]> = {
      top: ['oxford button-down', 'polo', 'crewneck sweater', 'henley', 'dress shirt'],
      bottom: ['chinos', 'wool trousers', 'dark jeans', 'five-pocket pants'],
      layer: ['unstructured blazer', 'quarter-zip sweater', 'cardigan', 'chore coat'],
      shoes: ['penny loafers', 'leather derby shoes', 'white leather sneakers', 'chelsea boots'],
      belt: ['leather belt'],
    };
    const counts: Record<Slot, number> = { top: 20, bottom: 16, layer: 10, shoes: 11, belt: 3 };
    const items: Item[] = [];
    let r = 1;
    const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
    for (const slot of Object.keys(counts) as Slot[]) for (let k = 0; k < counts[slot]; k++) {
      const [c, h] = colors[Math.floor(rnd() * colors.length)];
      items.push(item(slot, types[slot][k % types[slot].length], c, h, 4 + rnd() * 3.5));
    }
    const candSlots: Slot[] = ['top', 'top', 'top', 'top', 'top', 'bottom', 'bottom', 'bottom', 'bottom', 'layer', 'layer', 'layer', 'shoes', 'shoes', 'shoes', 'top'];
    for (const slot of candSlots) {
      const [c, h] = colors[Math.floor(rnd() * colors.length)];
      items.push(item(slot, types[slot][Math.floor(rnd() * 4)], c, h, 4.5 + rnd() * 3, { status: 'candidate', price: Math.round(20 + rnd() * 100) }));
    }
    const db = mkdb(items);
    const t0 = performance.now();
    const res = optimize(db, { ...db.settings, targetOutfits: 400, budget: 400 });
    const ms = performance.now() - t0;
    console.log(`optimize: ${ms.toFixed(0)}ms, baseline ${res.baseline.outfitCount}, frontier ${res.frontier.length}`);
    expect(ms).toBeLessThan(200);
  });
});
