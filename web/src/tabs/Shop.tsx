import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item, OutfitPick } from '../../../shared/types';
import { effectiveTags, outfitKey } from '../../../shared/types';
import { api, img } from '../api';
import { Board, Empty, FormalityChip, Sheet, Spinner, Thumb } from '../components';
import { byId, errMsg, impactOf, itemName, money, renderFor, settingsOf, useApp } from '../util';

const STORES = ['Old Navy', 'Nordstrom Rack', 'Burlington'];
const STORE_KEY = 'fitcheck-store';
const lastStore = () => { try { return localStorage.getItem(STORE_KEY) || ''; } catch { return ''; } };

export default function Shop() {
  const { db, refresh, toast } = useApp();
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [store, setStore] = useState(lastStore);
  const [openId, setOpenId] = useState<string | null>(null);
  const snapRef = useRef<HTMLInputElement>(null);

  const chooseStore = (s: string) => {
    setStore(s);
    try { localStorage.setItem(STORE_KEY, s); } catch { /* ignore */ }
  };

  const onSnap = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setUploading(true);
    setCurrentId(null);
    try {
      const [item] = await api.addItems([f], 'candidate', { store: store || undefined });
      setCurrentId(item.id);
      await refresh();
    } catch (err) {
      toast(`Upload failed: ${errMsg(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const candidates = useMemo(
    () => db.items
      .filter(i => i.status === 'candidate')
      .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || b.createdAt - a.createdAt),
    [db.items],
  );

  const settings = settingsOf(db);
  const impacts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of candidates) {
      if (!effectiveTags(c) || c.processing) continue;
      const imp = impactOf(db, c.id, settings);
      if (imp) m.set(c.id, imp.newOutfits.length);
    }
    return m;
  }, [db, candidates, settings]);

  const move = async (idx: number, dir: -1 | 1) => {
    const arr = [...candidates];
    const j = idx + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    const changes = arr.map((it, k) => ({ it, rank: k })).filter(({ it, rank }) => it.rank !== rank);
    try {
      await Promise.all(changes.map(({ it, rank }) => api.patchItem(it.id, { rank })));
      await refresh();
    } catch (err) { toast(errMsg(err)); }
  };

  const toggleStar = async (it: Item) => {
    try { await api.patchItem(it.id, { starred: !it.starred }); await refresh(); } catch (err) { toast(errMsg(err)); }
  };

  return (
    <div className="stack">
      <input ref={snapRef} type="file" accept="image/*" capture="environment" hidden onChange={onSnap} />
      <button className="snap-btn" onClick={() => snapRef.current?.click()} disabled={uploading}>
        {uploading ? <><Spinner /> Uploading…</> : <><span className="snap-icon">📷</span> Snap item</>}
      </button>

      <div className="chips-row">
        {STORES.map(s => (
          <button key={s} className={`chip-btn${store === s ? ' on' : ''}`} onClick={() => chooseStore(store === s ? '' : s)}>{s}</button>
        ))}
        <input
          className="chip-input"
          placeholder="Other store"
          value={STORES.includes(store) ? '' : store}
          onChange={e => chooseStore(e.target.value)}
        />
      </div>

      {currentId && <ResultCard id={currentId} key={currentId} />}

      <section>
        <h3 className="section-title">Candidates <span className="muted">({candidates.length})</span></h3>
        {candidates.length === 0 ? (
          <Empty>Snap something in the store. Each one gets a studio photo, tags, and a count of how many work outfits it unlocks with what you already own.</Empty>
        ) : (
          <ul className="cand-list">
            {candidates.map((c, idx) => (
              <li key={c.id} className="cand-row">
                <div className="rank-btns">
                  <button className="btn-icon" onClick={() => move(idx, -1)} disabled={idx === 0} aria-label="Rank up">▲</button>
                  <button className="btn-icon" onClick={() => move(idx, 1)} disabled={idx === candidates.length - 1} aria-label="Rank down">▼</button>
                </div>
                <Thumb item={c} size={56} onClick={() => setOpenId(c.id)} />
                <button className="cand-info" onClick={() => setOpenId(c.id)}>
                  <span className="cand-name">{itemName(c)}</span>
                  <span className="muted small">
                    {money(c.price)}{c.store ? ` · ${c.store}` : ''}
                    {impacts.has(c.id) && <> · <b>+{impacts.get(c.id)}</b> outfits</>}
                    {c.processing && ' · processing…'}
                  </span>
                </button>
                <button className={`btn-icon star${c.starred ? ' on' : ''}`} onClick={() => toggleStar(c)} aria-label="Star">{c.starred ? '★' : '☆'}</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Sheet open={!!openId} onClose={() => setOpenId(null)} title="Item">
        {openId && <ResultCard id={openId} key={openId} inSheet onDone={() => setOpenId(null)} />}
      </Sheet>
    </div>
  );
}

function ResultCard({ id, inSheet, onDone }: { id: string; inSheet?: boolean; onDone?: () => void }) {
  const { db, refresh, toast } = useApp();
  const item = db.items.find(i => i.id === id);
  const settings = settingsOf(db);
  const [price, setPrice] = useState(item?.price != null ? String(item.price) : '');
  const [tagBusy, setTagBusy] = useState(false);
  const [compatBusy, setCompatBusy] = useState(false);
  const [renderBusy, setRenderBusy] = useState(false);
  const [renderPick, setRenderPick] = useState<OutfitPick | null>(null);
  const tagRef = useRef<HTMLInputElement>(null);
  const compatDone = useRef(false);
  const items = useMemo(() => byId(db), [db]);

  const tags = item ? effectiveTags(item) : undefined;
  const ready = !!item && !!tags && !item.processing;

  // Once tagged, ask the AI for pair scores against the wardrobe (once per card).
  useEffect(() => {
    if (!ready || compatDone.current || !item) return;
    compatDone.current = true;
    const hasAi = Object.entries(db.pairs).some(([k, v]) => v.source === 'ai' && k.includes(item.id));
    if (hasAi) return;
    setCompatBusy(true);
    api.compat(item.id).then(() => refresh()).catch(() => { /* rules fallback is fine */ }).finally(() => setCompatBusy(false));
  }, [ready, item, db.pairs, refresh]);

  const impact = useMemo(() => (ready ? impactOf(db, id, settings) : null), [ready, db, id, settings]);
  const topNew = useMemo(
    () => (impact?.newOutfits ?? []).slice().sort((a, b) => b.rating.score - a.rating.score).slice(0, 3),
    [impact],
  );

  if (!item) return null;

  const savePrice = async (v = price) => {
    const n = parseFloat(v.replace(/[^0-9.]/g, ''));
    const next = Number.isFinite(n) ? n : undefined;
    if (next === item.price) return;
    try { await api.patchItem(item.id, { price: next }); await refresh(); } catch (err) { toast(errMsg(err)); }
  };

  const onTag = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setTagBusy(true);
    try {
      const r = await api.priceTag(item.id, f);
      if (r.price != null) {
        setPrice(String(r.price));
        await api.patchItem(item.id, { price: r.price });
        toast(`Read price ${money(r.price)} — edit if wrong`);
      } else toast("Couldn't read the tag — type the price");
      await refresh();
    } catch (err) { toast(`Tag read failed: ${errMsg(err)}`); }
    finally { setTagBusy(false); }
  };

  const setStatus = async (status: Item['status'], extra: Partial<Item> = {}) => {
    try { await api.patchItem(item.id, { status, ...extra }); await refresh(); if (status === 'rejected') onDone?.(); }
    catch (err) { toast(errMsg(err)); }
  };

  const tryOn = async () => {
    const pick = topNew[0]?.pick ?? guessPick(item, db.items);
    if (!pick) { toast('Add some wardrobe items first'); return; }
    setRenderPick(pick);
    setRenderBusy(true);
    try { await api.render(pick); await refresh(); }
    catch (err) { toast(`Render failed: ${errMsg(err)}`); }
    finally { setRenderBusy(false); }
  };

  const renderSrc = renderPick ? renderFor(db, renderPick, outfitKey(renderPick)) : undefined;

  return (
    <div className={inSheet ? 'stack' : 'card stack'}>
      <div className="result-head">
        <div className="result-img">
          <img src={img(item.studioImage || item.originalImage)} alt="" />
          {item.processing && <span className="thumb-overlay"><Spinner /></span>}
        </div>
        <div className="result-meta">
          {item.processing ? (
            <p className="muted">Making studio photo & tagging…</p>
          ) : item.error ? (
            <>
              <p className="err small">{item.error}</p>
              <button className="btn" onClick={() => api.retryItem(item.id).then(refresh).catch(e => toast(errMsg(e)))}>Retry</button>
            </>
          ) : (
            <>
              <h3 className="result-name">{itemName(item)}</h3>
              {tags && <FormalityChip f={tags.formality} settings={settings} />}
              {tags?.notes && <p className="muted small">{tags.notes}</p>}
            </>
          )}
        </div>
      </div>

      <div className="price-row">
        <label className="price-field">
          <span>$</span>
          <input
            inputMode="decimal"
            placeholder="Price"
            value={price}
            onChange={e => setPrice(e.target.value)}
            onBlur={() => savePrice()}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
        </label>
        <input ref={tagRef} type="file" accept="image/*" capture="environment" hidden onChange={onTag} />
        <button className="btn" onClick={() => tagRef.current?.click()} disabled={tagBusy}>
          {tagBusy ? <Spinner small /> : '🏷️'} Snap tag
        </button>
      </div>

      {ready && (
        <div className="impact">
          <div className="stat">
            <b>{impact ? impact.worksWith.length : '—'}</b>
            <span>works with your items</span>
          </div>
          <div className="stat stat-accent">
            <b>{impact ? `+${impact.newOutfits.length}` : '—'}</b>
            <span>new work outfits</span>
          </div>
          <div className="stat">
            <b>{impact ? impact.baselineCount : '—'}</b>
            <span>you have now</span>
          </div>
          {compatBusy && <p className="muted small full">Refining with AI… <Spinner small /></p>}
        </div>
      )}

      {topNew.length > 0 && (
        <div className="mini-boards">
          {topNew.map(o => (
            <div key={o.key} className="mini-wrap">
              <Board pick={o.pick} items={items} mini newIds={[item.id]} />
              <span className="small muted">{Math.round(o.rating.score)} · {o.rating.label}</span>
            </div>
          ))}
        </div>
      )}

      {(renderBusy || renderSrc) && (
        <div className="render-box">
          {renderSrc ? <img src={img(renderSrc)} alt="Try-on" /> : <div className="render-wait"><Spinner /> Rendering on you… (10–40s)</div>}
        </div>
      )}

      <div className="btn-row">
        <button className={`btn${item.starred ? ' btn-primary' : ''}`} onClick={() => setStatus('candidate', { starred: !item.starred })}>
          {item.starred ? '★ Starred' : '☆ Star'}
        </button>
        <button className="btn" onClick={tryOn} disabled={!ready || renderBusy}>Try on</button>
        <button className="btn btn-ghost" onClick={() => setStatus('rejected')}>✕ Reject</button>
      </div>
      {inSheet && (
        <button className="btn btn-ghost small" onClick={() => setStatus('bought')}>Mark as bought</button>
      )}
    </div>
  );
}

/** Fallback outfit around an item when the optimizer has none (e.g. logic still stubbed). */
function guessPick(item: Item, all: Item[]): OutfitPick | null {
  const t = effectiveTags(item);
  if (!t) return null;
  const owned = all.filter(i => (i.status === 'owned' || i.status === 'bought') && effectiveTags(i));
  const first = (slot: string) => owned.find(i => effectiveTags(i)?.slot === slot)?.id;
  const pick: OutfitPick = { top: first('top'), bottom: first('bottom'), shoes: first('shoes') };
  pick[t.slot] = item.id;
  return pick.top || pick.bottom ? pick : null;
}
