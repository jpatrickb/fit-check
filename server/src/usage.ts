// Per-call AI usage + cost ledger: one JSON line per paid call in data/usage.jsonl.
// Token counts come straight from each provider's response; dollars = tokens x RATES below.
// Rates are list prices (USD per 1M tokens, or per call). Update here if pricing changes.
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env';

type TokenRates = { in: number; outText: number; outImage?: number };
const TOKEN_RATES: Record<string, TokenRates> = {
  'gemini-3-pro-image': { in: 2, outText: 12, outImage: 120 },        // ~13.4¢ per 1K/2K image (1120 tokens)
  'gemini-3.1-flash-image': { in: 0.5, outText: 3, outImage: 60 },     // AI Studio list price; API docs show $0.25/$1.50 in/text-out
  'gemini-3.8-flash': { in: 0.75, outText: 3.75 },                     // what gemini-flash-latest serves now (intro rate thru 2026-12-31, then $1.50/$7.50); thinking billed as output
  'gemini-3-flash': { in: 0.5, outText: 3 },
  'gemini-flash-latest': { in: 0.75, outText: 3.75 },                  // fallback if modelVersion missing
  'claude-haiku-4-5': { in: 1, outText: 5 },
};
const PER_CALL: Record<string, number> = {
  'stability.stable-image-remove-background': 0.07,  // unverified third-party figure; check Bedrock pricing page
  'stability.stable-image-search-replace': 0.07,
  'fal-ai/fashn/tryon': 0.075,
};

export interface UsageEntry {
  ts: number; what: string; model: string; modelVersion?: string; ok: boolean; ms: number;
  inTokens?: number; outTextTokens?: number; outImageTokens?: number; thoughtTokens?: number;
  cost: number; priced: boolean; // priced=false → no rate known, cost is 0
}

const file = path.join(env.dataDir, 'usage.jsonl');
const rateFor = <T>(table: Record<string, T>, model: string) =>
  Object.entries(table).sort((a, b) => b[0].length - a[0].length).find(([k]) => model.includes(k))?.[1];

/** Gemini usageMetadata → token fields. */
export function fromGemini(u: any) {
  if (!u) return {};
  const img = (u.candidatesTokensDetails || []).filter((d: any) => d.modality === 'IMAGE').reduce((s: number, d: any) => s + (d.tokenCount || 0), 0);
  const cand = u.candidatesTokenCount || 0;
  return { inTokens: u.promptTokenCount || 0, outImageTokens: img, outTextTokens: Math.max(0, cand - img) + (u.thoughtsTokenCount || 0), thoughtTokens: u.thoughtsTokenCount || 0 };
}

export function record(e: Omit<UsageEntry, 'ts' | 'cost' | 'priced'>): UsageEntry {
  let cost = 0, priced = false;
  const per = rateFor(PER_CALL, e.model);
  const tok = rateFor(TOKEN_RATES, e.modelVersion || e.model) || rateFor(TOKEN_RATES, e.model);
  if (per != null) { cost = e.ok ? per : 0; priced = true; }
  else if (tok && e.inTokens != null) {
    cost = ((e.inTokens || 0) * tok.in + (e.outTextTokens || 0) * tok.outText + (e.outImageTokens || 0) * (tok.outImage ?? tok.outText)) / 1e6;
    priced = true;
  }
  const entry: UsageEntry = { ts: Date.now(), ...e, cost: Math.round(cost * 1e6) / 1e6, priced };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

export function readUsage(): UsageEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function summary(sinceTs = 0) {
  const rows = readUsage().filter(r => r.ts >= sinceTs);
  const byWhat: Record<string, { calls: number; cost: number; failed: number }> = {};
  const byDay: Record<string, number> = {};
  for (const r of rows) {
    const b = (byWhat[r.what] ||= { calls: 0, cost: 0, failed: 0 });
    b.calls++; b.cost += r.cost; if (!r.ok) b.failed++;
    const day = new Date(r.ts).toLocaleDateString('en-CA');
    byDay[day] = (byDay[day] || 0) + r.cost;
  }
  return { total: rows.reduce((s, r) => s + r.cost, 0), calls: rows.length, unpriced: rows.filter(r => !r.priced).length, byWhat, byDay, recent: rows.slice(-50).reverse() };
}
