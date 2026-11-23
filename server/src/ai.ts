import { BedrockRuntimeClient, InvokeModelCommand, ConverseCommand, type ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import sharp from 'sharp';
import { env } from './env';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { imagesDir } from './db';
import { record, fromGemini } from './usage';
import { prep, compositeItem, compositePerson, label, toPng } from './images';
import type { GarmentClass, ItemTags, Pattern, Slot, OutfitRating } from '../../shared/types';
import { formalityLabel } from '../../shared/types';

// ---------------- state ----------------
export const aiState = { mock: true, reason: 'not checked', gemini: false, claudeUnavailable: '' as string };
let client: BedrockRuntimeClient | null = null;

export async function checkCredentials(): Promise<void> {
  aiState.gemini = !!env.geminiKey && !env.forceMock;
  aiState.claudeUnavailable = '';
  if (env.forceMock) { aiState.mock = true; aiState.reason = 'MOCK_AI=1'; return; }
  try {
    const creds = fromNodeProviderChain();
    await creds();
    client = new BedrockRuntimeClient({ region: env.region, credentials: creds });
    aiState.mock = false; aiState.reason = 'ok';
    console.log(`[ai] Bedrock credentials OK (profile=${process.env.AWS_PROFILE || 'default'}, region=${env.region}); gemini=${aiState.gemini ? env.geminiModel : 'off'}`);
  } catch (e: any) {
    client = null;
    if (aiState.gemini) {
      // Gemini covers studio images, renders, tagging and scoring; only background removal (new "Me" photos) needs AWS.
      aiState.mock = false; aiState.reason = 'Gemini only — AWS unavailable: ' + (e?.message || e);
      console.warn(`[ai] AWS credentials unavailable (${e?.message || e}). Running on Gemini only; adding a new photo of yourself needs AWS (aws sso login --profile ${process.env.AWS_PROFILE || '<profile>'}).`);
      return;
    }
    aiState.mock = true; aiState.reason = 'no AWS credentials: ' + (e?.message || e);
    console.warn('\n**************************************************************');
    console.warn('[ai] MOCK MODE: could not resolve AWS credentials —', e?.message || e);
    console.warn('[ai] Run `aws sso login --profile $AWS_PROFILE` then POST /api/status/recheck');
    console.warn('**************************************************************\n');
  }
}

export function tryOnProvider(): 'gemini' | 'stability' | 'mock' {
  if (env.forceMock) return 'mock';
  const p = env.tryOnProvider;
  if (p === 'mock') return 'mock';
  if (p === 'gemini' || (!p && aiState.gemini)) return aiState.gemini ? 'gemini' : (aiState.mock ? 'mock' : 'stability');
  return aiState.mock ? 'mock' : 'stability';
}

export function status() {
  return {
    mock: aiState.mock, reason: aiState.reason, region: env.region,
    tryOn: !aiState.mock && env.falKey && env.tryOnProvider === 'fashn' ? 'fashn' : `${tryOnProvider()}:${env.geminiRenderModel}`,
    vision: aiState.mock ? 'mock' : (env.visionProvider === 'gemini' || aiState.claudeUnavailable ? env.geminiTextModel : env.claudeModel), claudeUnavailable: aiState.claudeUnavailable || undefined,
    models: { claude: env.claudeModel, geminiText: env.geminiTextModel, backgroundRemoval: env.bgModel, searchReplace: env.searchReplaceModel, gemini: aiState.gemini ? env.geminiModel : null },
  };
}

// ---------------- helpers ----------------
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Meta = { inTokens?: number; outTextTokens?: number; outImageTokens?: number; thoughtTokens?: number; modelVersion?: string; billed?: boolean };
/** Times a paid call, retries once on throttling, and records usage/cost for every attempt. */
async function timed<T>(what: string, model: string, fn: (meta: Meta) => Promise<T>): Promise<T> {
  const t = Date.now();
  for (let attempt = 0; ; attempt++) {
    const meta: Meta = {}; const ta = Date.now();
    const log = (ok: boolean) => { try { if (ok || meta.billed || meta.inTokens != null) record({ what, model, ok, ms: Date.now() - ta, ...meta }); } catch (e) { console.error('[usage] record failed', e); } };
    try {
      const r = await fn(meta);
      log(true);
      console.log(`[ai] ${what} ${model} ${Date.now() - t}ms`);
      return r;
    } catch (e: any) {
      log(false);
      const msg = String(e?.name || '') + ' ' + String(e?.message || e);
      const retriable = /Throttl|TooManyRequests|429|503|ServiceUnavailable|ModelNotReady|overloaded|RESOURCE_EXHAUSTED/i.test(msg);
      if (retriable && attempt < 1) { await sleep(2500); continue; }
      console.error(`[ai] ${what} ${model} FAILED after ${Date.now() - t}ms: ${msg.slice(0, 300)}`);
      throw e;
    }
  }
}

/** Simple concurrency limiter for background jobs. */
export function limiter(n: number) {
  let active = 0; const q: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= n) await new Promise<void>(r => q.push(r));
    active++;
    try { return await fn(); } finally { active--; q.shift()?.(); }
  };
}
export const bgJobs = limiter(3);

