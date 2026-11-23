import './env';
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import { getCookie, setCookie } from 'hono/cookie';
import { createHash } from 'node:crypto';
import { serveStatic } from '@hono/node-server/serve-static';
import { customAlphabet } from 'nanoid';
const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 10);
import { env } from './env';
import { db, save, writeImage, readImage, imageExists, imagesDir } from './db';
import * as ai from './ai';
import { summary as usageSummary } from './usage';
import { startAutoBackup, backupNow } from './backup';
import { effectiveTags, outfitKey, pairKey, type Item, type BasePhoto, type Outfit, type OutfitPick, type Settings, type Slot } from '../../shared/types';

const app = new Hono();

// ---------------- auth ----------------
app.use('/api/*', async (c, next) => {
  if (!env.password) return next();
  // Header auth for API calls; an HttpOnly session cookie (set on header auth) for <img> requests,
  // so the password never appears in URLs.
  const token = createHash('sha256').update(`fitcheck:${env.password}`).digest('hex');
  if (c.req.header('x-app-password') === env.password) {
    setCookie(c, 'fc_session', token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/api', maxAge: 60 * 60 * 24 * 30 });
    return next();
  }
  if (getCookie(c, 'fc_session') === token) return next();
  return c.json({ error: 'unauthorized' }, 401);
});

// ---------------- helpers ----------------
const findItem = (id: string) => db.items.find(i => i.id === id);
const findBase = (id: string) => db.bases.find(b => b.id === id);
const hints = new Map<string, string>(); // item id -> original filename (mock slot guessing)

async function filesFrom(c: Context, field = 'image'): Promise<File[]> {
  const body = await c.req.parseBody({ all: true });
  const v = body[field] ?? body[field + '[]'];
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return arr.filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f);
}
async function bodyFields(c: Context) { return c.req.parseBody({ all: true }); }

async function storeUpload(f: File, prefix: string): Promise<string> {
  const buf = Buffer.from(await f.arrayBuffer());
  const ext = /png/i.test(f.type) ? 'png' : 'jpg';
  return writeImage(`${prefix}-${nanoid(10)}.${ext}`, buf);
}

function errMsg(e: any) { return String(e?.message || e).slice(0, 300); }

// ---------------- background jobs ----------------
async function processItem(id: string) {
  const item = findItem(id); if (!item) return;
  item.processing = true; item.error = undefined; save();
  try {
    await ai.bgJobs(async () => {
      const orig = await readImage(item.originalImage);
      if (!item.studioImage || !imageExists(item.studioImage)) {
        const studio = await ai.studioizeItem(orig);
        item.studioImage = await writeImage(`studio-${item.id}-${nanoid(6)}.jpg`, studio);
        save();
      }
      const studioBuf = await readImage(item.studioImage);
      item.tags = await ai.tagItem(studioBuf, hints.get(item.id) || '');
    });
    item.processing = false; save();
    if (item.status === 'candidate') computeCompat(item, true).catch(() => {}); // pre-warm for the Shop card (force: tags may have changed on retry)
  } catch (e) {
    item.processing = false; item.error = errMsg(e); save();
  }
}

// One AI compat call per item: dedupe concurrent requests (server pre-warm + Shop card) and reuse stored AI scores.
const compatInflight = new Map<string, Promise<Record<string, number>>>();
function computeCompat(item: Item, force = false): Promise<Record<string, number>> {
  const existing = Object.entries(db.pairs).filter(([k, v]) => v.source !== 'rules' && k.split('|').includes(item.id));
  if (!force && existing.length) return Promise.resolve(Object.fromEntries(existing.map(([k, v]) => [k.split('|').find(x => x !== item.id)!, v.score])));
  const cur = compatInflight.get(item.id); if (cur) return cur;
  const p = (async () => {
    const t = effectiveTags(item); if (!t) throw new Error('item not tagged yet');
    const wardrobe = db.items
      .filter(i => (i.status === 'owned' || i.status === 'bought') && i.id !== item.id && effectiveTags(i))
      .map(i => ({ id: i.id, tags: effectiveTags(i)! }));
    const scores = await ai.scoreItemAgainstWardrobe({ id: item.id, tags: t }, wardrobe);
    for (const [oid, score] of Object.entries(scores)) {
      const k = pairKey(item.id, oid);
      if (db.pairs[k]?.source === 'manual') continue;
      db.pairs[k] = { score, source: 'ai' };
    }
    save();
    return scores;
  })().finally(() => compatInflight.delete(item.id));
  compatInflight.set(item.id, p);
  return p;
}

async function processBase(id: string, neutral = false) {
  const base = findBase(id); if (!base) return;
  base.processing = true; base.error = undefined; save();
  try {
    await ai.bgJobs(async () => {
      if (!neutral) {
        const orig = await readImage(base.originalImage);
        base.studioImage = await writeImage(`base-${base.id}-${nanoid(6)}.jpg`, await ai.studioizePerson(orig, false));
      } else {
        const src = await readImage(base.originalImage);
        base.neutralImage = await writeImage(`neutral-${base.id}-${nanoid(6)}.jpg`, await ai.studioizePerson(src, true));
      }
    });
    base.processing = false;
    if (!db.settings.activeBaseId || !findBase(db.settings.activeBaseId)) db.settings.activeBaseId = base.id;
    save();
  } catch (e) {
    base.processing = false; base.error = errMsg(e); save();
  }
}

