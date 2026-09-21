// Sječenje videa na tri dijela, po jedan za svaki panel (opcija B iz Claude.md).
//
// Zašto: hardverski dekoder u Tizen browseru na QM55C ne pušta video viši od
// 2160 px. Kadar cijelog zida (1920 × 3336) ostane crn ekran, bez ijedne greške
// u konzoli. Slike prolaze jer ide softverski dekoder, video ne. Zato server
// unaprijed izreže svaki video na tri dijela od 1920 × 1080 i panel dobije samo
// svoj — dekoder vidi običan 1080p snimak.
//
// Jedan prolaz ffmpega, ne tri poziva: dekodiranje se desi jednom i sva tri
// enkodera vide isti niz frejmova sa istim vremenskim oznakama. Tri odvojena
// poziva umiju dati fajlove koji se razlikuju za jedan frejm — a to je drift
// koji se u browseru ne može izliječiti.
//
// Reda poslova nema: jedan `setInterval` i zastavica. Poslova je najviše
// nekoliko na dan i svi su na istoj mašini.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { db, MEDIA_DIR, TMP_DIR, getSetting } from './db.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const SLICE_W = 1920;
const SLICE_H = 1080;
const FPS = 25;

const TICK_MS = 3000;
const TIMEOUT_MS = 15 * 60 * 1000;

// Isti enkoder za sva tri izlaza. `-r 25` uz `fps=25` u filteru daje CFR:
// snimci sa telefona su često VFR, a VFR i sinhronizacija se ne podnose.
// Fiksni GOP od 25 frejmova znači ključni kadar svake sekunde, pa je skok na
// poziciju po serverskom satu jeftin.
const ENC = [
  '-c:v', 'libx264',
  '-profile:v', 'high',
  '-level', '4.1',
  '-pix_fmt', 'yuv420p',
  '-preset', 'veryfast',
  '-crf', '20',
  '-maxrate', '12M',
  '-bufsize', '24M',
  '-r', String(FPS),
  '-g', String(FPS),
  '-keyint_min', String(FPS),
  '-sc_threshold', '0',
  '-movflags', '+faststart',
  '-an',
];

let busy = false;
let log = console;

// ------------------------------------------------------------------ geometrija

// Razmak za okvire u pikselima videa. Panel prijavi svoju visinu u CSS px
// (`panel_h` iz /m0), a dio je uvijek 1080 px visok — pa se `bezel_px` mora
// preračunati u istu skalu. Paran broj je obavezan: yuv420p ima poduzorkovanu
// hromu i neparan `y` offset tiho pomjeri boju.
export function videoBezel() {
  const bezelPx = Number(getSetting('bezel_px', '48'));
  const panelH = Number(getSetting('panel_h', '1080'));

  const safeBezel = bezelPx >= 0 && bezelPx <= 400 ? bezelPx : 48;
  const safePanelH = panelH >= 400 && panelH <= 4320 ? panelH : 1080;

  return Math.round((safeBezel * SLICE_H) / safePanelH / 2) * 2;
}

function sliceNames(file, bezel) {
  const base = file.replace(/\.[^.]+$/, '');
  return [1, 2, 3].map((n) => `${base}-b${bezel}-${n}.mp4`);
}

// -------------------------------------------------------------------- upiti

// Stanje dijelova za trenutni razmak. `pending` znači da red za ovaj bezel
// još ne postoji — posao ga pokupi u najviše tri sekunde.
export function slicesFor(assetId) {
  const bezel = videoBezel();
  const row = db.prepare('SELECT * FROM video_slices WHERE asset_id = ? AND bezel = ?').get(assetId, bezel);
  if (!row) return { status: 'pending', files: null, error: null, bezel };

  return {
    status: row.status,
    files: row.status === 'ready' ? parseFiles(row.files).map((f) => '/media/' + f) : null,
    error: row.error,
    bezel,
  };
}