async function invokeJSON(modelId: string, body: unknown): Promise<any> {
  if (!client) throw new Error(`AWS Bedrock unavailable (${aiState.reason}). Run: aws sso login --profile ${process.env.AWS_PROFILE || '<profile>'}, then restart or POST /api/status/recheck`);
  const res = await client.send(new InvokeModelCommand({ modelId, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(body) }));
  return JSON.parse(new TextDecoder().decode(res.body));
}

function stabilityImage(out: any): Buffer {
  const b64 = out?.images?.[0];
  if (!b64) throw new Error('Stability returned no image: ' + JSON.stringify(out).slice(0, 300));
  if (out?.finish_reasons?.[0]) throw new Error('Stability finish_reason: ' + out.finish_reasons[0]);
  return Buffer.from(b64, 'base64');
}

export async function removeBackground(buf: Buffer): Promise<Buffer> {
  const img = await prep(buf, 1536, 'png');
  return timed('remove-bg', env.bgModel, async () =>
    stabilityImage(await invokeJSON(env.bgModel, { image: img.toString('base64'), output_format: 'png' })));
}

async function searchReplace(buf: Buffer, search: string, prompt: string): Promise<Buffer> {
  const img = await prep(buf, 1536, 'png');
  return timed('search-replace', env.searchReplaceModel, async () =>
    stabilityImage(await invokeJSON(env.searchReplaceModel, {
      image: img.toString('base64'), search_prompt: search, prompt, output_format: 'jpeg',
      negative_prompt: 'deformed, extra limbs, different person, blurry, text, watermark',
    })));
}

function extractJSON(text: string): any {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('no JSON in model output: ' + text.slice(0, 200));
  return JSON.parse(text.slice(s, e + 1));
}

async function geminiJSON(what: string, prompt: string, images: Buffer[], maxTokens: number): Promise<any> {
  const parts: any[] = [];
  for (const im of images) {
    const small = await sharp(im).rotate().resize(768, 768, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: small.toString('base64') } });
  }
  parts.push({ text: prompt });
  return timed(what, env.geminiTextModel, async meta => {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.geminiTextModel}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.geminiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: Math.max(2048, maxTokens * 4) } }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) { const err: any = new Error(`Gemini ${res.status}: ${JSON.stringify(json?.error || json).slice(0, 300)}`); err.status = res.status; throw err; }
    Object.assign(meta, fromGemini(json.usageMetadata), { modelVersion: json.modelVersion });
    const text = (json?.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('');
    return extractJSON(text);
  });
}

/** Vision/text JSON call: Claude on Bedrock, falling back to Gemini if Claude access is unavailable. */
async function claudeJSON(what: string, prompt: string, images: Buffer[] = [], maxTokens = 800): Promise<any> {
  const useGemini = env.visionProvider === 'gemini' || (env.visionProvider !== 'claude' && !!aiState.claudeUnavailable && aiState.gemini);
  if (useGemini || !client) {
    if (!aiState.gemini) throw new Error(aiState.claudeUnavailable || 'no vision model available');
    return geminiJSON(what, prompt, images, maxTokens);
  }
  try { return await claudeOnly(what, prompt, images, maxTokens); }
  catch (e: any) {
    const msg = String(e?.name) + ' ' + String(e?.message);
    if (/AccessDenied|ResourceNotFound|use case|not available for this account/i.test(msg) && aiState.gemini && env.visionProvider !== 'claude') {
      aiState.claudeUnavailable = 'Claude unavailable on Bedrock (' + String(e?.message).slice(0, 120) + ') — using Gemini';
      console.warn('[ai] ' + aiState.claudeUnavailable);
      return geminiJSON(what, prompt, images, maxTokens);
    }
    throw e;
  }
}

