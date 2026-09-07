// Čitanje MP4 kontejnera bez ffmpega: trajanje, dimenzije i kodek.
// Čitaju se samo zaglavlja boxova, nikad cijeli fajl — video od 200 MB se
// pregleda sa nekoliko desetina pročitanih bajta.
//
// Zašto uopšte: ffmpeg ne mora biti instaliran, a bez trajanja se ne može
// izračunati ciklus plejliste, niti provjeriti odnos stranica.
import fs from 'node:fs';

// Telefon snima portret kao 1920 × 1080 sa matricom rotacije od 90°. Browser
// prikaže 1080 × 1920. Ako se čitaju sirove dimenzije, portret video izgleda
// kao pejzaž i bude odbijen bez razloga — zato se matrica mora pogledati.
function isRotated(matrix) {
  const a = Math.abs(matrix.a);
  const d = Math.abs(matrix.d);
  const b = Math.abs(matrix.b);
  const c = Math.abs(matrix.c);
  return a < 0.01 && d < 0.01 && b > 0.01 && c > 0.01;
}

function readBoxes(fd, start, end, onBox) {
  const header = Buffer.alloc(16);
  let offset = start;

  while (offset + 8 <= end) {
    const got = fs.readSync(fd, header, 0, 16, offset);
    if (got < 8) return;

    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let headerSize = 8;

    if (size === 1) {
      if (got < 16) return;
      size = Number(header.readBigUInt64BE(8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset; // box se proteže do kraja
    }

    if (size < headerSize) return;
    if (offset + size > end) size = end - offset; // krnj posljednji box

    if (onBox(type, offset + headerSize, offset + size) === false) return;
    offset += size;
  }
}

function payload(fd, start, end, max) {
  const length = Math.max(0, Math.min(end - start, max));
  const buf = Buffer.alloc(length);
  if (length) fs.readSync(fd, buf, 0, length, start);
  return buf;
}

function parseTkhd(fd, start, end) {
  const b = payload(fd, start, end, 96);
  if (b.length < 84) return null;

  const version = b[0];
  const trackId = version === 1 ? b.readUInt32BE(20) : b.readUInt32BE(12);
  const matrixAt = version === 1 ? 52 : 40;
  if (b.length < matrixAt + 44) return null;

  const fixed = (offset) => b.readInt32BE(offset) / 65536;
  const matrix = {
    a: fixed(matrixAt),
    b: fixed(matrixAt + 4),
    c: fixed(matrixAt + 12),
    d: fixed(matrixAt + 16),
  };

  let width = b.readUInt32BE(matrixAt + 36) / 65536;
  let height = b.readUInt32BE(matrixAt + 40) / 65536;

  if (isRotated(matrix)) {
    const swap = width;
    width = height;
    height = swap;
  }

  return { trackId, width: Math.round(width), height: Math.round(height), rotated: isRotated(matrix) };
}

function parseTrack(fd, start, end) {
  const track = {
    handler: null,
    trackId: null,
    width: 0,
    height: 0,
    codec: null,
    rotated: false,
    mediaTimescale: 0,
    mediaDuration: 0,
  };

  readBoxes(fd, start, end, (type, s, e) => {
    if (type === 'tkhd') {
      const tkhd = parseTkhd(fd, s, e);
      if (tkhd) Object.assign(track, tkhd);
    } else if (type === 'mdia') {
      readBoxes(fd, s, e, (mdiaType, ms, me) => {
        if (mdiaType === 'hdlr') {
          const b = payload(fd, ms, me, 16);
          if (b.length >= 12) track.handler = b.toString('latin1', 8, 12);
        } else if (mdiaType === 'mdhd') {
          const b = payload(fd, ms, me, 32);
          if (b.length < 20) return;
          const version = b[0];
          track.mediaTimescale = version === 1 ? b.readUInt32BE(20) : b.readUInt32BE(12);
          track.mediaDuration = version === 1 ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16);
        } else if (mdiaType === 'minf') {
          readBoxes(fd, ms, me, (minfType, is, ie) => {
            if (minfType !== 'stbl') return;
            readBoxes(fd, is, ie, (stblType, ss, se) => {
              if (stblType !== 'stsd') return;
              const b = payload(fd, ss, se, 16);
              if (b.length >= 16) track.codec = b.toString('latin1', 12, 16);
            });
          });
        }
      });
    }
  });

  return track;
}

// Fragmentirani MP4 (moof + mdat, ono što daju browserski snimači i dio
// kamera) nosi trajanje 0 u mvhd — pravo trajanje se sabira iz fragmenata.
// Čitaju se samo trun zaglavlja; mdat se preskače po veličini.
function sumFragments(fd, size, trackId, trexDefaultDuration) {
  let total = 0;

  readBoxes(fd, 0, size, (type, moofStart, moofEnd) => {
    if (type !== 'moof') return;

    readBoxes(fd, moofStart, moofEnd, (moofType, trafStart, trafEnd) => {
      if (moofType !== 'traf') return;

      let thisTrack = null;
      let defaultDuration = trexDefaultDuration;
      let trafTotal = 0;

      readBoxes(fd, trafStart, trafEnd, (trafType, s, e) => {
        if (trafType === 'tfhd') {
          const b = payload(fd, s, e, 32);
          if (b.length < 8) return;
          const flags = b.readUIntBE(1, 3);
          thisTrack = b.readUInt32BE(4);
          let at = 8;
          if (flags & 0x000001) at += 8; // base-data-offset
          if (flags & 0x000002) at += 4; // sample-description-index
          if (flags & 0x000008 && b.length >= at + 4) defaultDuration = b.readUInt32BE(at);
        } else if (trafType === 'trun') {
          const b = payload(fd, s, e, 256 * 1024);
          if (b.length < 8) return;
          const flags = b.readUIntBE(1, 3);
          const count = b.readUInt32BE(4);
          let at = 8;
          if (flags & 0x000001) at += 4; // data-offset
          if (flags & 0x000004) at += 4; // first-sample-flags

          if (!(flags & 0x000100)) {
            trafTotal += count * (defaultDuration || 0);
            return;
          }

          const stride =
            4 +
            (flags & 0x000200 ? 4 : 0) +
            (flags & 0x000400 ? 4 : 0) +
            (flags & 0x000800 ? 4 : 0);

          for (let i = 0; i < count; i++) {
            const offset = at + i * stride;
            if (offset + 4 > b.length) break;
            trafTotal += b.readUInt32BE(offset);
          }
        }
      });

      if (thisTrack === null || thisTrack === trackId) total += trafTotal;
    });
  });

  return total;
}

export function probeMp4(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return { ok: false, reason: 'Fajl se ne može otvoriti.' };
  }

  try {
    const size = fs.fstatSync(fd).size;

    let brand = null;
    let moov = null;
    readBoxes(fd, 0, size, (type, s, e) => {
      if (type === 'ftyp') {
        const b = payload(fd, s, e, 8);
        if (b.length >= 4) brand = b.toString('latin1', 0, 4);
      } else if (type === 'moov') {
        moov = [s, e];
        return false;
      }
    });

    if (!moov) return { ok: false, reason: 'Nije nađen moov box — fajl nije ispravan MP4.' };

    let movieTimescale = 0;
    let movieDuration = 0;
    let fragmentDuration = 0;
    let trexDefaultDuration = 0;
    let fragmented = false;
    let video = null;

    readBoxes(fd, moov[0], moov[1], (type, s, e) => {
      if (type === 'mvhd') {
        const b = payload(fd, s, e, 32);
        if (b.length < 20) return;
        const version = b[0];
        movieTimescale = version === 1 ? b.readUInt32BE(20) : b.readUInt32BE(12);
        movieDuration = version === 1 ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16);
      } else if (type === 'mvex') {
        // mvex znači fragmentiran fajl: trajanja u init segmentu nisu mjerodavna.
        fragmented = true;
        readBoxes(fd, s, e, (mvexType, ms, me) => {
          const b = payload(fd, ms, me, 32);
          if (mvexType === 'mehd' && b.length >= 12) {
            fragmentDuration = b[0] === 1 ? Number(b.readBigUInt64BE(4)) : b.readUInt32BE(4);
          } else if (mvexType === 'trex' && b.length >= 20) {
            trexDefaultDuration = b.readUInt32BE(16);
          }
        });
      } else if (type === 'trak') {
        const track = parseTrack(fd, s, e);
        if (track.handler === 'vide' && !video) video = track;
      }
    });

    if (!video) return { ok: false, reason: 'Fajl nema video zapis.' };
    if (!video.width || !video.height) return { ok: false, reason: 'Dimenzije videa se ne mogu pročitati.' };

    // Kod fragmentiranog fajla mvhd i mdhd opisuju samo init segment — znaju
    // pokazati djelić stvarnog trajanja, pa se prvo gleda mehd, pa zbir
    // fragmenata. Kod običnog MP4 vrijedi obrnuto.
    const sources = fragmented
      ? ['mehd', 'fragmenti', 'mvhd', 'mdhd']
      : ['mvhd', 'mdhd', 'mehd', 'fragmenti'];

    let durationS = null;
    let source = null;

    for (const candidate of sources) {
      let value = null;

      if (candidate === 'mvhd' && movieTimescale > 0 && movieDuration > 0) {
        value = movieDuration / movieTimescale;
      } else if (candidate === 'mehd' && movieTimescale > 0 && fragmentDuration > 0) {
        value = fragmentDuration / movieTimescale;
      } else if (candidate === 'mdhd' && video.mediaTimescale > 0 && video.mediaDuration > 0) {
        value = video.mediaDuration / video.mediaTimescale;
      } else if (candidate === 'fragmenti' && video.mediaTimescale > 0) {
        const ticks = sumFragments(fd, size, video.trackId, trexDefaultDuration);
        if (ticks > 0) value = ticks / video.mediaTimescale;
      }

      if (value && isFinite(value)) {
        durationS = value;
        source = candidate;
        break;
      }
    }

    if (!durationS || !isFinite(durationS)) {
      return { ok: false, reason: 'Trajanje videa se ne može pročitati.' };
    }

    return {
      ok: true,
      brand,
      durationS,
      durationSource: source,
      width: video.width,
      height: video.height,
      codec: video.codec,
      rotated: video.rotated,
    };
  } catch (err) {
    return { ok: false, reason: 'Greška pri čitanju kontejnera: ' + err.message };
  } finally {
    fs.closeSync(fd);
  }
}
