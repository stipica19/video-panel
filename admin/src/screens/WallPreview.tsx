import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

// Iframe glumi panel: unutar njega player mjeri 1920 × 1080 CSS px, isto kao
// na televizoru. Razmak između okvira je bezel skaliran istim faktorom.
const PANEL_W = 1920;
const PANEL_H = 1080;

export function WallPreview() {
  const queryClient = useQueryClient();
  const [scale, setScale] = useState(0.16);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const bezel = Number(settings.data?.bezel_px ?? 48);
  const [bezelDraft, setBezelDraft] = useState<number | null>(null);
  const shown = bezelDraft ?? bezel;

  const save = useMutation({
    mutationFn: (value: number) => api.saveSettings({ bezel_px: value }),
    onSuccess: (data) => {
      setError(null);
      setBezelDraft(null);
      queryClient.setQueryData(['settings'], data);
      queryClient.invalidateQueries({ queryKey: ['publishState'] });
      setReloadKey((k) => k + 1);
    },
    onError: (err: Error) => setError(err.message),
  });

  const wallH = 3 * PANEL_H + 2 * shown;

  return (
    <section>
      <h2>Pregled zida</h2>
      <p className="lead">
        Tri isječka jedan ispod drugog, sa simuliranim razmakom za okvire. Ako se linija ovdje lomi,
        lomiće se i na zidu.
      </p>

      {error && <div className="notice error">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="row">
          <div className="field">
            <label className="muted" style={{ fontSize: 12 }}>
              Razmak za okvire (px)
            </label>
            <input
              type="number"
              min={0}
              max={400}
              step={2}
              value={shown}
              onChange={(e) => setBezelDraft(Number(e.target.value))}
            />
          </div>

          <button
            className="btn"
            disabled={bezelDraft === null || save.isPending}
            onClick={() => save.mutate(shown)}
          >
            Sačuvaj razmak
          </button>

          <span className="muted">
            Zid je {PANEL_W} × {wallH} px na viewportu od {PANEL_H} px. Vrijednost mora biti parna —
            server je zaokruži naviše.
          </span>

          <span className="spacer" />

          <label className="muted" style={{ fontSize: 12 }}>
            Uvećanje
            <input
              type="range"
              min={0.08}
              max={0.34}
              step={0.01}
              value={scale}
              style={{ marginLeft: 8, verticalAlign: 'middle' }}
              onChange={(e) => setScale(Number(e.target.value))}
            />
          </label>

          <button className="btn small" onClick={() => setReloadKey((k) => k + 1)}>
            Osvježi
          </button>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <span className="muted">Otvori pravi player u zasebnom prozoru:</span>
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              className="btn small"
              onClick={() =>
                window.open(
                  `/player?displej=${n}&hud=1`,
                  `panel${n}`,
                  `width=960,height=540,left=${60 + n * 40},top=${60 + n * 40}`,
                )
              }
            >
              Panel {n}
            </button>
          ))}
          <a className="btn small" href="/kalibracija?displej=1" target="_blank" rel="noreferrer">
            Kalibracija
          </a>
        </div>
      </div>

      <div className="wall-sim">
        {[1, 2, 3].map((n) => (
          <div key={n}>
            <div
              className="panel-frame"
              style={{ width: PANEL_W * scale, height: PANEL_H * scale }}
            >
              {/* Ključ namjerno ne nosi razmak: kucanje u polje bi remountalo
                  tri playera po cifri, a svaki bi ponovo skidao cijelu plejlistu.
                  Player razmak ionako pokupi sa sljedećim pollom. */}
              <iframe
                key={`${n}-${reloadKey}`}
                src={`/player?displej=${n}`}
                width={PANEL_W}
                height={PANEL_H}
                style={{ transform: `scale(${scale})`, width: PANEL_W, height: PANEL_H }}
                title={`Panel ${n}`}
              />
            </div>
            {n < 3 && <div style={{ height: shown * scale, background: '#000' }} />}
          </div>
        ))}
      </div>
    </section>
  );
}
