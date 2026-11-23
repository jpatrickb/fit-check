// Usage: node scripts/contact-sheet.mjs <dir-of-jpgs> <out.jpg> [cols]
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const [dir, out, colsArg] = process.argv.slice(2);
const files = fs.readdirSync(dir).filter(f => /\.(jpe?g|png)$/i.test(f)).sort();
const W = 200, H = 260, cols = Number(colsArg) || 8, rows = Math.ceil(files.length / cols);
const comps = [];
for (const [i, f] of files.entries()) {
  const img = await sharp(path.join(dir, f)).rotate().resize(W, H - 24, { fit: 'contain', background: '#fff' }).toBuffer();
  const x = (i % cols) * W, y = Math.floor(i / cols) * H;
  comps.push({ input: img, left: x, top: y });
  const label = f.replace(/\.(jpe?g|png)$/i, '');
  comps.push({ input: Buffer.from(`<svg width="${W}" height="24"><text x="4" y="17" font-size="15" font-family="Arial">${label}</text></svg>`), left: x, top: y + H - 24 });
}
await sharp({ create: { width: cols * W, height: rows * H, channels: 3, background: '#fff' } })
  .composite(comps).jpeg({ quality: 80 }).toFile(out);
console.log(`${files.length} images, ${rows} rows -> ${out}`);
