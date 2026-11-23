// Local backups of the data folder, outside the repo (never in git).
//   BACKUP_DIR/images/*          every image ever written (images are immutable, so this is incremental: only new files are copied)
//   BACKUP_DIR/db/db-<stamp>.json  a snapshot of db.json each time it changed (newest KEEP kept)
//   BACKUP_DIR/usage.jsonl       copy of the AI cost ledger
// Runs on server start and every 30 minutes while the server is up. Also: `npm run backup`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const KEEP = 200;
export const defaultBackupDir = () => path.resolve((process.env.BACKUP_DIR || path.join(os.homedir(), 'FitCheck-backups')).replace(/^~(?=$|\/)/, os.homedir()));
const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');

export function backupNow(dataDir: string, backupDir = defaultBackupDir()): { images: number; db: string | null; dir: string } {
  const imgSrc = path.join(dataDir, 'images'), imgDst = path.join(backupDir, 'images'), dbDst = path.join(backupDir, 'db');
  fs.mkdirSync(imgDst, { recursive: true }); fs.mkdirSync(dbDst, { recursive: true });

  let images = 0;
  if (fs.existsSync(imgSrc)) {
    const have = new Set(fs.readdirSync(imgDst));
    for (const f of fs.readdirSync(imgSrc)) if (!have.has(f)) { fs.copyFileSync(path.join(imgSrc, f), path.join(imgDst, f)); images++; }
  }

  let snap: string | null = null;
  const dbSrc = path.join(dataDir, 'db.json');
  if (fs.existsSync(dbSrc)) {
    const buf = fs.readFileSync(dbSrc);
    let empty = false;
    try { const d = JSON.parse(buf.toString('utf8')); empty = !d.items?.length && !d.bases?.length; } catch { /* snapshot unreadable files too */ }
    const snaps = fs.readdirSync(dbDst).filter(f => /^db-.*\.json$/.test(f)).sort();
    const last = snaps.at(-1);
    const hash = (b: Buffer) => createHash('sha1').update(b).digest('hex');
    if (!empty && (!last || hash(fs.readFileSync(path.join(dbDst, last))) !== hash(buf))) {
      snap = path.join(dbDst, `db-${stamp()}.json`);
      fs.writeFileSync(snap, buf);
      snaps.push(path.basename(snap));
    }
    for (const old of snaps.slice(0, Math.max(0, snaps.length - KEEP))) fs.rmSync(path.join(dbDst, old));
  }

  const usage = path.join(dataDir, 'usage.jsonl');
  if (fs.existsSync(usage)) fs.copyFileSync(usage, path.join(backupDir, 'usage.jsonl'));
  return { images, db: snap, dir: backupDir };
}

export function startAutoBackup(dataDir: string) {
  const run = () => {
    try {
      const r = backupNow(dataDir);
      if (r.images || r.db) console.log(`[backup] ${r.dir}: +${r.images} images${r.db ? ', db snapshot ' + path.basename(r.db) : ''}`);
    } catch (e) { console.error('[backup] failed', e); }
  };
  run();
  setInterval(run, 30 * 60 * 1000).unref();
}
