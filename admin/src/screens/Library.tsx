import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatBytes, formatSeconds, ratioOff, type Asset } from '../api';

export function Library() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState<{ name: string; reason: string }[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Dok se neki video reže, lista se osvježava sama — rezanje traje od
  // nekoliko sekundi do par minuta i nema smisla tražiti klik na osvježi.
  const assets = useQuery({
    queryKey: ['assets'],
    queryFn: api.assets,
    refetchInterval: (query) =>
      query.state.data?.some((a) => a.slices && (a.slices.status === 'pending' || a.slices.status === 'working'))
        ? 3000
        : false,
  });

  const retry = useMutation({
    mutationFn: api.retrySlices,
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const upload = useMutation({
    mutationFn: api.upload,
    onSuccess: (result) => {
      setRejected(result.rejected);
      setWarnings(
        result.saved.flatMap((asset) => (asset.warnings ?? []).map((w) => `${asset.name}: ${w}`)),
      );
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['assets'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: api.deleteAsset,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assets'] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  function send(files: FileList | null) {
    if (!files || !files.length) return;
    upload.mutate(Array.from(files));
  }

  return (
    <section>
      <h2>Biblioteka</h2>
      <p className="lead">
        Master za zid je 3840 × 6672 px (odnos 16:27.8). Manje, 1920 × 3336, je u redu ako panel muči
        dekodiranje. Video ide isti odnos, H.264 ili HEVC — server ga sam reže na tri dijela od
        1920 × 1080, po jedan za svaki panel, jer dekoder na panelu ne pušta viši kadar. Rezanje
        počne odmah po uploadu i objava čeka da završi.
      </p>

      {error && <div className="notice error">{error}</div>}
      {rejected.length > 0 && (
        <div className="notice error">
          {rejected.map((r, i) => (
            <div key={i}>
              <strong>{r.name}</strong> — {r.reason}
            </div>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="notice info">
          {warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      <div
        className={over ? 'dropzone over' : 'dropzone'}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          send(e.dataTransfer.files);
        }}
      >
        {upload.isPending
          ? 'Slanje…'
          : 'Prevuci fajlove ovdje ili klikni za odabir. Slike JPEG, PNG ili WebP do 20 MB; video .mp4 (H.264 ili HEVC) do 200 MB.'}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"
          multiple
          hidden
          onChange={(e) => {
            send(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {assets.isLoading && <p className="lead">Učitavanje…</p>}
      {assets.data?.length === 0 && <p className="lead">Biblioteka je prazna.</p>}

      <div className="grid">
        {assets.data?.map((asset) => (
          <AssetCard
            key={asset.id}
            asset={asset}
            onRetry={() => retry.mutate(asset.id)}
            retrying={retry.isPending && retry.variables === asset.id}
            onDelete={() => {
              if (confirm(`Obrisati ${asset.name}? Stavke plejliste koje je koriste nestaju s njom.`)) {
                remove.mutate(asset.id);
              }
            }}
          />
        ))}
      </div>
    </section>
  );
}

function AssetCard({
  asset,
  onDelete,
  onRetry,
  retrying,
}: {
  asset: Asset;
  onDelete: () => void;
  onRetry: () => void;
  retrying: boolean;
}) {
  const off = ratioOff(asset);
  const slices = asset.slices;
  return (
    <article className="asset">
      <div className="thumb">
        {asset.kind === 'video' ? (
          // Sličicu vadi sam browser sa #t=1 — tako ffmpeg ne treba samo zbog
          // pregleda u biblioteci.
          <video src={`${asset.url}#t=1`} muted playsInline preload="metadata" />
        ) : (
          <img src={asset.thumb ?? asset.url} alt="" loading="lazy" />
        )}
      </div>
      <div className="meta">
        <div className="name">{asset.name}</div>
        <div>
          {asset.width} × {asset.height} · {formatBytes(asset.bytes)}
          {asset.kind === 'video' && asset.duration != null && ` · ${formatSeconds(asset.duration)}`}
        </div>
        <div className="badges">
          {asset.kind === 'video' && <span className="badge video">video</span>}
          {off && <span className="badge warn">odnos nije 16:27</span>}
          {slices && (slices.status === 'pending' || slices.status === 'working') && (
            <span className="badge warn">reže se…</span>
          )}
          {slices && slices.status === 'ready' && <span className="badge ok">izrezan na 3 dijela</span>}
          {slices && slices.status === 'error' && <span className="badge bad">rezanje nije uspjelo</span>}
        </div>
        {slices && slices.status === 'error' && slices.error && <div className="slice-error">{slices.error}</div>}
      </div>
      <div className="actions">
        {slices && slices.status === 'error' && (
          <button className="btn small" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Šaljem…' : 'Pokušaj ponovo'}
          </button>
        )}
        <button className="btn small danger" onClick={onDelete}>
          Obriši
        </button>
      </div>
    </article>
  );
}