async function claudeOnly(what: string, prompt: string, images: Buffer[], maxTokens: number): Promise<any> {
  if (!client) throw new Error('Bedrock client not initialized');
  const content: ContentBlock[] = [];
  for (const im of images) {
    const small = await sharp(im).rotate().resize(768, 768, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    content.push({ image: { format: 'jpeg', source: { bytes: small } } });
  }
  content.push({ text: prompt });
  return timed(what, env.claudeModel, async meta => {
    const res = await client!.send(new ConverseCommand({
      modelId: env.claudeModel,
      messages: [{ role: 'user', content }],
      inferenceConfig: { maxTokens, temperature: 0.2 },
    }));
    meta.inTokens = res.usage?.inputTokens ?? 0; meta.outTextTokens = res.usage?.outputTokens ?? 0;
    const text = (res.output?.message?.content || []).map(c => ('text' in c ? c.text : '')).join('');
    return extractJSON(text);
  });
}

async function gemini(what: string, prompt: string, images: { buf: Buffer; label?: string }[], aspectRatio = '2:3', model = env.geminiModel): Promise<Buffer> {
  const parts: any[] = [];
  for (const im of images) {
    if (im.label) parts.push({ text: im.label });
    const jpg = await prep(im.buf, 1280, 'jpeg');
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: jpg.toString('base64') } });
  }
  parts.push({ text: prompt });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const call = async (withConfig: boolean, meta: Meta) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.geminiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(withConfig ? { imageConfig: { aspectRatio } } : {}) },
      }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) { const err: any = new Error(`Gemini ${res.status}: ${JSON.stringify(json?.error || json).slice(0, 300)}`); err.status = res.status; throw err; }
    Object.assign(meta, fromGemini(json.usageMetadata), { modelVersion: json.modelVersion });
    const outParts = json?.candidates?.[0]?.content?.parts || [];
    const img = outParts.find((p: any) => p.inlineData?.data || p.inline_data?.data);
    if (!img) throw new Error('Gemini returned no image: ' + JSON.stringify(json?.candidates?.[0]?.finishReason || outParts.map((p: any) => p.text).join(' ')).slice(0, 300));
    return Buffer.from((img.inlineData || img.inline_data).data, 'base64');
  };
  return timed(what, model, async meta => {
    try { return await call(true, meta); }
    catch (e: any) { if (e.status === 400) return call(false, meta); throw e; }
  });
}

// ---------------- prompts ----------------
const FORMALITY_SCALE = `Formality scale 1–10: 1 gym/athletic · 2 lounge · 3 casual (graphic tee, shorts, hoodie) · 4–5 smart casual (polo, dark jeans, clean leather sneakers, chinos, knit) · 6–7 business casual (oxford/button-down, chinos or wool trousers, loafers/derbies, merino sweater, unstructured blazer) · 8 business (suit separates, structured blazer, dress shoes) · 9–10 formal.`;
const GOAL = `The user is building a work wardrobe for a new job with a business-casual / smart-casual dress code (target formality band 4.5–7.5).`;

