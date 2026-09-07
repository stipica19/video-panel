// Fastify server: izvor vremena, plejlista, heartbeat, admin API i statični fajlovi.
// Jedan proces servira sve — player, admin build i media.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyBasicAuth from '@fastify/basic-auth';
import sharp from 'sharp';

import { db, ROOT, MEDIA_DIR, THUMB_DIR, TMP_DIR, getSetting, setSetting, getAllSettings } from './db.js';
import { buildPlaylist, publish, playableItems } from './playlist.js';
import { probeMp4 } from './mp4.js';

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // .env je opcion
}

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'videowall';
const PANEL_TOKEN = process.env.PANEL_TOKEN || 'panel-dev-token';

const PUBLIC_DIR = path.join(ROOT, 'public');
const ADMIN_DIST = path.join(ROOT, 'admin', 'dist');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_MB || 200) * 1024 * 1024;
const ALLOWED_FORMATS = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const ALLOWED_VIDEO_EXT = ['mp4', 'm4v', 'mov'];
const MAX_VIDEO_SECONDS = 600;

// Ista naredba kao u Claude.md, samo bez sječenja na tri dijela — kod opcije A
// panel dobija cijeli kadar i sam prikazuje svoju trećinu.
const FFMPEG_HINT =
  'Pripremi ga sa: ffmpeg -i ulaz.mp4 -vf ' +
  '"scale=1920:3336:force_original_aspect_ratio=increase,crop=1920:3336" ' +
  '-c:v libx264 -profile:v high -level 4.1 -pix_fmt yuv420p -preset veryfast -crf 20 ' +
  '-r 25 -fps_mode cfr -g 25 -keyint_min 25 -sc_threshold 0 -movflags +faststart -an izlaz.mp4';

// Master je 3840 × 6672 → odnos visina/širina = 1.7375. Sve što je daleko od
// toga je greška u pripremi, ne sadržaj za zid.
const TARGET_RATIO = 6672 / 3840;
const RATIO_MIN = TARGET_RATIO * 0.75;
const RATIO_MAX = TARGET_RATIO * 1.25;

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' }, bodyLimit: 4 * 1024 * 1024 });

const noStore = (reply) => reply.header('cache-control', 'no-store');
const newId = (prefix) => prefix + '_' + crypto.randomBytes(5).toString('hex');

// ---------------------------------------------------------------- statični dio

await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/public/' });
await app.register(fastifyStatic, {
  root: MEDIA_DIR,
  prefix: '/media/',
  decorateReply: false,
  cacheControl: true,
  maxAge: 2592000000,
  immutable: true,
});

function sendPage(reply, file) {
  noStore(reply);
  return reply.type('text/html; charset=utf-8').sendFile(file);
}

app.get('/', (req, reply) => reply.redirect('/admin/'));
app.get('/player', (req, reply) => sendPage(reply, 'player.html'));
app.get('/kalibracija', (req, reply) => sendPage(reply, 'kalibracija.html'));
app.get('/m0', (req, reply) => sendPage(reply, 'm0.html'));

// ------------------------------------------------------------- javni endpointi

// Izvor vremena. Plain text, bez keša, bez ičega što bi dodalo latenciju.
app.get('/time', (req, reply) => {
  noStore(reply);
  return reply.type('text/plain; charset=utf-8').send(String(Date.now()));
});

app.get('/api/playlist.json', (req, reply) => {
  noStore(reply);
  return buildPlaylist();
});

app.post('/api/heartbeat', (req, reply) => {
  if (req.headers['x-panel-token'] !== PANEL_TOKEN) {
    return reply.code(401).send({ error: 'Neispravan token panela.' });
  }

  const b = req.body || {};
  const n = Number(b.displej);
  if (!(n >= 1 && n <= 3)) return reply.code(400).send({ error: 'displej mora biti 1, 2 ili 3.' });

  db.prepare(`
    UPDATE screens SET
      last_seen = ?, version = ?, ready = ?, item_id = ?,
      clock_offset_ms = ?, uptime_s = ?, error = ?
    WHERE n = ?
  `).run(
    Date.now(),
    b.version ? String(b.version) : null,
    b.ready ? String(b.ready) : null,
    b.itemId ? String(b.itemId) : null,
    b.clockOffsetMs == null ? null : Number(b.clockOffsetMs),
    b.uptimeS == null ? null : Math.round(Number(b.uptimeS)),
    b.error ? String(b.error).slice(0, 500) : null,
    n,
  );

  const row = db.prepare('SELECT pending_command FROM screens WHERE n = ?').get(n);
  let command = 'none';
  if (row && row.pending_command) {
    command = row.pending_command;
    db.prepare('UPDATE screens SET pending_command = NULL WHERE n = ?').run(n);
  }

  noStore(reply);
  return { command };
});