export function deleteSlicesFor(assetId) {
  // Isti fajl ne može pripadati dvama assetima — upload prepoznaje heš sadržaja
  // i vrati postojeći red — pa se dijelovi brišu bez provjere ko ih još koristi.
  for (const row of db.prepare('SELECT files FROM video_slices WHERE asset_id = ?').all(assetId)) {
    removeFiles(row.files);
  }
  db.prepare('DELETE FROM video_slices WHERE asset_id = ?').run(assetId);
}

export function retrySlices(assetId) {
  const asset = db.prepare('SELECT id, kind FROM assets WHERE id = ?').get(assetId);
  if (!asset) {
    const err = new Error('Nema takvog fajla.');
    err.statusCode = 404;
    throw err;
  }
  if (asset.kind !== 'video') {
    const err = new Error('Samo se video reže na dijelove.');
    err.statusCode = 400;
    throw err;
  }

  const bezel = videoBezel();
  const row = db.prepare('SELECT status, files FROM video_slices WHERE asset_id = ? AND bezel = ?')
    .get(assetId, bezel);

  // Posao koji upravo traje se ne prekida — dugme se ionako nudi samo na grešci.
  if (row && row.status !== 'working') {
    removeFiles(row.files);
    db.prepare('DELETE FROM video_slices WHERE asset_id = ? AND bezel = ?').run(assetId, bezel);
  }

  return slicesFor(assetId);
}

