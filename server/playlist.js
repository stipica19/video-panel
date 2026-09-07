// Sastavljanje plejliste i dvofazna objava.
import crypto from 'node:crypto';
import { db, getSetting, setSetting } from './db.js';

// Stavke iz baze u obliku koji player razumije.
export function playableItems() {
  const rows = db.prepare(`
    SELECT i.id, i.duration, i.motion, a.file, a.kind
    FROM items i JOIN assets a ON a.id = i.asset_id
    WHERE i.enabled = 1
    ORDER BY i.position ASC
  `).all();

  return rows.map((r) => ({
    id: r.id,
    type: r.kind === 'video' ? 'video' : 'image',
    file: '/media/' + r.file,
    duration: Number(r.duration),
    motion: JSON.parse(r.motion),
  }));
}

// Ako je stiglo vrijeme, `next` postaje `current`. Poziva se pri svakom čitanju
// plejliste, pa server i panели vide istu promociju bez ijednog cron posla.
function promoteIfDue() {
  const nextVersion = getSetting('next_version');
  const activeFrom = Number(getSetting('next_active_from', 0));
  if (!nextVersion || !activeFrom) return;
  if (Date.now() < activeFrom) return;

  setSetting('current_version', nextVersion);
  setSetting('current_epoch', String(activeFrom));
  setSetting('next_version', '');
  setSetting('next_active_from', '');
}

export function buildPlaylist() {
  promoteIfDue();

  const out = {
    bezel: Number(getSetting('bezel_px', '48')),
    current: null,
    next: null,
  };

  const currentVersion = getSetting('current_version');
  if (currentVersion) {
    const pub = db.prepare('SELECT payload FROM publications WHERE version = ?').get(currentVersion);
    if (pub) {
      out.current = {
        version: currentVersion,
        epoch: Number(getSetting('current_epoch', '0')),
        items: JSON.parse(pub.payload),
      };
    }
  }

  const nextVersion = getSetting('next_version');
  if (nextVersion) {
    const pub = db.prepare('SELECT payload, active_from FROM publications WHERE version = ?').get(nextVersion);
    if (pub) {
      out.next = {
        version: nextVersion,
        activeFrom: Number(pub.active_from),
        epoch: Number(pub.active_from),
        items: JSON.parse(pub.payload),
      };
    }
  }

  return out;
}

export function publish(delaySeconds) {
  promoteIfDue();

  const items = playableItems();
  if (!items.length) {
    const err = new Error('Plejlista je prazna — nema šta objaviti.');
    err.statusCode = 400;
    throw err;
  }

  const payload = JSON.stringify(items);
  const version = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 6);
  const now = Date.now();
  const currentVersion = getSetting('current_version');

  if (version === currentVersion) {
    return { version, activeFrom: Number(getSetting('current_epoch', '0')), count: items.length, unchanged: true };
  }

  // Prva objava ide odmah — nema šta da se raspadne jer ništa još ne svira.
  const activeFrom = currentVersion ? now + Math.round(delaySeconds * 1000) : now;

  db.prepare('INSERT OR REPLACE INTO publications (version, payload, active_from, created_at) VALUES (?, ?, ?, ?)')
    .run(version, payload, activeFrom, now);

  if (currentVersion) {
    setSetting('next_version', version);
    setSetting('next_active_from', String(activeFrom));
  } else {
    setSetting('current_version', version);
    setSetting('current_epoch', String(activeFrom));
    setSetting('next_version', '');
    setSetting('next_active_from', '');
  }

  return { version, activeFrom, count: items.length, unchanged: false };
}
