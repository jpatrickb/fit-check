import { useEffect, useMemo, useRef, useState } from 'react';
import type { DB, Item, Settings } from '../../../shared/types';
import { outfitKey } from '../../../shared/types';
import type { PurchasePlan, ScoredOutfit } from '../../../shared/optimizer';
import { api, img } from '../api';
import { Board, Empty, Spinner, Thumb } from '../components';
import { activeBase, byId, errMsg, itemName, money, renderFor, runOptimize, settingsOf, useApp } from '../util';

export default function Plan() {
  const { db, setDb, toast } = useApp();
  const items = useMemo(() => byId(db), [db]);
  const [s, setS] = useState<Settings>(() => settingsOf(db));
  const timer = useRef<number>(0);

  // Keep local in sync if server settings change elsewhere (only when not mid-edit).
  const serverSettings = settingsOf(db);
  useEffect(() => { if (!timer.current) setS(serverSettings); /* eslint-disable-next-line */ }, [JSON.stringify(serverSettings)]);

  const update = (patch: Partial<Settings>) => {
    const next = { ...s, ...patch };
    setS(next);
    setDb(d => ({ ...d, settings: next }));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = 0;
      api.patchSettings(patch).catch(e => toast(errMsg(e)));
    }, 500);
  };

  const result = useMemo(() => runOptimize(db, s), [db, s]);
  const candidates = db.items.filter(i => i.status === 'candidate');

  const plan: PurchasePlan | null = result ? (result.best ?? result.bestWithinBudget) : null;

  return (
    <div className="stack">
      <div className="card stack-sm">
        <label className="slider-label">
          <span>Budget <b>{money(s.budget)}</b></span>
          <input type="range" min={0} max={600} step={10} value={s.budget} onChange={e => update({ budget: Number(e.target.value) })} />
        </label>
        <div className="stepper-row">
          <span>Target outfits</span>
          <div className="stepper">
            <button className="btn-icon" onClick={() => update({ targetOutfits: Math.max(1, s.targetOutfits - 1) })}>−</button>
            <b>{s.targetOutfits}</b>
            <button className="btn-icon" onClick={() => update({ targetOutfits: s.targetOutfits + 1 })}>+</button>
          </div>
        </div>
        <label className="slider-label">
          <span>Min outfit score <b>{s.minScore}</b></span>
          <input type="range" min={40} max={95} step={5} value={s.minScore} onChange={e => update({ minScore: Number(e.target.value) })} />
        </label>
      </div>

      {!result ? (
        <Empty>Optimizer isn’t ready yet (still being built) — or no tagged items. Add wardrobe items and candidates.</Empty>
      ) : (
        <>
          <div className="card headline">
            {result.best ? (
              result.best.itemIds.length === 0 ? (
                <p className="big">You already have <b>{result.baseline.outfitCount}</b> on-target outfits. No purchase needed to hit {s.targetOutfits}.</p>
              ) : (
                <p className="big">
                  Buy these <b>{result.best.itemIds.length}</b> for <b>{money(result.best.cost)}</b> →{' '}
                  <b>{result.best.outfitCount}</b> on-target outfits <span className="muted">(you have {result.baseline.outfitCount} now)</span>
                </p>
              )
            ) : (
              <p className="big">
                Can’t reach {s.targetOutfits} within {money(s.budget)}. Best: <b>{result.bestWithinBudget.outfitCount}</b> outfits for{' '}
                <b>{money(result.bestWithinBudget.cost)}</b> — <b>{Math.max(0, s.targetOutfits - result.bestWithinBudget.outfitCount)}</b> short.
                <span className="muted"> Raise budget, snap more items, or lower the min score.</span>
              </p>
            )}
            {plan && plan.itemIds.length > 0 && (
              <div className="carousel">
                {plan.itemIds.map(id => {
                  const it = items.get(id);
                  return it ? (
                    <div key={id} className="plan-item">
                      <Thumb item={it} />
                      <span className="small">{itemName(it)}</span>
                    </div>
                  ) : null;
                })}
              </div>
            )}
          </div>

          {result.frontier.length > 0 && (
            <div className="card">
              <h3 className="section-title">Outfits vs. spend</h3>
              <Frontier frontier={[result.baseline, ...result.frontier.filter(p => p.cost > 0)]} target={s.targetOutfits} budget={s.budget} />
            </div>
          )}

          {candidates.length > 0 && (
            <div className="card">
              <h3 className="section-title">Value of each candidate (alone)</h3>
              <ul className="marg-list">
                {candidates
                  .map(c => ({ c, m: result.marginal[c.id] }))
                  .sort((a, b) => (b.m?.newOutfits ?? -1) - (a.m?.newOutfits ?? -1))
                  .map(({ c, m }) => (
                    <li key={c.id}>
                      <Thumb item={c} size={44} />
                      <span className="grow">{itemName(c)}<br /><span className="muted small">{money(c.price)}</span></span>
                      <span className="marg-num"><b>+{m?.newOutfits ?? 0}</b><small>{m && m.perDollar > 0 ? `${(m.perDollar * 100).toFixed(1)}/$100` : ''}</small></span>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {plan && plan.outfits.length > 0 && <WeekOnMe outfits={plan.outfits} db={db} items={items} />}

          {plan && plan.outfits.length > 0 && (
            <section>
              <h3 className="section-title">Your work outfits ({plan.outfits.length})</h3>
              <div className="outfit-grid">
                {plan.outfits.map(o => (
                  <div key={o.key} className="mini-wrap">
                    <Board pick={o.pick} items={items} mini newIds={o.usesCandidates} />
                    <span className="small muted">{Math.round(o.rating.score)} · {o.rating.label}{o.usesCandidates.length ? ' · NEW' : ''}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

const WEEK_MAX = 8;

/** Render the plan's best outfits on the user's photo (sequential, cached server-side), then show a swipeable strip. */
function WeekOnMe({ outfits, db, items }: { outfits: ScoredOutfit[]; db: DB; items: Map<string, Item> }) {
  const { refresh, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const cancel = useRef(false);
  const week = useMemo(() => [...outfits].sort((a, b) => b.rating.score - a.rating.score).slice(0, WEEK_MAX), [outfits]);
  const rendered = week.map(o => ({ o, src: renderFor(db, o.pick, outfitKey(o.pick)) }));
  const missing = rendered.filter(r => !r.src).length;
  const { file: baseFile } = activeBase(db);

  const run = async () => {
    if (!baseFile) { toast('Add your photo on the Me tab first'); return; }
    setBusy(true); setDone(0); cancel.current = false;
    let n = 0;
    for (const { o, src } of rendered) {
      if (cancel.current) break;
      if (!src) {
        try { await api.render(o.pick); await refresh(); }
        catch (e) { toast(`Render failed: ${errMsg(e)}`); }
      }
      setDone(++n);
    }
    setBusy(false);
  };

  return (
    <div className="card stack-sm">
      <div className="week-head">
        <h3 className="section-title">Your week on you</h3>
        {busy ? (
          <button className="btn small" onClick={() => { cancel.current = true; }}><Spinner small /> {done}/{week.length} · Stop</button>
        ) : missing > 0 ? (
          <button className="btn btn-primary small" onClick={run}>🧍 See my week on me <span className="muted">(~{missing * 13}¢)</span></button>
        ) : (
          <span className="muted small">All {week.length} rendered</span>
        )}
      </div>
      <div className="week-strip">
        {rendered.map(({ o, src }, i) => (
          <figure key={o.key} className="week-card">
            {src ? <img src={img(src)} alt={`Outfit ${i + 1} on you`} loading="lazy" />
              : busy && i === done ? <div className="week-wait"><Spinner /></div>
              : <Board pick={o.pick} items={items} mini newIds={o.usesCandidates} />}
            <figcaption className="small muted">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', '+1'][i]} · {Math.round(o.rating.score)}{o.usesCandidates.length ? ' · NEW' : ''}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

function Frontier({ frontier, target, budget }: { frontier: PurchasePlan[]; target: number; budget: number }) {
  const W = 320, H = 170, P = { l: 30, r: 10, t: 10, b: 24 };
  const maxX = Math.max(budget, ...frontier.map(p => p.cost), 1);
  const maxY = Math.max(target + 1, ...frontier.map(p => p.outfitCount), 1);
  const x = (v: number) => P.l + (v / maxX) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - (v / maxY) * (H - P.t - P.b);
  const pts = [...frontier].sort((a, b) => a.cost - b.cost);
  let d = '';
  pts.forEach((p, i) => {
    if (i === 0) d += `M${x(p.cost)},${y(p.outfitCount)}`;
    else d += ` H${x(p.cost)} V${y(p.outfitCount)}`;
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Outfits by spend">
      <line x1={P.l} x2={W - P.r} y1={y(target)} y2={y(target)} className="chart-target" />
      <text x={W - P.r} y={y(target) - 4} textAnchor="end" className="chart-label">target {target}</text>
      <line x1={x(budget)} x2={x(budget)} y1={P.t} y2={H - P.b} className="chart-budget" />
      <line x1={P.l} x2={W - P.r} y1={H - P.b} y2={H - P.b} className="chart-axis" />
      <line x1={P.l} x2={P.l} y1={P.t} y2={H - P.b} className="chart-axis" />
      <path d={d} className="chart-line" />
      {pts.map((p, i) => <circle key={i} cx={x(p.cost)} cy={y(p.outfitCount)} r={3.5} className="chart-dot"><title>{`${money(p.cost)} → ${p.outfitCount} outfits`}</title></circle>)}
      <text x={P.l} y={H - 6} className="chart-label">$0</text>
      <text x={W - P.r} y={H - 6} textAnchor="end" className="chart-label">{money(maxX)}</text>
      <text x={P.l - 6} y={y(maxY) + 4} textAnchor="end" className="chart-label">{maxY}</text>
      <text x={P.l - 6} y={y(0)} textAnchor="end" className="chart-label">0</text>
    </svg>
  );
}
