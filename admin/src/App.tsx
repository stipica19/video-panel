import { useState } from 'react';
import { Library } from './screens/Library';
import { Playlist } from './screens/Playlist';
import { WallPreview } from './screens/WallPreview';
import { Screens } from './screens/Screens';

const TABS = [
  { key: 'biblioteka', label: 'Biblioteka' },
  { key: 'plejlista', label: 'Plejlista' },
  { key: 'pregled', label: 'Pregled zida' },
  { key: 'paneli', label: 'Stanje panela' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function App() {
  const [tab, setTab] = useState<TabKey>('paneli');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Video zid <span className="muted">— tri panela, jedna slika</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={t.key === tab ? 'tab active' : 'tab'}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="content">
        {tab === 'biblioteka' && <Library />}
        {tab === 'plejlista' && <Playlist />}
        {tab === 'pregled' && <WallPreview />}
        {tab === 'paneli' && <Screens />}
      </main>
    </div>
  );
}
