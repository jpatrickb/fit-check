// Usage: npx tsx scripts/bakeoff.ts <outDir> <base> <top> <bottom> <shoes> <belt> <fashnRender>
import fs from 'node:fs'; import path from 'node:path'; import sharp from 'sharp';
import '../../server/src/env';
const [out, baseF, topF, bottomF, shoesF, beltF, fashnF] = process.argv.slice(2);
const KEY = process.env.GEMINI_API_KEY!;
const jpg = async (f: string) => (await sharp(fs.readFileSync(f)).resize(1280, 1280, { fit: 'inside' }).jpeg({ quality: 90 }).toBuffer()).toString('base64');
async function gem(model: string, name: string, prompt: string, imgs: [string, string][]) {
  const parts: any[] = [];
  for (const [label, f] of imgs) { parts.push({ text: label }); parts.push({ inline_data: { mime_type: 'image/jpeg', data: await jpg(f) } }); }
  parts.push({ text: prompt });
  const t = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '2:3' } } }) });
  const j: any = await res.json();
  const p = j?.candidates?.[0]?.content?.parts?.find((x: any) => x.inlineData || x.inline_data);
  if (!p) { console.log(name, 'FAILED', JSON.stringify(j).slice(0, 300)); return; }
  fs.writeFileSync(path.join(out, name + '.jpg'), Buffer.from((p.inlineData || p.inline_data).data, 'base64'));
  console.log(name, model, Date.now() - t, 'ms');
}
const IDENTITY = `CRITICAL: this must be the EXACT same real person from Image 1 — keep the face, facial features, smile, hair, skin tone, body build (slim), height, limb proportions and pose pixel-faithful. Do not make the body heavier or change the face.`;
const OUTFIT = `Dress them in exactly these items: the shirt from Image 2 (tucked in neatly, sleeves full length to the wrist, buttoned), the trousers from Image 3 (full length with a slight break over the shoes, not cropped), the shoes from Image 4, the belt from Image 5. Reproduce each item faithfully (color, pattern, texture, details). Remove the watch is NOT needed — keep it.`;
const SCENE = `Full-body photo head to toe, standing on a light gray seamless studio backdrop with a soft natural floor shadow, soft even lighting, photorealistic, like a real photo taken of them — not a render. No text.`;
const imgs: [string, string][] = [['Image 1 (person):', baseF], ['Image 2 (shirt):', topF], ['Image 3 (trousers):', bottomF], ['Image 4 (shoes):', shoesF], ['Image 5 (belt):', beltF]];
await Promise.all([
  gem('gemini-3-pro-image', 'A-gemini-pro-full', `${IDENTITY}\n${OUTFIT}\n${SCENE}`, imgs),
  gem('gemini-3.1-flash-image', 'B-gemini-flash-full', `${IDENTITY}\n${OUTFIT}\n${SCENE}`, imgs),
  gem('gemini-3-pro-image', 'C-fashn-then-pro-fix', `Image 1 is a try-on photo of a real person; Image 2 is the original photo of the same person. Edit Image 1 minimally: restore the face, hair and body build exactly as in Image 2; make the trousers full length with a slight break; replace the shoes with the shoes in Image 3 and the belt with the belt in Image 4. Keep the shirt, trouser color, pose and everything else identical. ${SCENE}`,
    [['Image 1 (try-on):', fashnF], ['Image 2 (original person):', baseF], ['Image 3 (shoes):', shoesF], ['Image 4 (belt):', beltF]]),
]);
