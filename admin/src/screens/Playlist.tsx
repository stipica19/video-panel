import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDuration, formatSeconds, type Item, type Motion, type MotionKind } from '../api';

type Draft = Pick<Item, 'id' | 'asset_id' | 'duration' | 'motion' | 'enabled' | 'asset'>;

const MOTION_LABELS: Record<MotionKind, string> = {
  none: 'Bez pokreta',
  kenburns: 'Ken Burns',
  driftY: 'Klizanje po visini',
};

function defaultMotion(kind: MotionKind): Motion {
  if (kind === 'kenburns') return { kind, scaleFrom: 1.0, scaleTo: 1.06, panY: -1.5 };
  if (kind === 'driftY') return { kind, panY: -2.5 };
  return { kind: 'none' };
}

export function Playlist() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const items = useQuery({ queryKey: ['items'], queryFn: api.items, staleTime: Infinity });
  const assets = useQuery({ queryKey: ['assets'], queryFn: api.assets });
  const state = useQuery({ queryKey: ['publishState'], queryFn: api.publishState, refetchInterval: 2000 });

  useEffect(() => {
    if (items.data && !dirty) setDraft(items.data);
  }, [items.data, dirty]);

  const save = useMutation({
    mutationFn: () =>
      api.saveItems(
        (draft ?? []).map((it) => ({
          id: it.id,
          asset_id: it.asset_id,
          duration: it.duration,
          motion: it.motion,
          enabled: it.enabled,
        })),
      ),
    onSuccess: (saved) => {
      setDirty(false);
      setDraft(saved);
      setError(null);
      setMessage('Izmjene sačuvane. Objavi da ih paneli pokupe.');
      queryClient.setQueryData(['items'], saved);
      queryClient.invalidateQueries({ queryKey: ['publishState'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const publish = useMutation({
    mutationFn: () => api.publish(),
    onSuccess: (result) => {
      setError(null);
      setMessage(
        result.unchanged
          ? 'Sadržaj je već objavljen — nema promjene.'
          : `Objavljena verzija ${result.version}. Paneli prebacuju u ${new Date(result.activeFrom).toLocaleTimeString('bs-BA')}.`,
      );
      queryClient.invalidateQueries({ queryKey: ['publishState'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  function update(index: number, patch: Partial<Draft>) {
    setDraft((prev) => (prev ? prev.map((it, i) => (i === index ? { ...it, ...patch } : it)) : prev));
    setDirty(true);
    setMessage(null);
  }

  function move(from: number, to: number) {
    setDraft((prev) => {
      if (!prev || from === to) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setDirty(true);
    setMessage(null);
  }

  function addAsset(assetId: string) {
    const asset = assets.data?.find((a) => a.id === assetId);
    if (!asset || !draft) return;
    const isVideo = asset.kind === 'video';
    setDraft([
      ...draft,
      {
        id: 'itm_new_' + Math.random().toString(16).slice(2, 8),
        asset_id: asset.id,
        // Video diktira svoje trajanje i nema pokret — server to ionako nameće.
        duration: isVideo ? (asset.duration ?? 8) : 8,
        motion: isVideo ? { kind: 'none' } : defaultMotion('kenburns'),
        enabled: 1,
        asset: {
          name: asset.name,
          kind: asset.kind,
          url: asset.url,
          thumb: asset.thumb,
          width: asset.width,
          height: asset.height,
          duration: asset.duration,
        },
      },
    ]);
    setDirty(true);
    setMessage(null);
  }

  const cycleSeconds = (draft ?? []).filter((it) => it.enabled).reduce((sum, it) => sum + it.duration, 0);
  const countdown = state.data?.next
    ? Math.max(0, Math.round((state.data.next.activeFrom - state.data.serverNow) / 1000))
    : null;

  return (
    <section>
      <h2>Plejlista</h2>
      <p className="lead">
        Redoslijed se mijenja prevlačenjem. Ciklus traje {formatDuration(Math.round(cycleSeconds))} —
        svi paneli računaju istu poziciju iz serverskog vremena.
      </p>

      {error && <div className="notice error">{error}</div>}
      {message && !error && <div className="notice ok">{message}</div>}
      {state.data?.next && (
        <div className="notice info">
          Verzija <code>{state.data.next.version}</code> čeka — paneli prebacuju za {countdown} s.
        </div>
      )}

      <div className="items">
        {(draft ?? []).map((item, index) => (
          <div
            key={item.id}
            className={
              'item' +
              (item.enabled ? '' : ' off') +
              (dragOver === index ? ' drop-target' : '') +
              (dragFrom.current === index ? ' dragging' : '')
            }
            draggable
            onDragStart={() => {
              dragFrom.current = index;
            }}
            onDragEnd={() => {
              dragFrom.current = null;
              setDragOver(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(index);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom.current !== null) move(dragFrom.current, index);
              dragFrom.current = null;
              setDragOver(null);
            }}
          >
            <span className="handle">⋮⋮</span>
            <div className="thumb">
              {item.asset.kind === 'video' ? (
                <video src={`${item.asset.url}#t=1`} muted playsInline preload="metadata" />
              ) : (
                <img src={item.asset.thumb ?? item.asset.url} alt="" />
              )}
            </div>
            <div className="title">
              {item.asset.name}
              <div className="muted" style={{ fontSize: 12 }}>
                {item.asset.kind === 'video' && 'video · '}
                {item.asset.width} × {item.asset.height}
              </div>
            </div>

            <div className="field">
              <label>Trajanje (s)</label>
              {item.asset.kind === 'video' ? (
                // Trajanje videa nije podesivo: ciklus mora biti tačan do
                // milisekunde da bi sva tri panela računala istu poziciju.
                <input type="text" readOnly value={formatSeconds(item.duration)} title="Trajanje diktira sam video" />
              ) : (
                <input
                  type="number"
                  min={1}
                  max={600}
                  step={0.5}
                  value={item.duration}
                  onChange={(e) => update(index, { duration: Number(e.target.value) })}
                />
              )}
            </div>

            {item.asset.kind === 'video' ? (
              <div className="field">
                <label>Pokret</label>
                <span className="muted">video nosi svoj</span>
              </div>
            ) : (
              <>
                <div className="field">
                  <label>Pokret</label>
                  <select
                    value={item.motion.kind}
                    onChange={(e) => update(index, { motion: defaultMotion(e.target.value as MotionKind) })}
                  >
                    {(Object.keys(MOTION_LABELS) as MotionKind[]).map((kind) => (
                      <option key={kind} value={kind}>
                        {MOTION_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                </div>

                <MotionFields motion={item.motion} onChange={(motion) => update(index, { motion })} />
              </>
            )}

            <div className="field">
              <label>Uključeno</label>
              <input
                type="checkbox"
                checked={!!item.enabled}
                onChange={(e) => update(index, { enabled: e.target.checked ? 1 : 0 })}
              />
            </div>

            <button
              className="btn small danger"
              onClick={() => {
                setDraft((prev) => (prev ? prev.filter((_, i) => i !== index) : prev));
                setDirty(true);
              }}
            >
              Ukloni
            </button>
          </div>
        ))}
        {draft?.length === 0 && <p className="lead">Plejlista je prazna — dodaj sliku iz biblioteke.</p>}
      </div>

      <div className="card">
        <div className="row">
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) addAsset(e.target.value);
              e.target.value = '';
            }}
          >
            <option value="">Dodaj iz biblioteke…</option>
            {assets.data?.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>

          <span className="spacer" />

          <span className="muted">
            {state.data?.current ? (
              <>
                aktivna verzija <code>{state.data.current.version}</code>
              </>
            ) : (
              'ništa još nije objavljeno'
            )}
          </span>

          <button className="btn" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Snimanje…' : 'Sačuvaj'}
          </button>

          <button
            className="btn primary"
            disabled={dirty || publish.isPending || !state.data?.draftCount}
            title={dirty ? 'Prvo sačuvaj izmjene' : ''}
            onClick={() => publish.mutate()}
          >
            {publish.isPending ? 'Objavljivanje…' : countdown !== null ? `Objavljeno — ${countdown} s` : 'Objavi'}
          </button>
        </div>
      </div>
    </section>
  );
}

function MotionFields({ motion, onChange }: { motion: Motion; onChange: (motion: Motion) => void }) {
  if (motion.kind === 'kenburns') {
    return (
      <div className="motion-extra">
        <div className="field">
          <label>Scale od</label>
          <input
            type="number"
            step={0.01}
            min={1}
            max={1.5}
            value={motion.scaleFrom ?? 1}
            onChange={(e) => onChange({ ...motion, scaleFrom: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label>Scale do</label>
          <input
            type="number"
            step={0.01}
            min={1}
            max={1.5}
            value={motion.scaleTo ?? 1.06}
            onChange={(e) => onChange({ ...motion, scaleTo: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label>Pomak Y (%)</label>
          <input
            type="number"
            step={0.1}
            min={-8}
            max={8}
            value={motion.panY ?? 0}
            onChange={(e) => onChange({ ...motion, panY: Number(e.target.value) })}
          />
        </div>
      </div>
    );
  }

  if (motion.kind === 'driftY') {
    return (
      <div className="field">
        <label>Pomak Y (%)</label>
        <input
          type="number"
          step={0.1}
          min={-8}
          max={8}
          value={motion.panY ?? -2.5}
          onChange={(e) => onChange({ ...motion, panY: Number(e.target.value) })}
        />
      </div>
    );
  }

  return null;
}