// ------------------------------------------------------- admin (basic auth)

await app.register(async (scope) => {
  await scope.register(fastifyBasicAuth, {
    validate: async (username, password) => {
      const okUser = crypto.timingSafeEqual(
        Buffer.from(String(username).padEnd(64).slice(0, 64)),
        Buffer.from(ADMIN_USER.padEnd(64).slice(0, 64)),
      );
      const okPass = crypto.timingSafeEqual(
        Buffer.from(String(password).padEnd(64).slice(0, 64)),
        Buffer.from(ADMIN_PASS.padEnd(64).slice(0, 64)),
      );
      if (!okUser || !okPass) return new Error('Neispravno korisničko ime ili lozinka.');
    },
    authenticate: { realm: 'video-wall' },
  });

  scope.addHook('onRequest', scope.basicAuth);

  await scope.register(fastifyMultipart, { limits: { fileSize: MAX_VIDEO_BYTES, files: 12 } });

  scope.get('/admin', (req, reply) => reply.redirect('/admin/'));

  if (fs.existsSync(path.join(ADMIN_DIST, 'index.html'))) {
    await scope.register(fastifyStatic, { root: ADMIN_DIST, prefix: '/admin/', decorateReply: false });
  } else {
    scope.get('/admin/', (req, reply) => {
      noStore(reply);
      return reply.type('text/html; charset=utf-8').send(
        '<body style="font:16px system-ui;padding:40px;background:#111;color:#eee">' +
        '<h1>Admin nije izgrađen</h1><p>Pokreni <code>npm run setup</code> pa osvježi stranicu.</p></body>',
      );
    });
  }

  // --- biblioteka -----------------------------------------------------------

  scope.get('/api/assets', (req, reply) => {
    noStore(reply);
    return db.prepare('SELECT * FROM assets ORDER BY created_at DESC').all().map(withUrls);
  });

  scope.post('/api/assets', async (req, reply) => {
    noStore(reply);
    const saved = [];
    const rejected = [];

    let parts;
    try {
      parts = req.files();
    } catch (err) {
      return reply.code(400).send({ error: 'Očekivan je multipart upload.' });
    }

    for await (const part of parts) {
      const name = part.filename || 'fajl';
      const isVideo = /\.(mp4|m4v|mov)$/i.test(name) || String(part.mimetype || '').startsWith('video/');

      try {
        if (isVideo) {
          saved.push(await storeVideo(part, name));
        } else {
          let buf;
          try {
            buf = await part.toBuffer();
          } catch (err) {
            throw new Error(`Slika je veća od ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`);
          }
          if (buf.length > MAX_IMAGE_BYTES) {
            throw new Error(`Slika je veća od ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`);
          }
          saved.push(await storeImage(buf, name));
        }
      } catch (err) {
        rejected.push({ name, reason: err.message });
      }
    }

    if (!saved.length && rejected.length) return reply.code(400).send({ saved, rejected });
    return { saved, rejected };
  });

  scope.delete('/api/assets/:id', (req, reply) => {
    noStore(reply);
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
    if (!asset) return reply.code(404).send({ error: 'Nema takvog fajla.' });

    db.transaction(() => {
      db.prepare('DELETE FROM items WHERE asset_id = ?').run(asset.id);
      db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
    })();

    // Fajl sa diska brišemo samo ako ga niko više ne koristi.
    const stillUsed = db.prepare('SELECT 1 FROM assets WHERE file = ?').get(asset.file);
    if (!stillUsed) {
      fs.rmSync(path.join(MEDIA_DIR, asset.file), { force: true });
      fs.rmSync(path.join(THUMB_DIR, thumbName(asset.file)), { force: true });
    }

    return { ok: true };
  });

  // --- plejlista ------------------------------------------------------------

  scope.get('/api/items', (req, reply) => {
    noStore(reply);
    return listItems();
  });

  scope.put('/api/items', (req, reply) => {
    noStore(reply);
    const incoming = Array.isArray(req.body) ? req.body : [];
    const prepared = [];

    for (const it of incoming) {
      const asset = db.prepare('SELECT id, kind, duration FROM assets WHERE id = ?').get(it.asset_id);
      if (!asset) return reply.code(400).send({ error: 'Nepoznat asset_id: ' + it.asset_id });

      // Video sam diktira svoje trajanje i nema pokret: ciklus mora biti tačan
      // do milisekunde, a Ken Burns preko videa je samo dodatni posao dekoderu.
      if (asset.kind === 'video') {
        prepared.push({ ...it, duration: Number(asset.duration), motion: { kind: 'none' } });
        continue;
      }

      const duration = Number(it.duration);
      if (!(duration >= 1 && duration <= 600)) {
        return reply.code(400).send({ error: 'Trajanje mora biti između 1 i 600 sekundi.' });
      }
      if (!isValidMotion(it.motion)) {
        return reply.code(400).send({ error: 'Nepoznat tip pokreta.' });
      }
      prepared.push({ ...it, duration, motion: it.motion });
    }

    db.transaction(() => {
      db.prepare('DELETE FROM items').run();
      const stmt = db.prepare(
        'INSERT INTO items (id, asset_id, position, duration, motion, enabled) VALUES (?, ?, ?, ?, ?, ?)',
      );
      prepared.forEach((it, index) => {
        stmt.run(
          it.id && String(it.id).startsWith('itm_') ? it.id : newId('itm'),
          it.asset_id,
          index,
          it.duration,
          JSON.stringify(normalizeMotion(it.motion)),
          it.enabled ? 1 : 0,
        );
      });
    })();

    return listItems();
  });

  // --- objava ---------------------------------------------------------------

  scope.post('/api/publish', (req, reply) => {
    noStore(reply);
    const body = req.body || {};
    const delay = body.delayS == null ? Number(getSetting('publish_delay_s', '90')) : Number(body.delayS);
    if (!(delay >= 0 && delay <= 3600)) return reply.code(400).send({ error: 'Odgoda mora biti 0–3600 s.' });
    return publish(delay);
  });

  scope.get('/api/publish/state', (req, reply) => {
    noStore(reply);
    const pl = buildPlaylist();
    const draft = playableItems();
    const draftVersion = draft.length
      ? crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex').slice(0, 6)
      : null;
    return {
      bezel: pl.bezel,
      draftVersion,
      draftCount: draft.length,
      current: pl.current ? { version: pl.current.version, epoch: pl.current.epoch, count: pl.current.items.length } : null,
      next: pl.next ? { version: pl.next.version, activeFrom: pl.next.activeFrom, count: pl.next.items.length } : null,
      serverNow: Date.now(),
    };
  });

  // --- paneli ---------------------------------------------------------------

  scope.get('/api/screens', (req, reply) => {
    noStore(reply);
    const now = Date.now();
    return db.prepare('SELECT * FROM screens ORDER BY n').all().map((s) => ({
      ...s,
      online: !!s.last_seen && now - s.last_seen < 90000,
      secondsSinceSeen: s.last_seen ? Math.round((now - s.last_seen) / 1000) : null,
    }));
  });

  scope.post('/api/screens/:n/command', (req, reply) => {
    noStore(reply);
    const n = Number(req.params.n);
    const command = (req.body || {}).command;
    if (!(n >= 1 && n <= 3)) return reply.code(400).send({ error: 'Panel mora biti 1, 2 ili 3.' });
    if (!['reload', 'resync', 'none'].includes(command)) {
      return reply.code(400).send({ error: 'Komanda mora biti reload, resync ili none.' });
    }
    db.prepare('UPDATE screens SET pending_command = ? WHERE n = ?').run(command === 'none' ? null : command, n);
    return { ok: true };
  });

  // --- postavke -------------------------------------------------------------

  scope.get('/api/settings', (req, reply) => {
    noStore(reply);
    return getAllSettings();
  });

  scope.put('/api/settings', (req, reply) => {
    noStore(reply);
    const body = req.body || {};

    if (body.bezel_px != null) {
      let bezel = Math.round(Number(body.bezel_px));
      if (!(bezel >= 0 && bezel <= 400)) return reply.code(400).send({ error: 'bezel_px mora biti 0–400.' });
      if (bezel % 2 !== 0) bezel += 1; // mora biti paran — vidi napomenu o yuv420p
      setSetting('bezel_px', bezel);
    }

    if (body.publish_delay_s != null) {
      const delay = Math.round(Number(body.publish_delay_s));
      if (!(delay >= 0 && delay <= 3600)) return reply.code(400).send({ error: 'publish_delay_s mora biti 0–3600.' });
      setSetting('publish_delay_s', delay);
    }

    return getAllSettings();
  });
});