function pickItems(pick: OutfitPick) {
  const out: { slot: Slot; item: Item }[] = [];
  for (const slot of ['top', 'bottom', 'layer', 'shoes', 'belt'] as Slot[]) {
    const id = pick[slot]; if (!id) continue;
    const item = findItem(id); if (!item) throw new Error(`unknown item ${id}`);
    out.push({ slot, item });
  }
  if (!out.length) throw new Error('empty outfit');
  return out;
}

function getOutfit(pick: OutfitPick): Outfit {
  const id = outfitKey(pick);
  return (db.outfits[id] ||= { id, pick: { ...pick } });
}

function activeBaseFile(): string {
  const base = db.settings.activeBaseId ? findBase(db.settings.activeBaseId) : db.bases.find(b => b.studioImage);
  if (!base) throw new Error('No base photo yet — add one on the Me tab');
  const f = db.settings.useNeutralBase && base.neutralImage ? base.neutralImage : base.studioImage;
  if (!f) throw new Error('Base photo is still processing');
  return f;
}

const inflightRenders = new Map<string, Promise<string>>();

// ---------------- routes ----------------
app.get('/api/db', c => c.json(db));
app.get('/api/status', c => c.json(ai.status()));
app.get('/api/usage', c => c.json(usageSummary(Number(c.req.query('since')) || 0)));
app.post('/api/status/recheck', async c => { await ai.checkCredentials(); return c.json(ai.status()); });

app.get('/api/images/:file', async c => {
  const file = path.basename(c.req.param('file'));
  if (!imageExists(file)) return c.json({ error: 'not found' }, 404);
  const buf = await readImage(file);
  return c.body(new Uint8Array(buf), 200, {
    'content-type': file.endsWith('.png') ? 'image/png' : 'image/jpeg',
    'cache-control': 'private, max-age=31536000, immutable',
  });
});

app.post('/api/items', async c => {
  const body = await bodyFields(c);
  const files = await filesFrom(c);
  if (!files.length) return c.json({ error: 'no image' }, 400);
  const status = body.status === 'candidate' ? 'candidate' : 'owned';
  const price = body.price != null && body.price !== '' ? Number(body.price) : undefined;
  const store = typeof body.store === 'string' && body.store ? body.store : undefined;
  const created: Item[] = [];
  for (const f of files) {
    const item: Item = {
      id: nanoid(10), status, createdAt: Date.now(), originalImage: await storeUpload(f, 'orig'), processing: true,
      ...(status === 'candidate' ? { price: price != null && isFinite(price) ? price : undefined, store, rank: Date.now() } : {}),
    };
    hints.set(item.id, f.name || '');
    db.items.push(item); created.push(item);
  }
  save();
  for (const i of created) processItem(i.id);
  return c.json(created);
});

const ITEM_FIELDS = ['status', 'manualTags', 'price', 'store', 'starred', 'rank'] as const;
app.patch('/api/items/:id', async c => {
  const item = findItem(c.req.param('id')); if (!item) return c.json({ error: 'not found' }, 404);
  const patch = await c.req.json();
  for (const k of ITEM_FIELDS) if (k in patch) (item as any)[k] = patch[k];
  if (patch.manualTags === null) item.manualTags = undefined;
  save();
  return c.json(item);
});

app.delete('/api/items/:id', c => {
  const id = c.req.param('id');
  const idx = db.items.findIndex(i => i.id === id);
  if (idx < 0) return c.json({ error: 'not found' }, 404);
  db.items.splice(idx, 1);
  for (const k of Object.keys(db.pairs)) if (k.split('|').includes(id)) delete db.pairs[k];
  save();
  return c.json({ ok: true });
});

app.post('/api/items/:id/retry', c => {
  const item = findItem(c.req.param('id')); if (!item) return c.json({ error: 'not found' }, 404);
  item.studioImage = undefined; item.error = undefined; item.tryOnImage = undefined;
  // renders made from the old studio image are stale
  for (const o of Object.values(db.outfits)) if (Object.values(o.pick).includes(item.id)) o.renders = undefined;
  processItem(item.id);
  return c.json(item);
});

app.post('/api/items/:id/price-tag', async c => {
  const item = findItem(c.req.param('id')); if (!item) return c.json({ error: 'not found' }, 404);
  const [f] = await filesFrom(c); if (!f) return c.json({ error: 'no image' }, 400);
  item.priceTagImage = await storeUpload(f, 'tag');
  try {
    const r = await ai.readPriceTag(await readImage(item.priceTagImage));
    if (r.price != null) item.price = r.price;
    save();
    return c.json({ price: r.price, text: r.text, item });
  } catch (e) {
    save();
    return c.json({ price: null, text: 'Could not read tag: ' + errMsg(e), item });
  }
});

