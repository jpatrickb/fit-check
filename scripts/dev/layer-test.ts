// Paper-doll layering test.
// Usage: npx tsx scripts/layer-test.ts <outDir> <person.jpg> <top1.jpg> <top2.jpg> <bottom.jpg>
import fs from 'node:fs'; import path from 'node:path'; import sharp from 'sharp';
import * as ai from '../../server/src/ai';
import { compositePerson } from '../../server/src/images';
import { env } from '../../server/src/env';

const [out, personF, top1F, top2F, bottomF] = process.argv.slice(2);
const FAL_KEY = process.env.FAL_KEY || (env as any).falKey;
if (!FAL_KEY) throw new Error('FAL_KEY missing');
const W = 832, H = 1248;
const save = (n: string, b: Buffer) => fs.writeFileSync(path.join(out, n), b);
const dataUri = async (b: Buffer) => 'data:image/jpeg;base64,' + (await sharp(b).jpeg({ quality: 92 }).toBuffer()).toString('base64');

async function fashn(model: Buffer, garment: Buffer, category: 'tops' | 'bottoms') {
  const t = Date.now();
  const res = await fetch('https://fal.run/fal-ai/fashn/tryon/v1.6', {
    method: 'POST', headers: { Authorization: `Key ${FAL_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model_image: await dataUri(model), garment_image: await dataUri(garment), category, mode: 'balanced',
      garment_photo_type: 'flat-lay', segmentation_free: false, output_format: 'png', seed: 42 }),
  });
  const j: any = await res.json();
  if (!res.ok) throw new Error(`fal ${res.status} ${JSON.stringify(j).slice(0, 300)}`);
  const url = j.images?.[0]?.url;
  const img = Buffer.from(await (await fetch(url)).arrayBuffer());
  const meta = await sharp(img).metadata();
  console.log(`[fal] fashn ${category} ${Date.now() - t}ms out=${meta.width}x${meta.height}`);
  return sharp(img).resize(W, H, { fit: 'fill' }).removeAlpha().png().toBuffer();
}

/** Garment layer = pixels that changed vs. the base, as an RGBA PNG. */
async function extractLayer(base: Buffer, render: Buffer, name: string) {
  const a = await sharp(base).removeAlpha().raw().toBuffer();
  const b = await sharp(render).removeAlpha().raw().toBuffer();
  const mask = Buffer.alloc(W * H);
  for (let i = 0, p = 0; p < W * H; p++, i += 3) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    mask[p] = d > 45 ? 255 : 0;
  }
  // clean up: close small holes, drop specks, feather edge
  const cleaned = await sharp(mask, { raw: { width: W, height: H, channels: 1 } })
    .median(5).blur(4).threshold(100).blur(1.2).toColourspace('b-w').raw().toBuffer();
  save(`${name}.mask.png`, await sharp(cleaned, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer());
  const rgba = await sharp(b, { raw: { width: W, height: H, channels: 3 } }).joinChannel(cleaned, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  save(`${name}.layer.png`, rgba);
  return rgba;
}

await ai.checkCredentials();
// 1. exact base (no regeneration)
const cut = await ai.removeBackground(fs.readFileSync(personF));
const base = await sharp(await compositePerson(cut, W, H)).resize(W, H).png().toBuffer();
save('1-base.png', base);

// 2. garment studio image for top2 (top1/bottom already studio)
const top2 = await ai.studioizeItemGemini(fs.readFileSync(top2F));
save('top2-studio.jpg', top2);

// 3. one render per item on the base
const [r1, r2, rb] = await Promise.all([
  fashn(base, fs.readFileSync(top1F), 'tops'),
  fashn(base, top2, 'tops'),
  fashn(base, fs.readFileSync(bottomF), 'bottoms'),
]);
save('2-render-top1.png', r1); save('2-render-top2.png', r2); save('2-render-bottom.png', rb);
const [L1, L2, LB] = await Promise.all([extractLayer(base, r1, 'top1'), extractLayer(base, r2, 'top2'), extractLayer(base, rb, 'bottom')]);

// 4. free composites
const stack = (layers: Buffer[]) => sharp(base).composite(layers.map(input => ({ input }))).jpeg({ quality: 90 }).toBuffer();
save('3-composite-top1+bottom.jpg', await stack([LB, L1]));
save('3-composite-top2+bottom.jpg', await stack([LB, L2]));

// 5. "HD" chained render for comparison: bottom render, then top1 on top of it
save('4-hd-chained-top1+bottom.jpg', await sharp(await fashn(rb, fs.readFileSync(top1F), 'tops')).jpeg({ quality: 90 }).toBuffer());
console.log('done');
