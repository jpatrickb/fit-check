import fs from 'node:fs';
import path from 'node:path';
import { env } from './env';
import { DEFAULT_SETTINGS, type DB } from '../../shared/types';

export const imagesDir = path.join(env.dataDir, 'images');
fs.mkdirSync(imagesDir, { recursive: true });
const dbPath = path.join(env.dataDir, 'db.json');

function load(): DB {
  const empty: DB = { items: [], bases: [], outfits: {}, pairs: {}, settings: { ...DEFAULT_SETTINGS } };
  if (!fs.existsSync(dbPath)) return empty;
  try {
    const d = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    return { ...empty, ...d, settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) } };
  } catch (e) {
    console.error('db.json unreadable, backing up and starting fresh', e);
    fs.copyFileSync(dbPath, dbPath + '.corrupt-' + Date.now());
    return empty;
  }
}

export const db: DB = load();

// On restart, anything mid-processing was interrupted: mark it so the UI offers a retry.
for (const i of db.items) if (i.processing) { i.processing = false; i.error = i.error || 'interrupted — retry'; }
for (const b of db.bases) if (b.processing) { b.processing = false; b.error = b.error || 'interrupted — retry'; }

let chain: Promise<void> = Promise.resolve();
let dirty = false;
export function save(): Promise<void> {
  dirty = true;
  chain = chain.then(async () => {
    if (!dirty) return;
    dirty = false;
    const tmp = dbPath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(db));
    await fs.promises.rename(tmp, dbPath);
  }).catch(e => console.error('db save failed', e));
  return chain;
}
save();

export async function writeImage(name: string, buf: Buffer) {
  await fs.promises.writeFile(path.join(imagesDir, name), buf);
  return name;
}
export const readImage = (name: string) => fs.promises.readFile(path.join(imagesDir, name));
export const imageExists = (name: string) => fs.existsSync(path.join(imagesDir, name));
