import { useEffect, useRef, useState } from 'react';
import { api, img } from '../api';
import { Empty, Spinner } from '../components';
import { errMsg, settingsOf, useApp } from '../util';

export default function Me() {
  const { db, refresh, toast, setDb } = useApp();
  const settings = settingsOf(db);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setUploading(true);
    try {
      const b = await api.addBase(f);
      if (!settings.activeBaseId) await api.patchSettings({ activeBaseId: b.id });
      await refresh();
    } catch (err) { toast(`Upload failed: ${errMsg(err)}`); }
    finally { setUploading(false); }
  };

  const patchSettings = async (p: Parameters<typeof api.patchSettings>[0]) => {
    setDb(d => ({ ...d, settings: { ...settings, ...p } }));
    try { await api.patchSettings(p); await refresh(); } catch (err) { toast(errMsg(err)); }
  };

  const makeNeutral = async (id: string) => {
    try { await api.neutral(id); await patchSettings({ useNeutralBase: true, activeBaseId: id }); }
    catch (err) { toast(errMsg(err)); }
  };

  const activeId = settings.activeBaseId ?? db.bases[0]?.id;

  return (
    <div className="stack">
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
      <button className="btn btn-primary btn-lg" onClick={() => fileRef.current?.click()} disabled={uploading}>
        {uploading ? <><Spinner small /> Uploading…</> : '+ Add a photo of me'}
      </button>

      <details className="card tips" open={db.bases.length === 0}>
        <summary>Photo tips</summary>
        <ul>
          <li>Full body, head to toe, facing the camera</li>
          <li>Arms slightly away from your sides</li>
          <li>Plain wall behind you, even light</li>
          <li>Phone at waist height, ~8 ft away</li>
          <li>Fitted, plain clothes work best</li>
        </ul>
      </details>

      {db.bases.length === 0 ? (
        <Empty>Your photo becomes a studio-style model that every outfit is rendered on.</Empty>
      ) : (
        <>
          <label className="toggle-row card">
            <span>Use neutral base outfit<br /><small className="muted">Renders start from a plain tee + chinos version of you</small></span>
            <input
              type="checkbox"
              checked={!!settings.useNeutralBase}
              onChange={e => patchSettings({ useNeutralBase: e.target.checked })}
            />
          </label>
          <div className="base-list">
            {db.bases.map(b => {
              const active = b.id === activeId;
              return (
                <div key={b.id} className={`card base-card${active ? ' active' : ''}`}>
                  <div className="base-imgs">
                    <figure>
                      <img src={img(b.studioImage || b.originalImage)} alt="Studio" />
                      <figcaption>{b.studioImage ? 'Studio' : 'Original'}</figcaption>
                      {b.processing && !b.studioImage && <span className="thumb-overlay"><Spinner /></span>}
                    </figure>
                    {(b.neutralImage || (b.processing && b.studioImage)) && (
                      <figure>
                        {b.neutralImage ? <img src={img(b.neutralImage)} alt="Neutral" /> : <div className="render-wait"><Spinner /></div>}
                        <figcaption>Neutral</figcaption>
                      </figure>
                    )}
                  </div>
                  {b.error && <p className="err small">{b.error}</p>}
                  <div className="btn-row">
                    <button className={`btn${active ? ' btn-primary' : ''}`} onClick={() => patchSettings({ activeBaseId: b.id })} disabled={active}>
                      {active ? '✓ Active' : 'Use this'}
                    </button>
                    {!b.neutralImage && b.studioImage && (
                      <button className="btn" onClick={() => makeNeutral(b.id)} disabled={b.processing}>Make neutral</button>
                    )}
                    <button
                      className={`btn ${confirmDel === b.id ? 'btn-danger' : 'btn-ghost'}`}
                      onClick={async () => {
                        if (confirmDel !== b.id) { setConfirmDel(b.id); return; }
                        try { await api.deleteBase(b.id); await refresh(); } catch (err) { toast(errMsg(err)); }
                      }}
                    >{confirmDel === b.id ? 'Confirm' : 'Delete'}</button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      <AiSpend />
    </div>
  );
}

const WHAT_LABEL: Record<string, string> = {
  'try-on': 'On-me renders', 'item-studio': 'Studio images', 'tag-item': 'Tagging', compat: 'Wardrobe match',
  'score-outfit': 'AI outfit rating', 'price-tag': 'Price tag reads', 'remove-bg': 'Background removal',
};
const money = (n: number) => (n < 1 ? `${(n * 100).toFixed(1)}¢` : `$${n.toFixed(2)}`);

function AiSpend() {
  const [u, setU] = useState<Awaited<ReturnType<typeof api.usage>> | null>(null);
  useEffect(() => { api.usage().then(setU).catch(() => {}); }, []);
  if (!u) return null;
  const today = new Date().toLocaleDateString('en-CA');
  const rows = Object.entries(u.byWhat).sort((a, b) => b[1].cost - a[1].cost);
  return (
    <details className="card tips">
      <summary>AI spend: {money(u.byDay[today] || 0)} today · {money(u.total)} total</summary>
      <table className="small" style={{ width: '100%', marginTop: 8 }}>
        <tbody>
          {rows.map(([w, r]) => (
            <tr key={w}><td>{WHAT_LABEL[w] || w}</td><td style={{ textAlign: 'right' }}>{r.calls}{r.failed ? ` (${r.failed} failed)` : ''}</td><td style={{ textAlign: 'right' }}>{money(r.cost)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">From each call's token counts × list prices. Days: {Object.entries(u.byDay).map(([d, c]) => `${d.slice(5)} ${money(c)}`).join(' · ')}</p>
    </details>
  );
}