// ------------------------------------------------------------------- pomoćne

function thumbName(file) {
  return file.replace(/\.[^.]+$/, '') + '.webp';
}

function withUrls(row) {
  const kind = row.kind === 'video' ? 'video' : 'image';
  return {
    ...row,
    kind,
    url: '/media/' + row.file,
    // Video nema thumbnail na disku — admin pušta sam element sa #t= i browser
    // izvuče kadar. Tako ne treba ffmpeg samo zbog sličice u biblioteci.
    thumb: kind === 'video' ? null : '/media/thumbs/' + thumbName(row.file),
    ratio: row.width && row.height ? row.height / row.width : null,
  };
}

function listItems() {
  return db.prepare(`
    SELECT i.*, a.file, a.name AS asset_name, a.width, a.height, a.kind, a.duration AS asset_duration
    FROM items i JOIN assets a ON a.id = i.asset_id
    ORDER BY i.position ASC
  `).all().map((r) => ({
    id: r.id,
    asset_id: r.asset_id,
    position: r.position,
    duration: Number(r.duration),
    motion: JSON.parse(r.motion),
    enabled: r.enabled,
    asset: {
      name: r.asset_name,
      kind: r.kind === 'video' ? 'video' : 'image',
      url: '/media/' + r.file,
      thumb: r.kind === 'video' ? null : '/media/thumbs/' + thumbName(r.file),
      width: r.width,
      height: r.height,
      duration: r.asset_duration == null ? null : Number(r.asset_duration),
    },
  }));
}

