import sharp from 'sharp';

/** EXIF-rotate, clamp size for model input (longest ≤ max, shortest ≥ 320). Returns PNG or JPEG. */
export async function prep(buf: Buffer, max = 1536, format: 'png' | 'jpeg' = 'jpeg'): Promise<Buffer> {
  let img = sharp(buf, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  // metadata() reports pre-rotation dims; rotate first into a buffer to be safe
  const rotated = await img.toBuffer();
  img = sharp(rotated);
  const m2 = await img.metadata();
  let w = m2.width || meta.width || 1024, h = m2.height || meta.height || 1024;
  const scale = Math.min(1, max / Math.max(w, h));
  w = Math.round(w * scale); h = Math.round(h * scale);
  const up = Math.max(1, 320 / Math.min(w, h));
  w = Math.round(w * up); h = Math.round(h * up);
  img = img.resize(w, h, { fit: 'fill' });
  return format === 'png' ? img.png().toBuffer() : img.flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer();
}

/** Trim transparent edges of a cutout and center it on a near-white square with a soft shadow. */
export async function compositeItem(cutoutPng: Buffer, size = 1024): Promise<Buffer> {
  let fg = sharp(cutoutPng).ensureAlpha();
  try { fg = sharp(await fg.trim({ threshold: 5 }).toBuffer()); } catch { /* trim fails on uniform images */ }
  const inner = Math.round(size * 0.84);
  const fgBuf = await fg.resize(inner, inner, { fit: 'inside' }).png().toBuffer();
  const fm = await sharp(fgBuf).metadata();
  const left = Math.round((size - (fm.width || inner)) / 2), top = Math.round((size - (fm.height || inner)) / 2);
  // shadow: blurred, faded alpha silhouette
  const a = await sharp(fgBuf).extractChannel('alpha').blur(16).linear(0.2, 0).png().toBuffer();
  const shadowFaded = await sharp({ create: { width: fm.width!, height: fm.height!, channels: 3, background: '#000000' } })
    .joinChannel(a).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: '#f7f6f3' } })
    .composite([
      { input: shadowFaded, left: left + 6, top: top + 14 },
      { input: fgBuf, left, top },
    ]).jpeg({ quality: 90 }).toBuffer();
}

/** Studio gray gradient portrait canvas behind a person cutout. */
export async function compositePerson(cutoutPng: Buffer, w = 832, h = 1248): Promise<Buffer> {
  let fg = sharp(cutoutPng).ensureAlpha();
  try { fg = sharp(await fg.trim({ threshold: 5 }).toBuffer()); } catch { /* ignore */ }
  const fgBuf = await fg.resize(Math.round(w * 0.9), Math.round(h * 0.92), { fit: 'inside' }).png().toBuffer();
  const fm = await sharp(fgBuf).metadata();
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><radialGradient id="g" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#e9e8e5"/><stop offset="1" stop-color="#c9c7c3"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`);
  return sharp(bg).composite([{ input: fgBuf, left: Math.round((w - fm.width!) / 2), top: h - fm.height! - Math.round(h * 0.03) }]).jpeg({ quality: 90 }).toBuffer();
}

/** Mock helper: put a small label on an image. */
export async function label(buf: Buffer, text: string): Promise<Buffer> {
  const m = await sharp(buf).metadata();
  const w = m.width || 800;
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="60"><rect width="100%" height="100%" fill="rgba(0,0,0,0.55)"/><text x="16" y="40" font-family="Helvetica" font-size="28" fill="#fff">${text.replace(/[<&>]/g, '')}</text></svg>`);
  return sharp(buf).composite([{ input: svg, left: 0, top: 0 }]).jpeg({ quality: 88 }).toBuffer();
}

/** Mock helper: fake cutout = image with white-ish background made transparent-ish (just returns PNG). */
export const toPng = (buf: Buffer) => sharp(buf).png().toBuffer();
