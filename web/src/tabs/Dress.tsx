import { useEffect, useMemo, useState } from 'react';
import type { Item, OutfitPick, Slot } from '../../../shared/types';
import { effectiveTags, formalityLabel, outfitKey } from '../../../shared/types';
import { api, img } from '../api';
import { Board, Empty, FormalityChip, ScoreBadge, Spinner, Thumb } from '../components';
import {
  activeBase, allOutfits, byId, errMsg, isOption, rating, renderFor, settingsOf, SLOT_LABEL, SLOTS, slotOf, useApp,
} from '../util';

const PICK_KEY = 'fitcheck-pick';
const loadPick = (): OutfitPick => { try { return JSON.parse(sessionStorage.getItem(PICK_KEY) || '{}'); } catch { return {}; } };

export default function Dress() {
  const { db, refresh, toast } = useApp();
  const settings = settingsOf(db);
  const items = useMemo(() => byId(db), [db]);
  const [pick, setPick] = useState<OutfitPick>(loadPick);
  const [rateBusy, setRateBusy] = useState(false);
  const [renderBusy, setRenderBusy] = useState(false);
  const [showRender, setShowRender] = useState(true);

  useEffect(() => { try { sessionStorage.setItem(PICK_KEY, JSON.stringify(pick)); } catch { /* ignore */ } }, [pick]);

  const bySlot = useMemo(() => {
    const m: Record<Slot, Item[]> = { top: [], bottom: [], layer: [], shoes: [], belt: [] };
    for (const i of db.items) {
      if (!isOption(i) || !effectiveTags(i)) continue;
      const s = slotOf(i);
      if (s) m[s].push(i);
    }
    for (const s of SLOTS) m[s].sort((a, b) => (a.status === 'candidate' ? 1 : 0) - (b.status === 'candidate' ? 1 : 0));
    return m;
  }, [db.items]);

  // Drop picks that no longer exist / were rejected.
  useEffect(() => {
    const valid = (id?: string) => id && items.get(id) && isOption(items.get(id)!);
    const cleaned: OutfitPick = {};
    let changed = false;
    for (const s of SLOTS) {
      if (pick[s] && valid(pick[s])) cleaned[s] = pick[s];
      else if (pick[s]) changed = true;
    }
    if (changed) setPick(cleaned);
  }, [items, pick]);

  const id = outfitKey(pick);
  const outfit = db.outfits[id];
  const r = rating(db, pick);
  const renderSrc = renderFor(db, pick, id);
  const { file: baseFile } = activeBase(db);
  const complete = !!pick.top && !!pick.bottom;

  const choose = (slot: Slot, itemId?: string) => setPick(p => ({ ...p, [slot]: p[slot] === itemId ? undefined : itemId }));

  const aiRate = async () => {
    setRateBusy(true);
    try { await api.rate(pick); await refresh(); } catch (e) { toast(`AI rate failed: ${errMsg(e)}`); }
    finally { setRateBusy(false); }
  };
  const render = async () => {
    if (!baseFile) { toast('Add your photo on the Me tab first'); return; }
    if (renderSrc) { setShowRender(true); return; }
    setRenderBusy(true); setShowRender(true);
    try { await api.render(pick); await refresh(); } catch (e) { toast(`Render failed: ${errMsg(e)}`); }
    finally { setRenderBusy(false); }
  };
  const patch = async (body: Parameters<typeof api.patchOutfit>[1]) => {
    try { await api.patchOutfit(id, { pick, ...body }); await refresh(); } catch (e) { toast(errMsg(e)); }
  };
  const shuffle = () => {
    const list = allOutfits(db, settings);
    if (!list.length) { toast('No on-target outfits yet — add more items or loosen Plan settings'); return; }
    const o = list[Math.floor(Math.random() * list.length)];
    setPick({ ...o.pick });
  };

  const [manual, setManual] = useState<number | null>(null);
  useEffect(() => { setManual(outfit?.manualRating?.score ?? null); }, [id, outfit?.manualRating?.score]);

  if (!db.items.some(i => effectiveTags(i))) {
    return <Empty>Add clothes on the Wardrobe tab (or snap store items) and they’ll show up here to mix and match.</Empty>;
  }

  return (
    <div className="stack">
      <div className="dress-stage card">
        <div className="stage-toggle">
          <button className={`chip-btn${showRender && (renderSrc || renderBusy) ? ' on' : ''}`} onClick={() => setShowRender(true)} disabled={!renderSrc && !renderBusy}>On me</button>
          <button className={`chip-btn${!showRender || (!renderSrc && !renderBusy) ? ' on' : ''}`} onClick={() => setShowRender(false)}>Outfit board</button>
        </div>
        {showRender && (renderSrc || renderBusy) ? (
          <div className="render-box">
            {renderSrc && !renderBusy ? <img src={img(renderSrc)} alt="Try-on render" /> : <div className="render-wait"><Spinner /> Putting it on you… (20–40s)</div>}
          </div>
        ) : (
          <Board pick={pick} items={items} />
        )}
        <div className="rating-row">
          <ScoreBadge r={r} settings={settings} />
          <FormalityChip f={r?.formality} settings={settings} />
          {r?.notes && <span className="muted small notes">{r.notes}</span>}
        </div>
      </div>

      <div className="btn-row">
        <button className="btn" onClick={aiRate} disabled={!complete || rateBusy}>{rateBusy ? <Spinner small /> : '✨'} AI rate</button>
        <button className="btn btn-primary" onClick={render} disabled={!complete || renderBusy}>{renderBusy ? <Spinner small /> : '🧍'} {renderSrc ? 'Show on me' : 'See it on me (~13¢)'}</button>
        <button className="btn" onClick={shuffle}>🔀 Shuffle</button>
      </div>

      {complete && (
        <div className="card stack-sm">
          <div className="btn-row">
            <button className={`btn${outfit?.thumbs === 'up' ? ' btn-primary' : ''}`} onClick={() => patch({ thumbs: outfit?.thumbs === 'up' ? undefined : 'up' })}>👍</button>
            <button className={`btn${outfit?.thumbs === 'down' ? ' btn-primary' : ''}`} onClick={() => patch({ thumbs: outfit?.thumbs === 'down' ? undefined : 'down' })}>👎</button>
            <button className={`btn${outfit?.saved ? ' btn-primary' : ''}`} onClick={() => patch({ saved: !outfit?.saved })}>{outfit?.saved ? '✓ Saved' : 'Save'}</button>
          </div>
          <label className="slider-label">
            <span>Your score: <b>{manual ?? '—'}</b></span>
            <input
              type="range" min={0} max={100} step={5}
              value={manual ?? r?.score ?? 50}
              onChange={e => setManual(Number(e.target.value))}
              onPointerUp={() => manual != null && patch({ manualRating: { score: manual, formality: r?.formality ?? 5, label: formalityLabel(r?.formality ?? 5), source: 'manual' } })}
              onTouchEnd={() => manual != null && patch({ manualRating: { score: manual, formality: r?.formality ?? 5, label: formalityLabel(r?.formality ?? 5), source: 'manual' } })}
            />
          </label>
          {outfit?.manualRating && (
            <button className="btn btn-ghost small" onClick={() => patch({ manualRating: undefined })}>Clear my score</button>
          )}
        </div>
      )}

      {SLOTS.map(slot => (
        <section key={slot}>
          <h3 className="section-title">{SLOT_LABEL[slot]}{(slot === 'layer' || slot === 'belt') && <span className="muted"> (optional)</span>}</h3>
          <div className="carousel">
            {(slot === 'layer' || slot === 'belt') && (
              <button className={`thumb thumb-none${!pick[slot] ? ' selected' : ''}`} onClick={() => setPick(p => ({ ...p, [slot]: undefined }))}>None</button>
            )}
            {bySlot[slot].length === 0 && <span className="muted small pad">No {SLOT_LABEL[slot].toLowerCase()} yet</span>}
            {bySlot[slot].map(it => (
              <Thumb key={it.id} item={it} selected={pick[slot] === it.id} onClick={() => choose(slot, it.id)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
