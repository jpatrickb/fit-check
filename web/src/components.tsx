import { useEffect, type ReactNode } from 'react';
import type { Item, OutfitPick, OutfitRating, Settings } from '../../shared/types';
import { img } from './api';
import { fmtLabel, inBand, itemName, money } from './util';

export function Spinner({ small }: { small?: boolean }) {
  return <span className={small ? 'spin spin-sm' : 'spin'} aria-label="Loading" />;
}

export function Thumb({ item, onClick, selected, badge, size }: {
  item?: Item; onClick?: () => void; selected?: boolean; badge?: ReactNode; size?: number;
}) {
  if (!item) return <div className="thumb thumb-empty" style={size ? { width: size, height: size } : undefined} />;
  const src = img(item.studioImage || item.originalImage);
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={`thumb${selected ? ' selected' : ''}${item.status === 'candidate' ? ' cand' : ''}`}
      onClick={onClick}
      style={size ? { width: size, height: size } : undefined}
      aria-label={itemName(item)}
    >
      <img src={src} alt="" loading="lazy" />
      {item.processing && <span className="thumb-overlay"><Spinner small /></span>}
      {item.error && !item.processing && <span className="badge badge-err">!</span>}
      {item.status === 'candidate' && item.price != null && <span className="badge badge-price">{money(item.price)}</span>}
      {badge}
    </Tag>
  );
}

/** Catalog-style flat-lay outfit board: top (with layer over it) left, bottom tall right, belt + shoes below. */
export function Board({ pick, items, mini, newIds }: {
  pick: OutfitPick; items: Map<string, Item>; mini?: boolean; newIds?: string[];
}) {
  const g = (id?: string) => (id ? items.get(id) : undefined);
  const pic = (id: string | undefined, cls: string) => {
    const it = g(id);
    if (!it) return <span className={`cell-empty ${cls}`} />;
    return (
      <span className={`pic ${cls}`}>
        <img src={img(it.studioImage || it.originalImage)} alt={itemName(it)} loading="lazy" />
        {newIds?.includes(it.id) && <span className="badge badge-new">NEW</span>}
      </span>
    );
  };
  return (
    <div className={`board${mini ? ' mini' : ''}`}>
      <div className={`b-top${pick.layer ? ' layered' : ''}`}>
        {pick.layer && pic(pick.top, 'under')}
        {pic(pick.layer ?? pick.top, 'over')}
      </div>
      <div className="b-bottom">{pic(pick.bottom, 'full')}</div>
      <div className="b-acc">
        {pick.belt && <div className="b-belt">{pic(pick.belt, 'full')}</div>}
        <div className="b-shoes">{pic(pick.shoes, 'full')}</div>
      </div>
    </div>
  );
}

export function FormalityChip({ f, settings }: { f?: number; settings: Settings }) {
  if (f == null) return <span className="chip">—</span>;
  return (
    <span className={`chip ${inBand(f, settings) ? 'chip-ok' : 'chip-off'}`}>
      {fmtLabel(f)} · {f.toFixed(1)}
    </span>
  );
}

export function ScoreBadge({ r, settings }: { r: OutfitRating | null; settings: Settings }) {
  if (!r) return <span className="score score-none">—</span>;
  const good = r.score >= settings.minScore;
  return (
    <span className={`score ${good ? 'score-good' : 'score-meh'}`} title={`source: ${r.source}`}>
      {Math.round(r.score)}
      <small>{r.source === 'ai' ? 'AI' : r.source === 'manual' ? 'you' : 'rules'}</small>
    </span>
  );
}

export function Sheet({ open, onClose, children, title }: {
  open: boolean; onClose: () => void; children: ReactNode; title?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
