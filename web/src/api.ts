import type { BasePhoto, DB, Item, Outfit, OutfitPick, Settings } from '../../shared/types';

const PW_KEY = 'fitcheck-pw';
export const getPw = () => { try { return localStorage.getItem(PW_KEY) || ''; } catch { return ''; } };
export const setPw = (p: string) => { try { localStorage.setItem(PW_KEY, p); } catch { /* ignore */ } };

export class AuthError extends Error {}

/** Tracks in-flight requests so the app can poll faster while work is pending. */
let inflight = 0;
const listeners = new Set<(n: number) => void>();
export const onInflight = (fn: (n: number) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const bump = (d: number) => { inflight += d; listeners.forEach(l => l(inflight)); };

async function req<T>(path: string, init: RequestInit = {}, track = false): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-app-password', getPw());
  if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  if (track) bump(1);
  try {
    const r = await fetch(path, { ...init, headers });
    if (r.status === 401) {
      window.dispatchEvent(new Event('fitcheck-auth'));
      throw new AuthError('Password required');
    }
    if (!r.ok) {
      let msg = r.statusText;
      try { const t = await r.text(); msg = t || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    return (await r.json()) as T;
  } finally {
    if (track) bump(-1);
  }
}

export const img = (f?: string) =>
  f ? `/api/images/${encodeURIComponent(f)}` : '';

/** Downscale a phone photo to keep uploads fast over the tunnel. Respects EXIF orientation. */
export async function downscale(file: File | Blob, max = 1600): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}

const json = (body: unknown) => JSON.stringify(body);

export const api = {
  db: () => req<DB>('/api/db'),
  usage: () => req<{ total: number; calls: number; unpriced: number; byWhat: Record<string, { calls: number; cost: number; failed: number }>; byDay: Record<string, number> }>('/api/usage'),
  status: () => req<{ mock: boolean; region?: string; models?: Record<string, string> }>('/api/status'),

  async addItems(files: (File | Blob)[], status: 'owned' | 'candidate', extra: { price?: number; store?: string } = {}) {
    const fd = new FormData();
    for (const f of files) {
      const small = await downscale(f);
      fd.append('image', small, `${(f as File).name?.replace(/\.[^.]+$/, '') || 'photo'}.jpg`);
    }
    fd.append('status', status);
    if (extra.price != null && !Number.isNaN(extra.price)) fd.append('price', String(extra.price));
    if (extra.store) fd.append('store', extra.store);
    return req<Item[]>('/api/items', { method: 'POST', body: fd }, true);
  },
  patchItem: (id: string, body: Partial<Item>) =>
    req<Item>(`/api/items/${id}`, { method: 'PATCH', body: json(body) }),
  deleteItem: (id: string) => req<{ ok: true }>(`/api/items/${id}`, { method: 'DELETE' }),
  retryItem: (id: string) => req<Item>(`/api/items/${id}/retry`, { method: 'POST' }, true),
  async priceTag(id: string, file: File) {
    const fd = new FormData();
    fd.append('image', await downscale(file), 'tag.jpg');
    return req<{ price: number | null; text: string; item: Item }>(`/api/items/${id}/price-tag`, { method: 'POST', body: fd }, true);
  },
  compat: (id: string) => req<Record<string, number>>(`/api/items/${id}/compat`, { method: 'POST' }, true),

  async addBase(file: File) {
    const fd = new FormData();
    fd.append('image', await downscale(file, 2000), 'me.jpg');
    return req<BasePhoto>('/api/bases', { method: 'POST', body: fd }, true);
  },
  neutral: (id: string) => req<BasePhoto>(`/api/bases/${id}/neutral`, { method: 'POST' }, true),
  deleteBase: (id: string) => req<{ ok: true }>(`/api/bases/${id}`, { method: 'DELETE' }),

  patchSettings: (body: Partial<Settings>) =>
    req<Settings>('/api/settings', { method: 'PATCH', body: json(body) }),

  rate: (pick: OutfitPick) => req<Outfit>('/api/outfits/rate', { method: 'POST', body: json({ pick }) }, true),
  render: (pick: OutfitPick) => req<Outfit>('/api/outfits/render', { method: 'POST', body: json({ pick }) }, true),
  patchOutfit: (id: string, body: Partial<Outfit>) =>
    req<Outfit>(`/api/outfits/${encodeURIComponent(id)}`, { method: 'PATCH', body: json(body) }),
};
