// Tanki sloj nad admin API-jem. Basic auth rješava browser.

export type MediaKind = 'image' | 'video';

export type SliceStatus = 'pending' | 'working' | 'ready' | 'error';

// Stanje rezanja videa na tri dijela, po jedan za svaki panel. Vezano je za
// trenutni razmak za okvire — promjena bezela znači novo rezanje.
export type Slices = {
  status: SliceStatus;
  error: string | null;
  bezel: number;
};

export type Asset = {
  id: string;
  name: string;
  file: string;
  width: number;
  height: number;
  bytes: number;
  created_at: number;
  kind: MediaKind;
  duration: number | null; // vlastito trajanje videa u sekundama
  url: string;
  thumb: string | null; // video nema sličicu na disku
  ratio: number | null;
  slices: Slices | null; // samo video
  warnings?: string[]; // samo u odgovoru na upload
};

export type MotionKind = 'none' | 'kenburns' | 'driftY';

export type Motion = {
  kind: MotionKind;
  scaleFrom?: number;
  scaleTo?: number;
  panY?: number;
};

export type Item = {
  id: string;
  asset_id: string;
  position: number;
  duration: number;
  motion: Motion;
  enabled: number;
  asset: {
    name: string;
    kind: MediaKind;
    url: string;
    thumb: string | null;
    width: number;
    height: number;
    duration: number | null;
  };
};

export type Screen = {
  n: number;
  last_seen: number | null;
  version: string | null;
  ready: string | null;
  item_id: string | null;
  clock_offset_ms: number | null;
  uptime_s: number | null;
  error: string | null;
  pending_command: string | null;
  online: boolean;
  secondsSinceSeen: number | null;
};

export type PublishState = {
  bezel: number;
  draftVersion: string | null;
  draftCount: number;
  current: { version: string; epoch: number; count: number } | null;
  next: { version: string; activeFrom: number; count: number } | null;
  serverNow: number;
};

export type Settings = Record<string, string>;

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      // Fastify u `error` stavlja ime statusa ("Conflict"), a pravu poruku u
      // `message` — pa `message` ima prednost kad ga odgovor nosi.
      if (body && body.message) message = body.message;
      else if (body && body.error) message = body.error;
    } catch {
      // odgovor nije JSON — ostaje statusText
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  assets: () => req<Asset[]>('/api/assets'),

  upload: async (files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append('file', file);
    return req<{ saved: Asset[]; rejected: { name: string; reason: string }[] }>('/api/assets', {
      method: 'POST',
      body: form,
    });
  },

  deleteAsset: (id: string) => req<{ ok: true }>(`/api/assets/${id}`, { method: 'DELETE' }),

  retrySlices: (id: string) => req<Slices>(`/api/assets/${id}/slices/retry`, { method: 'POST' }),

  items: () => req<Item[]>('/api/items'),

  saveItems: (items: Pick<Item, 'id' | 'asset_id' | 'duration' | 'motion' | 'enabled'>[]) =>
    req<Item[]>('/api/items', json(items)),

  publish: (delayS?: number) =>
    req<{ version: string; activeFrom: number; count: number; unchanged: boolean }>('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(delayS == null ? {} : { delayS }),
    }),

  publishState: () => req<PublishState>('/api/publish/state'),

  screens: () => req<Screen[]>('/api/screens'),

  command: (n: number, command: 'reload' | 'resync') =>
    req<{ ok: true }>(`/api/screens/${n}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    }),

  settings: () => req<Settings>('/api/settings'),

  saveSettings: (patch: Record<string, string | number>) => req<Settings>('/api/settings', json(patch)),
};

// Master je 3840 × 6672 → 1.7375. Sve dalje od 5 % dobija upozorenje.
export const TARGET_RATIO = 6672 / 3840;

export function ratioOff(asset: { width: number; height: number }): boolean {
  if (!asset.width || !asset.height) return true;
  const ratio = asset.height / asset.width;
  return Math.abs(ratio - TARGET_RATIO) / TARGET_RATIO > 0.05;
}

export function formatBytes(bytes: number): string {
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.round(bytes / 1024) + ' kB';
}

export function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) return whole + ' s';
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m} min ${s} s`;
}

export function formatSeconds(seconds: number): string {
  return (Math.round(seconds * 10) / 10).toFixed(1) + ' s';
}
