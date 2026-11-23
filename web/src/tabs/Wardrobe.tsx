import { useMemo, useRef, useState } from 'react';
import type { Item, ItemTags, Pattern, Slot } from '../../../shared/types';
import { effectiveTags } from '../../../shared/types';
import { api, img } from '../api';
import { Empty, FormalityChip, Sheet, Spinner, Thumb } from '../components';
import { DEFAULT_GARMENT, errMsg, fmtLabel, itemName, settingsOf, SLOT_LABEL, SLOT_PLURAL, SLOTS, slotOf, useApp } from '../util';

type Filter = 'all' | Slot | 'unsorted';
const PATTERNS: Pattern[] = ['solid', 'stripe', 'check', 'plaid', 'print', 'texture', 'other'];

export default function Wardrobe() {
  const { db, refresh, toast } = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const owned = useMemo(
    () => db.items.filter(i => i.status === 'owned' || i.status === 'bought').sort((a, b) => b.createdAt - a.createdAt),
    [db.items],
  );
  const shown = owned.filter(i => {
    if (filter === 'all') return true;
    const s = slotOf(i);
    return filter === 'unsorted' ? !s : s === filter;
  });
  const count = (f: Filter) => owned.filter(i => (f === 'all' ? true : f === 'unsorted' ? !slotOf(i) : slotOf(i) === f)).length;

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    setProgress({ done: 0, total: files.length });
    let done = 0;
    const BATCH = 3;
    try {
      for (let i = 0; i < files.length; i += BATCH) {
        await api.addItems(files.slice(i, i + BATCH), 'owned');
        done += Math.min(BATCH, files.length - i);
        setProgress({ done, total: files.length });
        refresh();
      }
      toast(`Added ${files.length} item${files.length > 1 ? 's' : ''} — processing`);
    } catch (err) {
      toast(`Upload stopped at ${done}/${files.length}: ${errMsg(err)}`);
    } finally {
      setProgress(null);
      refresh();
    }
  };

  const open = db.items.find(i => i.id === openId);

  return (
    <div className="stack">
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
      <button className="btn btn-primary btn-lg" onClick={() => fileRef.current?.click()} disabled={!!progress}>
        {progress ? <><Spinner small /> Uploading {progress.done}/{progress.total}…</> : '+ Add clothes (select many)'}
      </button>

      <div className="seg">
        {(['all', ...SLOTS, 'unsorted'] as Filter[]).map(f => (
          <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'unsorted' ? 'Unsorted' : SLOT_PLURAL[f]} <small>{count(f)}</small>
          </button>
        ))}
      </div>

      {owned.length === 0 ? (
        <Empty>Photograph each item flat or hanging on a plain background, then add them all at once. Each gets a studio cutout and AI tags.</Empty>
      ) : shown.length === 0 ? (
        <Empty>Nothing here.</Empty>
      ) : (
        <div className="grid">
          {shown.map(i => <Thumb key={i.id} item={i} onClick={() => setOpenId(i.id)} />)}
        </div>
      )}

      <Sheet open={!!open} onClose={() => setOpenId(null)} title={open ? itemName(open) : ''}>
        {open && <ItemEditor item={open} onClose={() => setOpenId(null)} />}
      </Sheet>
    </div>
  );
}

export function ItemEditor({ item, onClose }: { item: Item; onClose: () => void }) {
  const { db, refresh, toast, setDb } = useApp();
  const settings = settingsOf(db);
  const t = effectiveTags(item);
  const [confirmDel, setConfirmDel] = useState(false);

  const setTag = async (patch: Partial<ItemTags>) => {
    const manualTags = { ...(item.manualTags || {}), ...patch };
    setDb(d => ({ ...d, items: d.items.map(i => (i.id === item.id ? { ...i, manualTags } : i)) }));
    try { await api.patchItem(item.id, { manualTags }); await refresh(); } catch (e) { toast(errMsg(e)); }
  };
  const setField = async (patch: Partial<Item>) => {
    try { await api.patchItem(item.id, patch); await refresh(); } catch (e) { toast(errMsg(e)); }
  };

  const [formality, setFormality] = useState(t?.formality ?? 5);

  return (
    <div className="stack">
      <div className="editor-img">
        <img src={img(item.studioImage || item.originalImage)} alt="" />
        {item.processing && <span className="thumb-overlay"><Spinner /></span>}
      </div>
      {item.error && (
        <div className="row">
          <span className="err small grow">{item.error}</span>
          <button className="btn" onClick={() => api.retryItem(item.id).then(refresh).catch(e => toast(errMsg(e)))}>Retry</button>
        </div>
      )}
      {t?.notes && <p className="muted small">{t.notes}</p>}

      <div className="field">
        <span>Slot</span>
        <div className="seg">
          {SLOTS.map(s => (
            <button key={s} className={t?.slot === s ? 'on' : ''} onClick={() => setTag({ slot: s, garmentClass: DEFAULT_GARMENT[s] })}>{SLOT_LABEL[s]}</button>
          ))}
        </div>
      </div>
      <label className="field">
        <span>Type</span>
        <input defaultValue={t?.type ?? ''} placeholder="e.g. oxford shirt" onBlur={e => e.target.value !== (t?.type ?? '') && setTag({ type: e.target.value })} />
      </label>
      <label className="field">
        <span>Color</span>
        <div className="row">
          <input className="grow" defaultValue={t?.primaryColor ?? ''} placeholder="navy" onBlur={e => e.target.value !== (t?.primaryColor ?? '') && setTag({ primaryColor: e.target.value })} />
          <input type="color" value={t?.primaryHex || '#888888'} onChange={e => setTag({ primaryHex: e.target.value })} aria-label="Color swatch" />
        </div>
      </label>
      <label className="field">
        <span>Pattern</span>
        <select value={t?.pattern ?? 'solid'} onChange={e => setTag({ pattern: e.target.value as Pattern })}>
          {PATTERNS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Formality <b>{formality.toFixed(1)}</b> · {fmtLabel(formality)} <FormalityChip f={formality} settings={settings} /></span>
        <input
          type="range" min={1} max={10} step={0.5} value={formality}
          onChange={e => setFormality(Number(e.target.value))}
          onPointerUp={() => setTag({ formality })}
          onTouchEnd={() => setTag({ formality })}
        />
      </label>

      <div className="btn-row">
        {item.status === 'candidate' ? (
          <button className="btn" onClick={() => setField({ status: 'owned' })}>Mark owned</button>
        ) : (
          <button className="btn" onClick={() => setField({ status: 'candidate' })}>Move to candidates</button>
        )}
        {item.manualTags && <button className="btn btn-ghost" onClick={() => setField({ manualTags: {} })}>Reset to AI tags</button>}
      </div>
      <button
        className={`btn ${confirmDel ? 'btn-danger' : 'btn-ghost'}`}
        onClick={async () => {
          if (!confirmDel) { setConfirmDel(true); return; }
          try { await api.deleteItem(item.id); onClose(); await refresh(); } catch (e) { toast(errMsg(e)); }
        }}
      >
        {confirmDel ? 'Tap again to delete' : 'Delete item'}
      </button>
    </div>
  );
}
