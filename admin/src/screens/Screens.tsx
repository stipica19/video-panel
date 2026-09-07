import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Screen } from '../api';

// Ekran koji se gleda svaki dan.
export function Screens() {
  const queryClient = useQueryClient();
  const screens = useQuery({ queryKey: ['screens'], queryFn: api.screens, refetchInterval: 3000 });
  const state = useQuery({ queryKey: ['publishState'], queryFn: api.publishState, refetchInterval: 3000 });

  const command = useMutation({
    mutationFn: ({ n, cmd }: { n: number; cmd: 'reload' | 'resync' }) => api.command(n, cmd),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['screens'] }),
  });

  const currentVersion = state.data?.current?.version ?? null;

  return (
    <section>
      <h2>Stanje panela</h2>
      <p className="lead">
        Panel je offline ako se nije javio 90 sekundi. Komanda stiže uz sljedeći heartbeat, najkasnije
        za 30 sekundi.
      </p>

      {state.data?.next && (
        <div className="notice info">
          Verzija <code>{state.data.next.version}</code> postaje aktivna u{' '}
          {new Date(state.data.next.activeFrom).toLocaleTimeString('bs-BA')} — paneli koji su je već
          preuzeli pišu je pod „spremno”.
        </div>
      )}

      <div className="screens">
        {screens.data?.map((screen) => (
          <ScreenCard
            key={screen.n}
            screen={screen}
            currentVersion={currentVersion}
            onCommand={(cmd) => command.mutate({ n: screen.n, cmd })}
          />
        ))}
      </div>
    </section>
  );
}

function ScreenCard({
  screen,
  currentVersion,
  onCommand,
}: {
  screen: Screen;
  currentVersion: string | null;
  onCommand: (cmd: 'reload' | 'resync') => void;
}) {
  const stale = screen.version && currentVersion && screen.version !== currentVersion;

  return (
    <article className={screen.online ? 'screen-card' : 'screen-card offline'}>
      <div className="screen-head">
        <span className={screen.online ? 'dot on' : 'dot'} />
        <span className="n">Panel {screen.n}</span>
        <span className="muted">
          {screen.online
            ? `viđen prije ${screen.secondsSinceSeen} s`
            : screen.last_seen
              ? `nema javljanja ${screen.secondsSinceSeen} s`
              : 'nikad se nije javio'}
        </span>
      </div>

      <dl className="kv">
        <dt>Verzija</dt>
        <dd>
          <code>{screen.version ?? '—'}</code> {stale && <span className="badge warn">nije aktuelna</span>}
        </dd>

        <dt>Spremno</dt>
        <dd>
          <code>{screen.ready ?? '—'}</code>
        </dd>

        <dt>Stavka</dt>
        <dd>
          <code>{screen.item_id ?? '—'}</code>
        </dd>

        <dt>Offset sata</dt>
        <dd>{screen.clock_offset_ms == null ? '—' : `${screen.clock_offset_ms.toFixed(1)} ms`}</dd>

        <dt>Uptime</dt>
        <dd>{screen.uptime_s == null ? '—' : formatUptime(screen.uptime_s)}</dd>

        {screen.error && (
          <>
            <dt>Greška</dt>
            <dd style={{ color: 'var(--bad)' }}>{screen.error}</dd>
          </>
        )}

        {screen.pending_command && (
          <>
            <dt>Čeka</dt>
            <dd>{screen.pending_command}</dd>
          </>
        )}
      </dl>

      <div className="row">
        <button className="btn small" onClick={() => onCommand('reload')}>
          Reload
        </button>
        <button className="btn small" onClick={() => onCommand('resync')}>
          Resync sata
        </button>
        <a className="btn small" href={`/player?displej=${screen.n}&hud=1`} target="_blank" rel="noreferrer">
          Otvori
        </a>
      </div>
    </article>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}