const SLOTS: Slot[] = ['top', 'bottom', 'layer', 'shoes', 'belt'];
const GC_BY_SLOT: Record<Slot, GarmentClass[]> = {
  top: ['UPPER_BODY', 'LONG_SLEEVE_SHIRT', 'SHORT_SLEEVE_SHIRT', 'NO_SLEEVE_SHIRT', 'OTHER_UPPER_BODY'],
  layer: ['UPPER_BODY', 'LONG_SLEEVE_SHIRT', 'OTHER_UPPER_BODY'],
  bottom: ['LOWER_BODY', 'LONG_PANTS', 'SHORT_PANTS', 'OTHER_LOWER_BODY'],
  shoes: ['FOOTWEAR', 'SHOES', 'BOOTS', 'OTHER_FOOTWEAR'],
  belt: ['BELT'],
};
const DEFAULT_GC: Record<Slot, GarmentClass> = { top: 'UPPER_BODY', layer: 'UPPER_BODY', bottom: 'LOWER_BODY', shoes: 'FOOTWEAR', belt: 'BELT' };
const PATTERNS: Pattern[] = ['solid', 'stripe', 'check', 'plaid', 'print', 'texture', 'other'];
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function normalizeTags(raw: any): ItemTags {
  const slot: Slot = SLOTS.includes(raw?.slot) ? raw.slot : 'top';
  const gc: GarmentClass = GC_BY_SLOT[slot].includes(raw?.garmentClass) ? raw.garmentClass : DEFAULT_GC[slot];
  const hex = /^#[0-9a-fA-F]{6}$/.test(raw?.primaryHex || '') ? raw.primaryHex : '#808080';
  return {
    slot, garmentClass: gc,
    type: String(raw?.type || 'garment').slice(0, 60),
    primaryColor: String(raw?.primaryColor || 'gray').toLowerCase().slice(0, 30),
    primaryHex: hex,
    secondaryColors: Array.isArray(raw?.secondaryColors) ? raw.secondaryColors.map(String).slice(0, 4) : [],
    pattern: PATTERNS.includes(raw?.pattern) ? raw.pattern : 'solid',
    material: raw?.material ? String(raw.material).slice(0, 40) : undefined,
    formality: Math.round(clamp(Number(raw?.formality) || 5, 1, 10) * 2) / 2,
    seasons: Array.isArray(raw?.seasons) ? raw.seasons.filter((s: any) => ['spring', 'summer', 'fall', 'winter'].includes(s)) : undefined,
    notes: raw?.notes ? String(raw.notes).slice(0, 200) : undefined,
  };
}

export const describe = (t?: ItemTags) =>
  t ? [t.primaryColor, t.pattern !== 'solid' ? t.pattern : '', t.material || '', t.type].filter(Boolean).join(' ') : 'garment';

// ---------------- mock helpers ----------------
function hash(s: string) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function mockTags(hint: string): ItemTags {
  const h = hash(hint); const s = hint.toLowerCase();
  const slot: Slot = /shoe|boot|loafer|sneaker|derby|oxford-shoe/.test(s) ? 'shoes'
    : /pant|jean|chino|trouser|short/.test(s) ? 'bottom'
    : /belt/.test(s) ? 'belt'
    : /jacket|blazer|coat|cardigan|sweater|vest/.test(s) ? 'layer'
    : /shirt|tee|polo|top|blouse|henley/.test(s) ? 'top' : SLOTS[h % 4];
  const colors: [string, string][] = [['navy', '#1f2a44'], ['white', '#f4f4f2'], ['light blue', '#a9c4e0'], ['charcoal', '#3a3d42'], ['khaki', '#c3b091'], ['brown', '#6b4a2f'], ['gray', '#8e9094'], ['cream', '#eee6d3']];
  const [c, hex] = colors[h % colors.length];
  const types: Record<Slot, string[]> = { top: ['oxford button-down', 'polo', 'poplin dress shirt', 'knit polo'], bottom: ['chinos', 'dark jeans', 'wool trousers'], layer: ['unstructured blazer', 'merino crewneck sweater', 'quarter-zip', 'chore jacket'], shoes: ['leather loafers', 'white leather sneakers', 'suede chukka boots', 'derbies'], belt: ['brown leather belt', 'black leather belt'] };
  const type = types[slot][(h >> 4) % types[slot].length];
  return normalizeTags({ slot, type, primaryColor: c, primaryHex: hex, pattern: (h >> 8) % 7 === 0 ? 'stripe' : 'solid', formality: 4 + ((h >> 12) % 7) / 2, notes: 'mock tags' });
}

// ---------------- high-level API ----------------
export async function studioizeItem(orig: Buffer): Promise<Buffer> {
  if (aiState.mock) return compositeItem(await toPng(await prep(orig, 1024, 'png')));
  if (aiState.gemini) {
    try { return await studioizeItemGemini(orig); } catch (e: any) { console.warn('[ai] gemini item-studio failed, falling back to bg removal:', e?.message); }
  }
  return compositeItem(await removeBackground(orig));
}

/** Re-render a casually photographed garment (on a hanger, held in hand, wrinkled, unbuttoned)
 *  as a clean, pressed e-commerce product photo. Falls back to background removal. */
