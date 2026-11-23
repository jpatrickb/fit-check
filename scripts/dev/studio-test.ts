// Usage: npx tsx scripts/studio-test.ts <outDir> <img.jpg>...  -> writes <name>.bgremove.jpg and <name>.gemini.jpg
import fs from 'node:fs'; import path from 'node:path';
import * as ai from '../../server/src/ai';
const [outDir, ...files] = process.argv.slice(2);
await ai.checkCredentials();
await Promise.all(files.map(async f => {
  const buf = fs.readFileSync(f); const name = path.basename(f, path.extname(f));
  const [a, b] = await Promise.allSettled([ai.studioizeItem(buf), ai.studioizeItemGemini(buf)]);
  if (a.status === 'fulfilled') fs.writeFileSync(path.join(outDir, `${name}.a-bgremove.jpg`), a.value); else console.error(name, 'bgremove', a.reason?.message);
  if (b.status === 'fulfilled') fs.writeFileSync(path.join(outDir, `${name}.b-gemini.jpg`), b.value); else console.error(name, 'gemini', b.reason?.message);
}));
