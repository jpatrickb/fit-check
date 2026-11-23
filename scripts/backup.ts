// npm run backup  — snapshot data/ into BACKUP_DIR (default ~/FitCheck-backups). Safe to run while the server is up.
import '../server/src/env';
import path from 'node:path';
import { backupNow } from '../server/src/backup';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const r = backupNow(dataDir);
console.log(`Backed up ${dataDir} -> ${r.dir}\n  new images: ${r.images}\n  db snapshot: ${r.db ? path.basename(r.db) : 'unchanged since last snapshot'}`);
