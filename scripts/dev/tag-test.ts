import fs from 'node:fs'; import * as ai from '../../server/src/ai';
await ai.checkCredentials();
for (const f of process.argv.slice(2)) { const t = await ai.tagItem(fs.readFileSync(f)); console.log(f.split('/').pop(), JSON.stringify({slot:t.slot,type:t.type,color:t.primaryColor,pattern:t.pattern,material:t.material,formality:t.formality,notes:t.notes})); }
