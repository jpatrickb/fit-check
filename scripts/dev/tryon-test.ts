// Usage: npx tsx scripts/tryon-test.ts <outDir> <person.jpg> <top.jpg> <bottom.jpg>
import fs from 'node:fs'; import path from 'node:path'; import * as ai from '../../server/src/ai';
const [out, person, top, bottom] = process.argv.slice(2);
await ai.checkCredentials();
const studio = await ai.studioizePerson(fs.readFileSync(person));
fs.writeFileSync(path.join(out, '1-studio-me.jpg'), studio);
const tagsTop = await ai.tagItem(fs.readFileSync(top)); const tagsBottom = await ai.tagItem(fs.readFileSync(bottom));
const render = await ai.renderOutfit(studio, [
  { slot: 'top', image: fs.readFileSync(top), tags: tagsTop },
  { slot: 'bottom', image: fs.readFileSync(bottom), tags: tagsBottom },
]);
fs.writeFileSync(path.join(out, '2-tryon.jpg'), render);
