import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DB } from '../../shared/types';
import { api, AuthError, getPw, onInflight, setPw } from './api';
import { Ctx, EMPTY_DB, errMsg } from './util';
import Shop from './tabs/Shop';
import Dress from './tabs/Dress';
import Plan from './tabs/Plan';
import Wardrobe from './tabs/Wardrobe';
import Me from './tabs/Me';

type Tab = 'shop' | 'dress' | 'plan' | 'wardrobe' | 'me';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'shop', label: 'Shop', icon: '📷' },
  { id: 'dress', label: 'Dress', icon: '👔' },
  { id: 'plan', label: 'Plan', icon: '📈' },
  { id: 'wardrobe', label: 'Wardrobe', icon: '🧺' },
  { id: 'me', label: 'Me', icon: '🙂' },
];

function initialTab(): Tab {
  try {
    const t = sessionStorage.getItem('fitcheck-tab') as Tab | null;
    if (t && TABS.some(x => x.id === t)) return t;
  } catch { /* ignore */ }
  return 'shop';
}

export default function App() {
  const [db, setDbState] = useState<DB>(EMPTY_DB);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [needPw, setNeedPw] = useState(false);
  const [mock, setMock] = useState(false);
  const [pending, setPending] = useState(0);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const toastTimer = useRef<number>(0);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 3200);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.db();
      setDbState(next);
      setLoaded(true);
      setOffline(false);
    } catch (e) {
      if (e instanceof AuthError) setNeedPw(true);
      else setOffline(true);
    }
  }, []);

  const setDb = useCallback((fn: (db: DB) => DB) => setDbState(fn), []);

  useEffect(() => onInflight(setPending), []);
  useEffect(() => {
    const onAuth = () => setNeedPw(true);
    window.addEventListener('fitcheck-auth', onAuth);
    return () => window.removeEventListener('fitcheck-auth', onAuth);
  }, []);

  useEffect(() => {
    refresh();
    api.status().then(s => setMock(!!s.mock)).catch(() => {});
  }, [refresh]);

  const busy = pending > 0 || db.items.some(i => i.processing) || db.bases.some(b => b.processing);
  useEffect(() => {
    if (needPw) return;
    const id = window.setInterval(refresh, busy ? 2000 : 15000);
    return () => window.clearInterval(id);
  }, [busy, refresh, needPw]);

  useEffect(() => {
    const onVis = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  const go = (t: Tab) => {
    setTab(t);
    try { sessionStorage.setItem('fitcheck-tab', t); } catch { /* ignore */ }
    window.scrollTo({ top: 0 });
  };

  if (needPw) return <PasswordScreen onDone={() => { setNeedPw(false); refresh(); api.status().then(s => setMock(!!s.mock)).catch(() => {}); }} />;

  return (
    <Ctx.Provider value={{ db, setDb, refresh, toast, mock }}>
      <header className="topbar">
        <span className="brand">Fit Check</span>
        <span className="topbar-right">
          {busy && <span className="dot-busy" title="Working…" />}
          {mock && <span className="pill pill-mock">MOCK AI</span>}
          {offline && <span className="pill pill-err">offline</span>}
        </span>
      </header>
      <main className="main">
        {!loaded && !offline ? (
          <div className="center-pad"><span className="spin" /></div>
        ) : (
          <ErrorBoundary key={tab}>
            {tab === 'shop' && <Shop />}
            {tab === 'dress' && <Dress />}
            {tab === 'plan' && <Plan />}
            {tab === 'wardrobe' && <Wardrobe />}
            {tab === 'me' && <Me />}
          </ErrorBoundary>
        )}
      </main>
      <nav className="tabbar">
        {TABS.map(t => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => go(t.id)}>
            <span className="tab-icon" aria-hidden>{t.icon}</span>
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
      {toastMsg && <div className="toast" onClick={() => setToastMsg(null)}>{toastMsg}</div>}
    </Ctx.Provider>
  );
}

function PasswordScreen({ onDone }: { onDone: () => void }) {
  const [pw, setPwVal] = useState(getPw());
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPw(pw);
    try { await api.db(); onDone(); } catch (e2) { setErr(e2 instanceof AuthError ? 'Wrong password' : errMsg(e2)); }
  };
  return (
    <form className="pw-screen" onSubmit={submit}>
      <h1>Fit Check</h1>
      <input type="password" placeholder="Password" value={pw} autoFocus onChange={e => setPwVal(e.target.value)} />
      <button className="btn btn-primary btn-lg" type="submit">Unlock</button>
      {err && <p className="err">{err}</p>}
    </form>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { err: errMsg(e) }; }
  render() {
    if (this.state.err) return (
      <div className="card"><p className="err">Something broke on this screen: {this.state.err}</p>
        <button className="btn" onClick={() => this.setState({ err: null })}>Try again</button></div>
    );
    return this.props.children;
  }
}
