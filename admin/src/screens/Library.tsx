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

  const assets = useQuery({ queryKey: ['assets'], queryFn: api.assets });

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
        dekodiranje. Video ide isti odnos, H.264 u .mp4 — svaki panel dekodira cijeli kadar i
        prikazuje svoju trećinu, pa 1920 × 3336 nije preporuka nego granica.
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
          : 'Prevuci fajlove ovdje ili klikni za odabir. Slike JPEG, PNG ili WebP do 20 MB; video .mp4 (H.264) do 200 MB.'}
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

function AssetCard({ asset, onDelete }: { asset: Asset; onDelete: () => void }) {
  const off = ratioOff(asset);
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
        </div>
      </div>
      <div className="actions">
        <button className="btn small danger" onClick={onDelete}>
          Obriši
        </button>
      </div>
    </article>
  );
}