export async function studioizeItemGemini(orig: Buffer, hint = ''): Promise<Buffer> {
  if (aiState.mock || !aiState.gemini) return compositeItem(await removeBackground(orig));
  const out = await gemini('item-studio',
    `This is a casual photo of a single clothing item${hint ? ` (${hint})` : ''}. Recreate this EXACT garment as a professional e-commerce product photo: ` +
    (env.garmentFit ? `This is a ${env.garmentFit} garment: show it in a ${env.garmentFit} cut, fit and proportions (shoulder width, sleeve length, straight body). ` : '') +
    `same color, fabric texture, pattern (scale and placement), collar, buttons, pockets, cuffs, logos and fit. ` +
    `Shirts: fully buttoned, neatly pressed, collar lying flat, shown on an invisible ghost mannequin, front view. ` +
    `Sweaters and knits: neatly shaped on an invisible ghost mannequin, front view. ` +
    `Pants: pressed, laid straight, front view, full length. ` +
    `Shoes: the pair side by side at a three-quarter angle, laces neat. Belts: laid in a neat loose coil or straight, buckle visible. ` +
    `Remove the hanger, hands, door and background entirely. Pure white background, soft even studio lighting, subtle shadow, centered, whole garment in frame, photorealistic, no text, no added accessories.`,
    [{ buf: orig }], '1:1');
  return sharp(out).resize(1024, 1024, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
}

/** Person studio photo. neutral=true → also dress in neutral base outfit. */
export async function studioizePerson(orig: Buffer, neutral = false): Promise<Buffer> {
  const p = tryOnProvider();
  if (p === 'mock') {
    const base = await compositePerson(await toPng(await prep(orig, 1248, 'png')));
    return neutral ? label(base, 'MOCK neutral base') : base;
  }
  if (!aiState.mock) {
    // Keep the person's real pixels (no regeneration) so face and body stay exact.
    // Without AWS (Gemini-only setups) the photo is used as-is, background included.
    if (!client) return compositePerson(await toPng(await prep(orig, 1248, 'png')));
    return compositePerson(await removeBackground(orig));
  }
  if (p === 'gemini') {
    const outfit = neutral ? ' Dress them in a plain heather-gray fitted crewneck t-shirt, slim charcoal chinos and plain white leather sneakers.' : ' Keep their current clothing.';
    return gemini(neutral ? 'neutral-base' : 'person-studio',
      `Create a full-body studio photograph of this exact same person: identical face, hair, skin tone, body shape and proportions. Head to toe fully in frame, standing straight facing the camera, arms relaxed slightly away from the body, neutral expression. Light gray seamless studio backdrop, soft even lighting, sharp focus, photorealistic, no text.${outfit}`,
      [{ buf: orig }]);
  }
  // stability fallback
  const studio = await compositePerson(await removeBackground(orig));
  if (!neutral) return studio;
  let out = await searchReplace(studio, 'shirt', 'plain heather gray fitted crewneck t-shirt, photorealistic, same person, studio photo');
  out = await searchReplace(out, 'pants', 'slim charcoal chino pants, photorealistic, same person, studio photo');
  return out;
}

export async function tagItem(studio: Buffer, hint = ''): Promise<ItemTags> {
  if (aiState.mock) return mockTags(hint || String(studio.length));
  const raw = await claudeJSON('tag-item', `You are a precise menswear/womenswear stylist cataloging a wardrobe. ${GOAL}
${FORMALITY_SCALE}
Look at this single clothing item (studio cutout) and return ONLY a JSON object:
{"slot": "top"|"bottom"|"layer"|"shoes"|"belt"   // layer = worn OVER a collared shirt: ALL sweaters/knit pullovers, cardigans, quarter-zips, blazers, jackets, vests. top = shirts, polos, tees.
 "garmentClass": one of ${JSON.stringify(Object.values(GC_BY_SLOT).flat().filter((v, i, a) => a.indexOf(v) === i))} consistent with slot,
 "type": short specific name e.g. "oxford button-down", "slim chinos", "suede chukka boots",
 "primaryColor": plain color name, "primaryHex": "#rrggbb", "secondaryColors": [names],
 "pattern": "solid"|"stripe"|"check"|"plaid"|"print"|"texture"|"other",
 "material": best guess, "formality": number 1–10 (halves ok), "seasons": [...], "notes": one short sentence on how to style it for business casual}`, [studio]);
  return normalizeTags(raw);
}

export async function readPriceTag(img: Buffer): Promise<{ price: number | null; brand?: string; text: string }> {
  if (aiState.mock) return { price: Math.round((19.99 + (hash(String(img.length)) % 50)) * 100) / 100, text: 'mock price tag' }; // eslint-disable-line
  const raw = await claudeJSON('price-tag', `This is a photo of a clothing price tag or price sticker in a store (e.g. Old Navy, Nordstrom Rack, Burlington). Return ONLY JSON: {"price": number|null, "brand": string|null, "text": "short transcription of relevant text"}.
"price" must be the CURRENT selling price the customer pays (if there is a compare-at / original / MSRP and a lower sale or clearance price, use the lowest current price; if several stickers are layered, use the top-most/newest). null if unreadable.`, [img], 300);
  const price = typeof raw?.price === 'number' && isFinite(raw.price) && raw.price > 0 ? Math.round(raw.price * 100) / 100 : null;
  return { price, brand: raw?.brand || undefined, text: String(raw?.text || '') };
}

export async function scoreOutfit(items: { slot: Slot; tags: ItemTags; image?: Buffer }[]): Promise<OutfitRating> {
  if (aiState.mock) {
    const f = items.reduce((a, i) => a + i.tags.formality, 0) / Math.max(1, items.length);
    const score = 55 + (hash(items.map(i => i.tags.type + i.tags.primaryColor).join()) % 40);
    return { score, formality: Math.round(f * 2) / 2, label: formalityLabel(f), notes: 'mock rating', source: 'ai' };
  }
  const desc = items.map(i => `${i.slot}: ${describe(i.tags)} (formality ${i.tags.formality})`).join('\n');
  const raw = await claudeJSON('score-outfit', `You are an honest, practical stylist. ${GOAL}
${FORMALITY_SCALE}
Rate this outfit (images are the items in order: ${items.map(i => i.slot).join(', ')}):
${desc}
Return ONLY JSON: {"score": 0-100 how well the pieces go together (color, pattern, proportion, formality coherence; 70+ = would confidently wear to work), "formality": overall 1–10, "notes": one or two short sentences: what works and the single best tweak}`,
    items.map(i => i.image).filter((b): b is Buffer => !!b), 400);
  const formality = clamp(Number(raw?.formality) || 5, 1, 10);
  return { score: Math.round(clamp(Number(raw?.score) || 50, 0, 100)), formality, label: formalityLabel(formality), notes: raw?.notes ? String(raw.notes) : undefined, source: 'ai' };
}

export async function scoreItemAgainstWardrobe(item: { id: string; tags: ItemTags }, wardrobe: { id: string; tags: ItemTags }[]): Promise<Record<string, number>> {
  const others = wardrobe.filter(w => w.id !== item.id && w.tags.slot !== item.tags.slot);
  if (!others.length) return {};
  if (aiState.mock) return Object.fromEntries(others.map(w => [w.id, 40 + (hash(item.id + w.id) % 60)]));
  const list = others.map(w => `${w.id}: ${w.tags.slot} — ${describe(w.tags)} (formality ${w.tags.formality})`).join('\n');
  const raw = await claudeJSON('compat', `You are a stylist. ${GOAL}
${FORMALITY_SCALE}
NEW ITEM: ${item.tags.slot} — ${describe(item.tags)} (formality ${item.tags.formality})
For each wardrobe item below, rate 0–100 how well it pairs with the NEW ITEM in a business-casual / smart-casual outfit (color harmony, pattern mixing, formality match; 70+ = good pairing).
${list}
Return ONLY a JSON object mapping each id to a number, e.g. {"abc": 82, "def": 35}.`, [], 1500);
  const out: Record<string, number> = {};
  for (const w of others) { const v = Number(raw?.[w.id]); if (isFinite(v)) out[w.id] = Math.round(clamp(v, 0, 100)); }
  return out;
}

const SLOT_WORDS: Record<Slot, string> = { top: 'shirt', bottom: 'pants', layer: 'jacket', shoes: 'shoes', belt: 'belt' };
const ORDER: Slot[] = ['bottom', 'top', 'layer', 'shoes', 'belt'];

// ---------------- FASHN (fal.ai) try-on: edits only the garment region, keeps face/body pixels ----------------
const sha = (b: Buffer | string) => createHash('sha1').update(b).digest('hex').slice(0, 16);
async function fashn(model: Buffer, garment: Buffer, category: 'tops' | 'bottoms'): Promise<Buffer> {
  const uri = async (b: Buffer) => 'data:image/jpeg;base64,' + (await sharp(b).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer()).toString('base64');
  return timed(`fashn-${category}`, 'fal-ai/fashn/tryon/v1.6', async () => {
    const res = await fetch('https://fal.run/fal-ai/fashn/tryon/v1.6', {
      method: 'POST', headers: { Authorization: `Key ${env.falKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model_image: await uri(model), garment_image: await uri(garment), category, mode: 'quality',
        garment_photo_type: 'flat-lay', segmentation_free: false, output_format: 'jpeg', seed: 42 }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`fal ${res.status} ${JSON.stringify(j).slice(0, 300)}`);
    const url = j.images?.[0]?.url; if (!url) throw new Error('fal returned no image');
    return Buffer.from(await (await fetch(url)).arrayBuffer());
  });
}
/** Chained try-on with on-disk caching of every prefix (bottom → top → layer), so e.g. a pants render is reused across shirts. */
async function fashnChain(base: Buffer, gs: { slot: Slot; image: Buffer }[]): Promise<Buffer> {
  let cur = base; let key = sha(base);
  for (const g of gs) {
    if (g.slot === 'shoes' || g.slot === 'belt') continue; // FASHN can't render these; shown on the outfit board
    key = sha(`${key}|${g.slot}|${sha(g.image)}`);
    const f = path.join(imagesDir, `vton-${key}.jpg`);
    if (fs.existsSync(f)) { cur = await fs.promises.readFile(f); continue; }
    cur = await fashn(cur, g.image, g.slot === 'bottom' ? 'bottoms' : 'tops');
    await fs.promises.writeFile(f, cur);
  }
  return cur;
}

/** Render a whole outfit on the base image. */
export async function renderOutfit(base: Buffer, garments: { slot: Slot; image: Buffer; tags?: ItemTags }[]): Promise<Buffer> {
  const gs = [...garments].sort((a, b) => ORDER.indexOf(a.slot) - ORDER.indexOf(b.slot));
  const p = tryOnProvider();
  if (!aiState.mock && env.falKey && env.tryOnProvider === 'fashn') return fashnChain(base, gs);
  if (p === 'mock') return label(base, 'MOCK try-on: ' + gs.map(g => describe(g.tags)).join(' + ').slice(0, 60));
  if (p === 'gemini') {
    const NAMES: Record<Slot, string> = { top: 'shirt/top (tucked in neatly if it is a button-down or dress shirt; sleeves full length; buttoned)', bottom: 'trousers (full length with a slight break over the shoes, not cropped)', layer: 'sweater/layer worn over the shirt (shirt collar visible at the neckline)', shoes: 'shoes', belt: 'belt' };
    const roles = gs.map((g, i) => `the ${NAMES[g.slot]} from Image ${i + 2}`).join('; ');
    return gemini('try-on',
      `CRITICAL: this must be the EXACT same real person from Image 1 — keep the face, facial features, smile, hair, skin tone, body build, height, limb proportions and pose faithful. Do not make the body heavier or change the face.
Dress them in exactly these items: ${roles}. Reproduce each item faithfully (color, pattern, texture, details). ${gs.some(g => g.slot === 'shoes') ? '' : 'Keep their current shoes.'} ${gs.some(g => g.slot === 'belt') ? '' : 'If a belt is visible keep a simple belt matching the shoes.'} Replace any clothing they currently wear in those categories.
Full-body photo head to toe, standing on a light gray seamless studio backdrop with a soft natural floor shadow, soft even lighting, photorealistic, like a real photo taken of them — not a render. No text.`,
      [{ buf: base, label: 'Image 1 (person):' }, ...gs.map((g, i) => ({ buf: g.image, label: `Image ${i + 2} (${g.slot}):` }))], '2:3', env.geminiRenderModel);
  }
  // stability fallback: sequential text-guided replace
  let cur = base;
  for (const g of gs) cur = await searchReplace(cur, SLOT_WORDS[g.slot], `${describe(g.tags)}, photorealistic, same person, same pose, studio photo`);
  return cur;
}