app.post('/api/items/:id/compat', async c => {
  const item = findItem(c.req.param('id')); if (!item) return c.json({ error: 'not found' }, 404);
  try { return c.json(await computeCompat(item)); }
  catch (e) { return c.json({ error: errMsg(e) }, 400); }
});

app.post('/api/bases', async c => {
  const [f] = await filesFrom(c); if (!f) return c.json({ error: 'no image' }, 400);
  const base: BasePhoto = { id: nanoid(10), originalImage: await storeUpload(f, 'person'), processing: true };
  db.bases.push(base); save();
  processBase(base.id);
  return c.json(base);
});

app.post('/api/bases/:id/neutral', c => {
  const base = findBase(c.req.param('id')); if (!base) return c.json({ error: 'not found' }, 404);
  processBase(base.id, true);
  return c.json(base);
});

app.post('/api/bases/:id/retry', c => {
  const base = findBase(c.req.param('id')); if (!base) return c.json({ error: 'not found' }, 404);
  processBase(base.id);
  return c.json(base);
});

app.delete('/api/bases/:id', c => {
  const id = c.req.param('id');
  db.bases = db.bases.filter(b => b.id !== id);
  if (db.settings.activeBaseId === id) db.settings.activeBaseId = db.bases[0]?.id;
  save();
  return c.json({ ok: true });
});

app.patch('/api/settings', async c => {
  const patch = (await c.req.json()) as Partial<Settings>;
  Object.assign(db.settings, patch);
  save();
  return c.json(db.settings);
});

app.post('/api/outfits/rate', async c => {
  const { pick, force } = await c.req.json();
  try {
    const parts = pickItems(pick);
    const outfit = getOutfit(pick);
    if (outfit.aiRating && !force) return c.json(outfit);
    const items = await Promise.all(parts.map(async p => {
      const tags = effectiveTags(p.item); if (!tags) throw new Error('an item is still processing');
      return { slot: p.slot, tags, image: p.item.studioImage ? await readImage(p.item.studioImage) : undefined };
    }));
    outfit.aiRating = await ai.scoreOutfit(items);
    save();
    return c.json(outfit);
  } catch (e) { return c.json({ error: errMsg(e) }, 400); }
});

app.post('/api/outfits/render', async c => {
  const { pick, force } = await c.req.json();
  try {
    const parts = pickItems(pick);
    const baseFile = activeBaseFile();
    const outfit = getOutfit(pick);
    if (!force && outfit.renders?.[baseFile] && imageExists(outfit.renders[baseFile])) return c.json(outfit);
    const key = baseFile + ':' + parts.map(p => p.item.id).sort().join(',');
    let job = inflightRenders.get(key);
    if (!job) {
      job = (async () => {
        const garments = await Promise.all(parts.map(async p => ({
          slot: p.slot, tags: effectiveTags(p.item),
          image: await readImage(p.item.studioImage || p.item.originalImage),
        })));
        const out = await ai.renderOutfit(await readImage(baseFile), garments);
        return writeImage(`render-${nanoid(10)}.jpg`, out);
      })().finally(() => inflightRenders.delete(key));
      inflightRenders.set(key, job);
    }
    const file = await job;
    outfit.renders = { ...(outfit.renders || {}), [baseFile]: file };
    save();
    return c.json(outfit);
  } catch (e) { return c.json({ error: errMsg(e) }, 400); }
});

app.patch('/api/outfits/:id', async c => {
  const patch = (await c.req.json()) as Partial<Outfit>;
  let outfit = db.outfits[c.req.param('id')];
  if (!outfit) {
    if (!patch.pick) return c.json({ error: 'outfit not found; include pick' }, 400);
    outfit = getOutfit(patch.pick);
  }
  for (const k of ['thumbs', 'manualRating', 'saved'] as const) if (k in patch) (outfit as any)[k] = (patch as any)[k] ?? undefined;
  save();
  return c.json(outfit);
});

app.onError((e, c) => { console.error(e); return c.json({ error: errMsg(e) }, 500); });

// ---------------- static (production) ----------------
const dist = path.resolve('web/dist');
if (env.production && fs.existsSync(dist)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), dist) }));
  app.get('*', c => c.html(fs.readFileSync(path.join(dist, 'index.html'), 'utf8')));
}

await ai.checkCredentials();
if (!env.forceMock) startAutoBackup(env.dataDir); // mock/demo data never touches your real backups
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { save().finally(() => { try { backupNow(env.dataDir); } catch {} process.exit(0); }); });

// Without a password, only accept local connections (no LAN access); phone.ts also refuses to open a tunnel.
const host = env.password ? '0.0.0.0' : '127.0.0.1';
if (!env.password) console.warn('[server] APP_PASSWORD not set: listening on 127.0.0.1 only. Set it in .env to use the app from your phone.');
serve({ fetch: app.fetch, port: env.port, hostname: host }, info => {
  console.log(`[server] http://localhost:${info.port}  data=${env.dataDir}  images=${imagesDir}  mock=${ai.aiState.mock}  tryOn=${ai.tryOnProvider()}`);
});