function parseFiles(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function removeFiles(value) {
  for (const name of parseFiles(value)) {
    fs.rmSync(path.join(MEDIA_DIR, path.basename(name)), { force: true });
  }
}

// -------------------------------------------------------------------- posao

export function startSlicer(logger) {
  if (logger) log = logger;

  // Posao prekinut gašenjem servera nema ko dovršiti — neka se ponovi.
  const stale = db.prepare("DELETE FROM video_slices WHERE status = 'working'").run();
  if (stale.changes) log.info(`slicer: ${stale.changes} prekinutih poslova vraćeno u red`);

  setInterval(tick, TICK_MS);
  tick();
}

function nextJob() {
  const bezel = videoBezel();
  const asset = db.prepare(`
    SELECT a.id, a.name, a.file FROM assets a
    LEFT JOIN video_slices s ON s.asset_id = a.id AND s.bezel = ?
    WHERE a.kind = 'video' AND s.asset_id IS NULL
    ORDER BY a.created_at ASC
    LIMIT 1
  `).get(bezel);

  return asset ? { asset, bezel } : null;
}

function tick() {
  if (busy) return;
  const job = nextJob();
  if (!job) return;

  busy = true;
  runJob(job).catch((err) => log.error(err)).then(() => { busy = false; });
}

async function runJob(job) {
  const { asset, bezel } = job;
  const input = path.join(MEDIA_DIR, asset.file);
  const names = sliceNames(asset.file, bezel);
  const stamp = crypto.randomBytes(4).toString('hex');
  const tmpPaths = names.map((name) => path.join(TMP_DIR, `slice-${stamp}-${name}`));

  db.prepare(`
    INSERT OR REPLACE INTO video_slices (asset_id, bezel, status, files, frames, error, updated_at)
    VALUES (?, ?, 'working', NULL, NULL, NULL, ?)
  `).run(asset.id, bezel, Date.now());

  const started = Date.now();

  try {
    if (!fs.existsSync(input)) throw new Error('Izvorni fajl nije nađen na disku.');

    await runFfmpeg(input, tmpPaths, bezel);

    // Sva tri dijela moraju imati isti broj frejmova. Ako nemaju, prošlo je
    // nešto što se u browseru vidi kao zid koji se razilazi — bolje greška.
    const frames = [];
    for (const file of tmpPaths) frames.push(await countPackets(file));

    if (!(frames[0] > 0)) throw new Error('Izrezani fajl nema nijedan frejm.');
    if (frames[0] !== frames[1] || frames[1] !== frames[2]) {
      throw new Error(`Dijelovi nemaju isti broj frejmova (${frames.join(' / ')}).`);
    }

    // Tek sad u media/ — nedovršen fajl nikad ne završi na adresi koju panel čita.
    names.forEach((name, i) => fs.renameSync(tmpPaths[i], path.join(MEDIA_DIR, name)));

    db.prepare(`
      UPDATE video_slices SET status = 'ready', files = ?, frames = ?, error = NULL, updated_at = ?
      WHERE asset_id = ? AND bezel = ?
    `).run(JSON.stringify(names), frames[0], Date.now(), asset.id, bezel);

    log.info(
      `slicer: ${asset.name} izrezan na tri dijela (bezel ${bezel} px, ${frames[0]} frejmova, ` +
      `${Math.round((Date.now() - started) / 1000)} s)`,
    );
  } catch (err) {
    for (const file of tmpPaths) fs.rmSync(file, { force: true });

    const message = String(err && err.message ? err.message : err).slice(0, 500);
    db.prepare(`
      UPDATE video_slices SET status = 'error', files = NULL, frames = NULL, error = ?, updated_at = ?
      WHERE asset_id = ? AND bezel = ?
    `).run(message, Date.now(), asset.id, bezel);

    log.error(`slicer: ${asset.name} — ${message}`);
  }
}

function runFfmpeg(input, outputs, bezel) {
  const wallH = 3 * SLICE_H + 2 * bezel;

  // Jedno dekodiranje, tri izlaza. Razmak za okvire se izbacuje rezom: dio n
  // počinje na n × (1080 + bezel), pa piksela pod okvirom nema ni u jednom dijelu.
  const chain =
    `[0:v]scale=${SLICE_W}:${wallH}:force_original_aspect_ratio=increase,` +
    `crop=${SLICE_W}:${wallH},setsar=1,fps=${FPS},split=3[a][b][c];` +
    ['a', 'b', 'c']
      .map((tag, i) => `[${tag}]crop=${SLICE_W}:${SLICE_H}:0:${i * (SLICE_H + bezel)}[s${i + 1}]`)
      .join(';');

  const args = ['-hide_banner', '-nostdin', '-y', '-i', input, '-filter_complex', chain];
  outputs.forEach((out, i) => args.push('-map', `[s${i + 1}]`, ...ENC, out));

  return run(FFMPEG, args);
}

// `-count_packets` broji pakete u kontejneru umjesto da dekodira cijeli fajl —
// za naše izlaze je to broj frejmova, a traje sekundu umjesto minute.
async function countPackets(file) {
  const out = await run(FFPROBE, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_packets',
    '-show_entries', 'stream=nb_read_packets',
    '-of', 'csv=p=0',
    file,
  ]);

  const frames = parseInt(String(out).trim(), 10);
  if (!isFinite(frames)) throw new Error('ffprobe nije vratio broj frejmova.');
  return frames;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(spawnError(err, bin));
      return;
    }

    let out = '';
    let tail = '';
    let killed = false;

    child.stdout.on('data', (chunk) => { out = (out + chunk).slice(-4000); });
    child.stderr.on('data', (chunk) => { tail = (tail + chunk).slice(-4000); });

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(spawnError(err, bin));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`${path.basename(bin)} nije završio za ${TIMEOUT_MS / 60000} minuta i prekinut je.`));
      } else if (code !== 0) {
        reject(new Error(`${path.basename(bin)} je vratio grešku: ${lastLine(tail) || 'kod ' + code}`));
      } else {
        resolve(out);
      }
    });
  });
}

function spawnError(err, bin) {
  if (err && err.code === 'ENOENT') return new Error(`${path.basename(bin)} nije instaliran na serveru.`);
  return err instanceof Error ? err : new Error(String(err));
}

function lastLine(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : '';
}
