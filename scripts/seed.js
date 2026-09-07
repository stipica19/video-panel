// Generiše testne mastere za zid i puni bazu, da se lokalno ima šta vrtiti.
// Dimenzije: SEED_W × SEED_H (podrazumijevano 1920 × 3336, "rezervni" master).
// Za punu oštrinu: SEED_W=3840 SEED_H=6672 npm run seed
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { db, MEDIA_DIR, THUMB_DIR } from '../server/db.js';
import { publish } from '../server/playlist.js';

const W = Number(process.env.SEED_W || 1920);
const H = Number(process.env.SEED_H || 3336);

const PALETTE = [
  { name: 'ponoc', top: '#0b1d3a', bottom: '#123f6d', accent: '#4fc3f7' },
  { name: 'zalazak', top: '#3a1006', bottom: '#8c3312', accent: '#ffb74d' },
  { name: 'sumrak', top: '#1a0b2e', bottom: '#4a1e6b', accent: '#ce93d8' },
  { name: 'sipa', top: '#06251d', bottom: '#0f5a45', accent: '#69f0ae' },
];

// Slika nosi lenjir i dijagonalu preko cijele visine — svaki raskorak između
// panela se odmah vidi.
function testSvg(index, colors) {
  const rulerStep = Math.round(H / 24);
  let ruler = '';
  for (let y = 0; y < H; y += rulerStep) {
    const major = (y / rulerStep) % 4 === 0;
    ruler += `<rect x="0" y="${y}" width="${major ? 120 : 60}" height="${major ? 6 : 3}" fill="${colors.accent}" opacity="0.85"/>`;
    if (major) {
      ruler += `<text x="140" y="${y + 34}" font-family="sans-serif" font-size="36" fill="${colors.accent}" opacity="0.8">${y}</text>`;
    }
  }

  const circles = [0.18, 0.42, 0.66, 0.88].map((f, i) => {
    const r = Math.round(W * (0.16 + i * 0.05));
    return `<circle cx="${Math.round(W * (i % 2 ? 0.75 : 0.3))}" cy="${Math.round(H * f)}" r="${r}"
      fill="none" stroke="${colors.accent}" stroke-width="${Math.round(W / 240)}" opacity="0.35"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0%" stop-color="${colors.top}"/>
        <stop offset="100%" stop-color="${colors.bottom}"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    ${circles}
    <line x1="0" y1="0" x2="${W}" y2="${H}" stroke="${colors.accent}" stroke-width="${Math.round(W / 320)}" opacity="0.55"/>
    <line x1="${W}" y1="0" x2="0" y2="${H}" stroke="#ffffff" stroke-width="${Math.round(W / 480)}" opacity="0.25"/>
    <rect x="${Math.round(W / 2 - W / 400)}" y="0" width="${Math.round(W / 200)}" height="${H}" fill="#ffffff" opacity="0.4"/>
    ${ruler}
    <text x="${Math.round(W / 2)}" y="${Math.round(H * 0.5)}" text-anchor="middle"
      font-family="sans-serif" font-size="${Math.round(W / 5)}" font-weight="bold"
      fill="#ffffff" opacity="0.9">${index}</text>
    <text x="${Math.round(W / 2)}" y="${Math.round(H * 0.5 + W / 8)}" text-anchor="middle"
      font-family="sans-serif" font-size="${Math.round(W / 22)}" fill="#ffffff" opacity="0.7">${colors.name}</text>
  </svg>`;
}

function thumbName(file) {
  return file.replace(/\.[^.]+$/, '') + '.webp';
}

async function addAsset(buf, displayName) {
  const meta = await sharp(buf).metadata();
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 6);
  const file = `${displayName}-${hash}.jpg`;

  fs.writeFileSync(path.join(MEDIA_DIR, file), buf);
  await sharp(buf).resize({ width: 180 }).webp({ quality: 78 }).toFile(path.join(THUMB_DIR, thumbName(file)));

  const existing = db.prepare('SELECT id FROM assets WHERE file = ?').get(file);
  if (existing) return existing.id;

  const id = 'ast_' + crypto.randomBytes(5).toString('hex');
  db.prepare('INSERT INTO assets (id, name, file, width, height, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, displayName + '.jpg', file, meta.width, meta.height, buf.length, Date.now());
  return id;
}

const MOTIONS = [
  { kind: 'kenburns', scaleFrom: 1.0, scaleTo: 1.06, panY: -1.5 },
  { kind: 'driftY', panY: -2.5 },
  { kind: 'kenburns', scaleFrom: 1.05, scaleTo: 1.0, panY: 1.2 },
  { kind: 'none' },
];

console.log(`Generišem testne mastere ${W} × ${H}…`);

const assetIds = [];
for (let i = 0; i < PALETTE.length; i++) {
  const svg = testSvg(i + 1, PALETTE[i]);
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  const id = await addAsset(buf, `test-${i + 1}-${PALETTE[i].name}`);
  assetIds.push(id);
  console.log(`  test-${i + 1}-${PALETTE[i].name}  ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
}

db.transaction(() => {
  db.prepare('DELETE FROM items').run();
  const stmt = db.prepare('INSERT INTO items (id, asset_id, position, duration, motion, enabled) VALUES (?, ?, ?, ?, ?, ?)');
  assetIds.forEach((assetId, index) => {
    stmt.run('itm_' + crypto.randomBytes(5).toString('hex'), assetId, index, 8, JSON.stringify(MOTIONS[index % MOTIONS.length]), 1);
  });
})();

// Slika za M0 smoke test — puna 4K rezolucija zida, 25.6 MP.
const m0Path = path.join(MEDIA_DIR, 'm0-test.jpg');
if (!fs.existsSync(m0Path)) {
  console.log('Generišem m0-test.jpg 3840 × 6672 (može potrajati)…');
  const svg = testSvg('M0', PALETTE[0]).replace(`width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"`,
    `width="3840" height="6672" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"`);
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  fs.writeFileSync(m0Path, buf);
  console.log(`  m0-test.jpg  ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
}

const result = publish(0);
console.log(`\nObjavljeno: verzija ${result.version}, ${result.count} stavki, aktivno odmah.`);
console.log(`Otvori http://localhost:${process.env.PORT || 4000}/admin/`);