const MOTION_KINDS = ['none', 'kenburns', 'driftY'];

function isValidMotion(motion) {
  return motion && typeof motion === 'object' && MOTION_KINDS.includes(motion.kind);
}

function normalizeMotion(motion) {
  const kind = motion.kind;
  if (kind === 'kenburns') {
    return {
      kind,
      scaleFrom: clamp(Number(motion.scaleFrom) || 1.0, 1.0, 1.5),
      scaleTo: clamp(Number(motion.scaleTo) || 1.06, 1.0, 1.5),
      panY: clamp(Number(motion.panY) || 0, -8, 8),
    };
  }
  if (kind === 'driftY') {
    return { kind, panY: clamp(Number(motion.panY) || -2, -8, 8) };
  }
  return { kind: 'none' };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function slugOf(originalName) {
  return String(originalName).replace(/\.[^.]+$/, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'fajl';
}

function checkRatio(width, height, what) {
  const ratio = height / width;
  if (ratio < RATIO_MIN || ratio > RATIO_MAX) {
    throw new Error(
      `Odnos stranica ${ratio.toFixed(2)}:1 je predaleko od zida (traži se ${TARGET_RATIO.toFixed(2)}:1, ` +
      `npr. ${what === 'video' ? '1920 × 3336' : '3840 × 6672'}).`,
    );
  }
  return ratio;
}

// Video se ne drži u memoriji — teče pravo u tmp/, a heš se računa usput.
// Tek kad kontejner prođe provjeru, fajl se premješta u media/.
async function storeVideo(part, originalName) {
  const match = String(originalName).match(/\.([a-z0-9]+)$/i);
  const ext = (match ? match[1] : 'mp4').toLowerCase();
  if (!ALLOWED_VIDEO_EXT.includes(ext)) {
    throw new Error('Dozvoljeni video formati su .mp4, .m4v i .mov.');
  }

  const tmpPath = path.join(TMP_DIR, `up-${crypto.randomBytes(6).toString('hex')}.${ext}`);
  const hash = crypto.createHash('sha256');

  await pipeline(
    part.file,
    new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    fs.createWriteStream(tmpPath),
  );

  const drop = (message) => {
    fs.rmSync(tmpPath, { force: true });
    throw new Error(message);
  };

  if (part.file.truncated) {
    drop(`Video je veći od ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} MB.`);
  }

  const probe = probeMp4(tmpPath);
  if (!probe.ok) drop(`${probe.reason} ${FFMPEG_HINT}`);

  if (probe.codec !== 'avc1') {
    drop(`Video mora biti H.264 (avc1), a ovaj je "${probe.codec || 'nepoznat'}". ${FFMPEG_HINT}`);
  }
  if (!(probe.durationS >= 1 && probe.durationS <= MAX_VIDEO_SECONDS)) {
    drop(`Trajanje ${probe.durationS.toFixed(1)} s je izvan dozvoljenog raspona 1–${MAX_VIDEO_SECONDS} s.`);
  }

  let ratio;
  try {
    ratio = checkRatio(probe.width, probe.height, 'video');
  } catch (err) {
    drop(err.message);
  }

  const warnings = [];
  if (ext === 'mov') warnings.push('Kontejner je .mov — radi u browseru, ali je za panele sigurnije .mp4.');
  if (probe.width < 1900) warnings.push(`Širina je ${probe.width} px; zid je 1920 px pa se slika razvlači.`);
  if (Math.abs(ratio - TARGET_RATIO) / TARGET_RATIO > 0.05) {
    warnings.push(`Odnos ${ratio.toFixed(2)}:1 nije 1.74:1 — krajevi kadra će biti odsječeni.`);
  }

  const bytes = fs.statSync(tmpPath).size;
  const file = `${slugOf(originalName)}-${hash.digest('hex').slice(0, 6)}.${ext}`;

  const existing = db.prepare('SELECT * FROM assets WHERE file = ?').get(file);
  if (existing) {
    fs.rmSync(tmpPath, { force: true });
    return { ...withUrls(existing), warnings };
  }

  fs.renameSync(tmpPath, path.join(MEDIA_DIR, file));

  const row = {
    id: newId('ast'),
    name: String(originalName).slice(0, 120),
    file,
    width: probe.width,
    height: probe.height,
    bytes,
    created_at: Date.now(),
    kind: 'video',
    duration: Math.round(probe.durationS * 1000) / 1000,
  };
  db.prepare(`
    INSERT INTO assets (id, name, file, width, height, bytes, created_at, kind, duration)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.name, row.file, row.width, row.height, row.bytes, row.created_at, row.kind, row.duration);

  return { ...withUrls(row), warnings };
}

// Upload ide u tmp/, tek nakon provjere se premješta u media/. Ime nosi heš
// sadržaja, pa se isti fajl nikad ne prepisuje.
async function storeImage(buf, originalName) {
  let meta;
  try {
    meta = await sharp(buf).metadata();
  } catch (err) {
    throw new Error('Fajl nije prepoznat kao slika.');
  }

  const ext = ALLOWED_FORMATS[meta.format];
  if (!ext) throw new Error('Dozvoljeni formati su JPEG, PNG i WebP.');
  if (!meta.width || !meta.height) throw new Error('Nije moguće pročitati dimenzije slike.');

  checkRatio(meta.width, meta.height, 'image');

  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 6);
  const file = `${slugOf(originalName)}-${hash}.${ext}`;

  const existing = db.prepare('SELECT * FROM assets WHERE file = ?').get(file);
  if (existing) return withUrls(existing);

  const tmpPath = path.join(TMP_DIR, `${hash}-${process.pid}-${Date.now()}.${ext}`);
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, path.join(MEDIA_DIR, file));

  await sharp(buf).resize({ width: 180 }).webp({ quality: 78 }).toFile(path.join(THUMB_DIR, thumbName(file)));

  const row = {
    id: newId('ast'),
    name: String(originalName).slice(0, 120),
    file,
    width: meta.width,
    height: meta.height,
    bytes: buf.length,
    created_at: Date.now(),
    kind: 'image',
    duration: null,
  };
  db.prepare(`
    INSERT INTO assets (id, name, file, width, height, bytes, created_at, kind, duration)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.name, row.file, row.width, row.height, row.bytes, row.created_at, row.kind, row.duration);

  return withUrls(row);
}

app.setErrorHandler((err, req, reply) => {
  req.log.error(err);
  const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  reply.code(code).send({ error: err.message || 'Greška na serveru.' });
});

// Docker pri restartu šalje SIGTERM. Bez ovoga se čeka deset sekundi pa stiže
// SIGKILL — a SQLite ne treba prekidati usred pisanja.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    app.log.info(`${signal} — gasim se`);
    try {
      await app.close();
      db.close();
    } catch (err) {
      app.log.error(err);
    }
    process.exit(0);
  });
}

await app.listen({ port: PORT, host: HOST });

app.log.info(`player:      http://localhost:${PORT}/player?displej=1`);
app.log.info(`kalibracija: http://localhost:${PORT}/kalibracija?displej=1`);
app.log.info(`m0:          http://localhost:${PORT}/m0`);
app.log.info(`admin:       http://localhost:${PORT}/admin/  (${ADMIN_USER} / ${ADMIN_PASS})`);
