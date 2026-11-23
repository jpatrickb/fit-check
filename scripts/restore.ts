// npm run restore              — list db snapshots in BACKUP_DIR
// npm run restore -- latest    — restore newest snapshot (+ any missing images) into data/
// npm run restore -- <file>    — restore a specific db-<stamp>.json
// Stop the server first. The current db.json is kept as data/db.before-restore-<stamp>.json.
import '../server/src/env';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { defaultBackupDir } from '../server/src/backup';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const backupDir = defaultBackupDir();
const dbDir = path.join(backupDir, 'db');
const snaps = fs.existsSync(dbDir) ? fs.readdirSync(dbDir).filter(f => /^db-.*\.json$/.test(f)).sort() : [];
const arg = process.argv[2];

if (!arg) {
  if (!snaps.length) { console.log(`No snapshots in ${dbDir}`); process.exit(0); }
  for (const f of snaps.slice(-25)) {
    const d = JSON.parse(fs.readFileSync(path.join(dbDir, f), 'utf8'));
    console.log(`${f}  items=${d.items?.length ?? 0} photos=${d.bases?.length ?? 0} outfits=${Object.keys(d.outfits || {}).length}`);
  }
  console.log(`\n${snaps.length} snapshots. Restore with: npm run restore -- latest   (or a file name)`);
  process.exit(0);
}

const port = Number(process.env.PORT || 8787);
const inUse = await new Promise<boolean>(res => { const s = net.connect(port, '127.0.0.1', () => { s.end(); res(true); }).on('error', () => res(false)); });
if (inUse) { console.error(`Server is running on :${port}. Stop it first (it would overwrite the restored db).`); process.exit(1); }

const file = arg === 'latest' ? snaps.at(-1) : path.basename(arg);
if (!file || !fs.existsSync(path.join(dbDir, file))) { console.error(`Snapshot not found: ${arg}`); process.exit(1); }

fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
const cur = path.join(dataDir, 'db.json');
if (fs.existsSync(cur)) fs.copyFileSync(cur, path.join(dataDir, `db.before-restore-${Date.now()}.json`));
fs.copyFileSync(path.join(dbDir, file), cur);

let n = 0;
const imgBak = path.join(backupDir, 'images');
if (fs.existsSync(imgBak)) for (const f of fs.readdirSync(imgBak)) {
  const dst = path.join(dataDir, 'images', f);
  if (!fs.existsSync(dst)) { fs.copyFileSync(path.join(imgBak, f), dst); n++; }
}
console.log(`Restored ${file} into ${dataDir} (+${n} missing images).`);
