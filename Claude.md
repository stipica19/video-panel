# CLAUDE.md — Video Wall Controller

## Šta gradimo

Sistem za upravljanje video zidom od **tri Samsung QM55C panela složena vertikalno** (jedan ispod drugog). Panели prikazuju jednu neprekidnu sliku koja se proteže preko cijele visine zida.

Svaki panel se u sadržaj uključuje **isključivo preko svog ugrađenog browsera** (Samsung URL Launcher), koji po podizanju sam otvara zadatu adresu. Nema playera, nema mini PC-a, nema HDMI kablova između uređaja. Sve ide preko mreže sa VPS-a.

Ovo je sistem za **jedan zid, jednog korisnika**. Nije SaaS, nije multi-tenant.

---

## Ne gradimo (eksplicitno izvan opsega)

Ove stvari se ne implementiraju bez izričitog zahtjeva. Ako se pojavi iskušenje da se dodaju — nemoj:

- više zidova, više organizacija, korisničke role
- integracije (vrijeme, RSS, društvene mreže, Google Slides)
- šabloni, editor sadržaja, dizajner u browseru
- analitika, proof-of-play, izvještaji
- touch/kiosk interakcija
- **video** — vidi "Faza 2" na dnu. V1 je samo slike.

---

## Arhitektura

Tri odvojene stvari koje se **ne smiju miješati**:

```
┌─────────────────────────────────────────────────┐
│ VPS                                             │
│                                                 │
│  Fastify ── SQLite                              │
│     ├── /time            (izvor vremena)        │
│     ├── /api/*           (admin API, auth)      │
│     ├── /player          (statični HTML)        │
│     ├── /admin           (build iz Vite)        │
│     └── /media/*         (statični fajlovi)     │
└─────────────────────────────────────────────────┘
        │                          │
        │ HTTPS                    │ HTTPS
   ┌────┴────┐              ┌──────┴──────┐
   │ 3 panela│              │ admin u     │
   │ (Tizen) │              │ browseru    │
   └─────────┘              └─────────────┘
```

**Player i admin nemaju zajednički kod, zajednički build, ni zajedničke zavisnosti.** To je namjerno i nije predmet refaktorisanja.

---

## Stack

### Backend

- **Node 22 + Fastify**
- **better-sqlite3** — sinhroni SQLite, bez ORM-a. Podataka ima manje od 100 redova.
- `@fastify/static`, `@fastify/multipart`, `@fastify/basic-auth`
- **Bez Redisa, bez BullMQ, bez Postgresa.** Ako se pojavi potreba za redom poslova, to je tabela u SQLite-u i jedan `setInterval`.
- Migracije: jedan `schema.sql` koji se izvrši pri startu (`CREATE TABLE IF NOT EXISTS`).

### Admin frontend

- **Vite + React + TypeScript**
- **TanStack Query** — cijeli admin je polling (status panela, napredak objave). Query rješava refetch intervale i invalidaciju.
- **Bez routera** ili `wouter` ako baš zatreba. Ima 3-4 ekrana.
- **Bez Next.js.** SSR ne treba (sve je iza logina), a drugi Node proces na VPS-u je čist teret.
- Build daje statične fajlove koje servira Fastify. Jedan proces, jedan systemd unit.

### Player

- **Jedan `.html` fajl. Bez builda. Bez frameworka. Bez npm zavisnosti.**
- Vanilla JS, ciljaj **ES2017**. Bez modula, bez `import`.
- Izvršava ga Chromium nepoznate starosti na televizoru koji neće javiti šta ne valja. Što je fajl gluplji, to bolje spava.

---

## Hardver

**3 × Samsung QM55C, model kod `LH55QMCEBGCXEN`**, složeni vertikalno.

|                    |                                                |
| ------------------ | ---------------------------------------------- |
| Nativna rezolucija | 3840 × 2160 (4K UHD)                           |
| Panel              | VA, 500 nita, 4000:1, 24/7                     |
| Vanjske dimenzije  | 1237.9 × 708.8 × 28.5 mm                       |
| Okvir              | 11.5 mm, jednak sa sve četiri strane           |
| Aktivna površina   | 1209.6 × 680.4 mm (55" 16:9)                   |
| OS                 | Tizen 7.0, 16 GB internog flasha               |
| Ulazi              | 3 × HDMI 2.0, 1 × DP 1.2, RJ-45, WiFi, RS-232C |

Nema DP/HDMI loop-out izlaza — daisy chain nije opcija ni da smo htjeli. Sve ide preko mreže.

---

## Geometrija zida

Ovo je srce sistema. Pogrešna matematika ovdje = vidljivo prelomljena slika.

### Fizički razmak

```
Vanjska visina panela:   708.8 mm
Aktivna visina:          680.4 mm
Neaktivni rub po strani: (708.8 - 680.4) / 2 = 14.2 mm
```

**Napomena:** deklarisanih 11.5 mm je _vidljivi_ crni okvir. Za našu matematiku bitno je rastojanje od ivice kućišta do aktivnih piksela, a to je 14.2 mm.

```
GAP_MM = 14.2 (donji rub gornjeg panela)
       + 14.2 (gornji rub donjeg panela)
       + montažni razmak između kućišta   ← IZMJERITI, obično 1–3 mm
       ≈ 30 mm
```

### Konverzija u piksele — zavisi od viewporta

**Ovo se mora izmjeriti u M0.** Tizen browser na 4K panelu može prijaviti viewport od 1920 CSS px (uz `devicePixelRatio = 2`) ili punih 3840. Od toga zavisi sve ostalo.

| Viewport           | px/mm                     | GAP_PX (30 mm) | WALL_H                       |
| ------------------ | ------------------------- | -------------- | ---------------------------- |
| 1920 × 1080 CSS px | 1080 / 680.4 = **1.5873** | **48**         | 3 × 1080 + 2 × 48 = **3336** |
| 3840 × 2160        | 2160 / 680.4 = **3.1747** | **96**         | 3 × 2160 + 2 × 96 = **6672** |

```
WALL_W  = širina viewporta
WALL_H  = 3 × visina_panela + 2 × BEZEL_PX

Pomak za panel n (n = 1, 2, 3):
   offsetY = -(n - 1) × (visina_panela + BEZEL_PX)
```

Player **računa ovo iz izmjerenog `clientHeight`**, ne iz konstanti. Konstante iz tabele su samo početna vrijednost za kalibraciju.

**BEZEL_PX mora biti paran.** Ako se ikad bude sjeklo ffmpegom, `yuv420p` ima poduzorkovanu hromu i neparan `y` offset tiho pomjera boju.

**BEZEL_PX je podešavanje u bazi, ne konstanta u kodu.** Nikad se ne pogodi iz prve — 30 mm je procjena koja zavisi od nosača.

### Dimenzije mastera

Panel je 4K, pa za punu oštrinu master mora biti:

```
3840 × 6672 px      ← puna oštrina (~25.6 MP, JPEG q85 ≈ 8–15 MB)
1920 × 3336 px      ← rezerva ako Tizen ne izdrži dekodiranje 25 MP
```

Odnos stranica je otprilike **16:27.8** — visok i uzak, blizu vertikalnog snimka sa telefona.

Kreni sa 3840 × 6672 i **testiraj u M0**. Ako dekodiranje ili Ken Burns transform trzaju, spusti na 1920 × 3336 — na 1920 CSS px viewportu razlika je ionako mala.

Player koristi `object-fit: cover`, pa manja odstupanja u `BEZEL_PX` samo odsijeku par piksela umjesto da razvuku sliku.

### Kalibraciona stranica

Napravi `/kalibracija?displej=N`. Prikazuje testni uzorak: debele horizontalne linije na poznatim razmacima i vertikalnu liniju kroz cijelu visinu zida. Vrijednost `BEZEL_PX` se mijenja preko `?bezel=` parametra bez ponovnog deploya.

Postupak: otvori na sva tri panela, mijenjaj broj dok vertikalna linija ne izgleda neprekinuto, upiši rezultat u settings.

---

## Player — kako radi

### URL

```
https://zid.domen.com/player?displej=1     ← gornji panel
https://zid.domen.com/player?displej=2     ← srednji
https://zid.domen.com/player?displej=3     ← donji
```

Opcioni `&hud=1` prikazuje dijagnostiku u uglu (drift, offset sata, trenutna stavka, greške).

### DOM struktura

Dva ugniježđena elementa — vanjski nosi pomak panela, unutrašnji animaciju. Ne kombinuj ih u jedan `transform`.

```html
<div class="viewport">
  <!-- overflow: hidden, fiksno na cijeli ekran -->
  <div class="wall">
    <!-- translateY(offsetY), visina WALL_H -->
    <div class="motion">
      <!-- Ken Burns transform -->
      <img class="slide" />
      <!-- object-fit: cover -->
    </div>
  </div>
</div>
```

Pomak radi `transform: translateY()`, **ne** `top`. Transform ide preko GPU kompozitora i ne izaziva ponovni layout — na TV browserima je primjetno stabilniji.

Visinu računaj iz `clientHeight` fiksiranog kontejnera, **ne** iz `vh`. `vh` zna biti nepouzdan na Tizenu.

### Sinhronizacija sata

Server ne šalje komande. Server je samo izvor vremena. Svaki panel nezavisno računa gdje bi trebao biti.

```
pozicija_u_ciklusu = (serverNow() - epoch) mod trajanje_ciklusa
```

Sva tri dobiju isti broj jer imaju isti sat. Ako se jedan panel resetuje u 3 ujutro, po podizanju se sam uklopi.

**Mjerenje offseta (NTP princip preko HTTP-a):**

```
t0 = lokalno vrijeme prije zahtjeva
ts = vrijeme koje je server upisao
t1 = lokalno vrijeme kad je odgovor stigao

offset = ts + (t1 - t0)/2 - t1
```

Pošalji **7 zahtjeva zaredom, zadrži samo onaj sa najmanjim RTT-om.** Najbrži prolaz je najmanje asimetričan; ostale baci. Resinhronizuj svakih 60 s.

**KRITIČNO:** `Date.now()` na Tizenu može **skočiti** — televizor povremeno sam sinhronizuje svoj sat. Zato:

- `Date.now()` se koristi **samo** u trenutku mjerenja offseta
- protok vremena između mjerenja mjeri se sa `performance.now()`, koji je monoton i ne skače
- `serverNow()` se izvodi iz sidra (`Date.now()` + `performance.now()` u trenutku sinhronizacije) plus proteklo monotono vrijeme

Ako se ovo pogriješi, zid odleti u nasumičnim trenucima i uzrok se neće naći danima.

### Učitavanje sadržaja

Sve slike se pri startu preuzimaju preko `fetch` → `blob` → `URL.createObjectURL` i drže **u memoriji**.

Razlog: nakon toga reprodukcija ne zavisi od mreže. Ako VPS padne ili internet pukne, zid nastavi da radi. Tizen ima malo prostora za keš i ne smije se na njega oslanjati.

Dok traje preuzimanje, prikaži crn ekran sa diskretnim tekstom o napretku. Nikad bijeli ekran.

### Prelazi između stavki

Prelaz **ne** prepuštaj petlji koja se vrti svakih 200 ms. Ako tri panela sijeku u razmaku od 100 ms, to se vidi kao raspad zida.

Izračunaj tačan trenutak prelaza u odnosu na serversko vrijeme i zakaži ga:

```js
setTimeout(prebaci, sljedeciPrelaz - serverNow());
```

Sljedeću sliku drži već učitanu u drugom sloju. Prelaz je `opacity` fade od 400 ms — on usput proguta i eventualnu razliku od par desetina milisekundi između panela.

### Pokret (Ken Burns)

Statična slika na zidu od dva metra gleda se tri sekunde. Svaka stavka ima definisan pokret.

Progres animacije se **računa iz serverskog vremena**, ne iz CSS animacije ni `requestAnimationFrame` brojača:

```js
p = offset_u_stavci / trajanje_stavke; // 0 → 1
```

Pa se `transform` postavlja direktno. Tako su sva tri panela u istoj fazi po definiciji — čista matematika, nema dekodera koji može zaostati.

Tipovi pokreta: `none`, `kenburns` (scale 1.0 → 1.06 uz blagi pomak), `driftY` (sporo vertikalno klizanje).

Ažuriraj u `requestAnimationFrame` petlji, ali vrijednost uvijek računaj iz `serverNow()`.

---

## Protokol objave

`GET /api/playlist.json` vraća:

```json
{
  "current": {
    "version": "8f3a1c",
    "epoch": 1757160000000,
    "items": [
      {
        "id": "itm_01",
        "type": "image",
        "file": "/media/promo-8f3a1c.jpg",
        "duration": 8,
        "motion": { "kind": "kenburns", "scaleFrom": 1.0, "scaleTo": 1.06, "panY": -1.5 }
      }
    ]
  },
  "next": {
    "version": "b21e77",
    "activeFrom": 1757160300000,
    "epoch": 1757160300000,
    "items": [ ... ]
  }
}
```

**Dvofazna objava.** Ako samo prepišeš fajlove i podigneš verziju, tri panela se reloaduju u razmaku od nekoliko sekundi i zid se raspadne na 10-20 s pri svakoj promjeni.

Umjesto toga:

1. Admin objavljuje → server postavlja `next` sa `activeFrom = sada + 90 s`
2. Panel vidi `next`, preuzima nove slike **u pozadini** dok i dalje prikazuje `current`
3. Kad panel završi preuzimanje, javi `ready: "b21e77"` u heartbeatu
4. Na `activeFrom` **svi panели istovremeno** prebacuju `next` → `current`. Bez reloada stranice.
5. Server nakon `activeFrom` promoviše `next` u `current` u odgovoru

`epoch` nove plejliste = `activeFrom`. Tako novi ciklus kreće od stavke 0, predvidljivo.

**Imena fajlova nose heš sadržaja** (`promo-8f3a1c.jpg`). Nikad ne prepisuj fajl istim imenom — browser keš i djelimično preuzeti fajlovi rade o glavi na načine koje je bolno debug-ovati.

Objava je atomična: upiši u `tmp/`, provjeri, premjesti, tek onda podigni verziju.

---

## Heartbeat i komande

`POST /api/heartbeat` svakih 30 s, sa deljenim tokenom u zaglavlju:

```json
{
  "displej": 2,
  "version": "8f3a1c",
  "ready": "b21e77",
  "itemId": "itm_01",
  "clockOffsetMs": -12.4,
  "uptimeS": 84213,
  "error": null
}
```

Odgovor može nositi komandu — to je jedini kanal ka panelima, **bez WebSocketa**:

```json
{ "command": "reload" }
```

Komande: `reload`, `resync`, `none`.

Admin prikazuje panel kao **offline ako nije javio 90 s**.

---

## Baza

```sql
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file TEXT NOT NULL,          -- ime na disku, sa hešom
  width INTEGER, height INTEGER, bytes INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  position INTEGER NOT NULL,
  duration REAL NOT NULL DEFAULT 8,
  motion TEXT NOT NULL DEFAULT '{"kind":"kenburns"}',
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- bezel_px, current_version, current_epoch, next_version, next_active_from

CREATE TABLE IF NOT EXISTS publications (
  version TEXT PRIMARY KEY,
  payload TEXT NOT NULL,       -- zamrznuti JSON items
  active_from INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS screens (
  n INTEGER PRIMARY KEY,       -- 1, 2, 3
  last_seen INTEGER,
  version TEXT, ready TEXT, item_id TEXT,
  clock_offset_ms REAL, uptime_s INTEGER,
  error TEXT, pending_command TEXT
);
```

---

## API

| Metoda  | Ruta                      | Auth  | Napomena                          |
| ------- | ------------------------- | ----- | --------------------------------- |
| GET     | `/time`                   | ne    | vraća `Date.now()` kao plain text |
| GET     | `/api/playlist.json`      | ne    | `Cache-Control: no-store`         |
| POST    | `/api/heartbeat`          | token |                                   |
| GET     | `/api/assets`             | basic |                                   |
| POST    | `/api/assets`             | basic | multipart, validacija             |
| DELETE  | `/api/assets/:id`         | basic |                                   |
| GET/PUT | `/api/items`              | basic | redoslijed, trajanja, pokret      |
| POST    | `/api/publish`            | basic | postavlja `next`                  |
| GET     | `/api/screens`            | basic |                                   |
| GET/PUT | `/api/settings`           | basic |                                   |
| POST    | `/api/screens/:n/command` | basic | postavlja `pending_command`       |

**Validacija uploada je obavezna.** Provjeri MIME i stvarne dimenzije (`sharp`), odbaci sve što nije blizu odnosa 1920×3320, ograniči veličinu na 20 MB. Endpoint koji prima proizvoljne fajlove sa javnog VPS-a je poznata površina za napad.

Basic auth pred cijelim `/admin` i `/api/*`. VPS je javan.

---

## Admin UI

Četiri ekrana, ništa više:

**Biblioteka** — grid sa thumbnailima, upload drag & drop, brisanje. Prikaži dimenzije i upozori ako odnos nije blizu 16:27.

**Plejlista** — drag & drop redoslijed, trajanje po stavci, izbor pokreta, prekidač uključeno/isključeno. Dugme **Objavi** koje pokazuje odbrojavanje do `activeFrom`.

**Pregled zida** — tri isječka složena vertikalno u browseru sa simuliranim razmakom za okvire. Jeftino za napraviti, spašava od "izgledalo je dobro na laptopu".

**Stanje panela** — po jedna kartica za svaki: online/offline, koju verziju vrti, koju stavku, offset sata, uptime. Dugme za reload. **Ovo je ekran koji se gleda svaki dan.**

Copy piši na našem jeziku, sentence case, bez ALL CAPS labela.

---

## Deploy

- nginx kao reverse proxy, Let's Encrypt sertifikat. **Tizen ume da odbije self-signed sertifikat** — mora biti validan.
- Jedan systemd unit za Fastify.
- `/media/` servira nginx direktno, `Cache-Control: public, max-age=2592000, immutable`.
- `/time` i `/api/playlist.json`: `no-store`.
- Deploy: `git pull && npm ci && npm run build && systemctl restart videowall`.

---

## Zamke na Tizenu

Ovo su stvari koje su nas već koštale ili hoće:

- **`Date.now()` skače.** Vidi sekciju o satu. Ovo je zamka broj jedan.
- **Tizen 7.0** — Chromium engine, ali tačna verzija zavisi od firmvera. Cilj je ES2017; potvrdi `userAgent` u M0 prije nego što odlučiš smiješ li koristiti novije (`?.`, `??`, `:has()`).
- Panel ima **16 GB flasha**, ali se na browser keš i dalje ne oslanjamo — sve ide u memoriju preko blob URL-ova.
- **Nema `localStorage` oslanjanja.** Ne pretpostavljaj da išta preživi restart.
- **Isključi "Seamless Video Playback"** u meniju panela — poznato je da izaziva greške u slici.
- **Isključi screensaver i auto power off** u meniju panela.
- `cursor: none` na `body`.
- **Zakaži reload stranice u 04:00** svaki dan. Rješava nagomilanu memoriju prije nego što postane problem.
- Reload izvodi **samo** ako je `fetch` ka serveru uspio — inače panel koji je izgubio mrežu ostane na bijelom ekranu.
- Svaka neuhvaćena greška u playeru → crn ekran sa porukom + automatski reload za 15 s. Nikad bijeli ekran, nikad JS dijalog.

---

## Redoslijed rada

**M0 — smoke test. Prije ijedne linije backenda.**

Statična dijagnostička stranica na VPS-u, otvorena preko URL Launchera na **jednom** panelu. Ispisuje krupnim slovima na ekranu:

```js
window.innerWidth + " × " + window.innerHeight;
window.devicePixelRatio;
screen.width + " × " + screen.height;
navigator.userAgent;
CSS.supports("object-fit", "cover");
typeof performance.now;
```

**`innerWidth` je najvažniji broj u cijelom projektu** — od njega zavisi `BEZEL_PX`, `WALL_H` i dimenzije mastera. Upiši ga u ovaj dokument čim ga izmjeriš.

Na istoj stranici: jedna slika 3840×6672 sa `transform: translateY()` i laganim `scale`. Provjeriti da li se pokreće sama po podizanju panela, ima li browser chrome, radi li transform glatko, i izdrži li dekodiranje slike od 25 MP.

_Ako ovo ne prođe, cijela arhitektura pada i bolje je to znati prvog dana._

**M1** — player sa sinhronizacijom sata, `playlist.json` napisan ručno. Testirati na sva tri panela.

**M2** — kalibraciona stranica, izmjeriti `BEZEL_PX`.

**M3** — Fastify + SQLite + upload + `playlist.json` iz baze.

**M4** — admin UI.

**M5** — dvofazna objava + heartbeat + stanje panela.

Ne kreni na M3 dok M1 ne radi stabilno nekoliko sati bez ijednog vidljivog raskoraka.

---

## Faza 2 — video

**Stanje: urađena opcija B.** Opcija A je bila napisana i radila je na stolu, ali na pravom
panelu (QM55C, Tizen) video je davao crn ekran bez ijedne greške — hardverski dekoder ne pušta
kadar viši od ~2160 px, a zid je 3336. Slike prolaze jer ne idu kroz taj dekoder, i isti fajl
uredno radi na Fire TV Sticku, pa se problem ne vidi dok se ne proba na panelu. Zato server sad
reže video na tri dijela od 1920 × 1080 (`server/slicer.js`), a panel dobija samo svoj.

Uz to su pale još dvije Tizen zamke: video se pušta sa URL-a a ne iz blob-a, i na samom
`<video>` nema ni transforma ni opacityja — video ide u zasebnu hardversku ravninu. Detalji su u
sekciji „Video” u `README.md`.

Ispod stoji originalno razmišljanje od prije odluke.

Postojeći materijal je snimljen telefonom i amaterski montiran. Na zidu visokom dva metra to bi izgledalo loše bez obzira koliko dobro radi sinhronizacija — trostruko uvećanje već dvaput komprimovanog materijala, plus drhtanje ruke koje postaje ljuljanje od nekoliko centimetara.

Zato v1 nema video. Ali **polje `type` u `playlist.json` već postoji** i uvijek je `"image"`, da se video kasnije doda bez rušenja formata.

Kad dođe red, dvije opcije:

**A — CSS pomjeranje cijelog videa** (kao kod slika). Player se skoro ne mijenja, nema workera na serveru, razmak za okvire se podešava uživo. Cijena: svaki panel dekodira frejm od 1920×3320 (~6.4 MP) a prikazuje trećinu. Prvo testirati na panelu — ako je glatko, ovo je pobjednik.

**B — sječenje ffmpegom prije objave.** Bolja sinhronizacija, tri puta manji bandwidth, ali vraća red poslova u backend i svaka izmjena `BEZEL_PX` znači ponovnu obradu svega.

Ako se ide na B, ključno je **jedan prolaz, ne tri poziva ffmpega**:

```bash
ffmpeg -i master.mp4 -filter_complex \
"[0:v]scale=1920:3336:force_original_aspect_ratio=increase,crop=1920:3336,split=3[a][b][c];\
 [a]crop=1920:1080:0:0[s1];[b]crop=1920:1080:0:1128[s2];[c]crop=1920:1080:0:2256[s3]" \
-map "[s1]" $ENC s1.mp4 -map "[s2]" $ENC s2.mp4 -map "[s3]" $ENC s3.mp4
```

gdje je `$ENC`:

```
-c:v libx264 -profile:v high -level 4.1 -pix_fmt yuv420p -preset veryfast -crf 20
-r 25 -fps_mode cfr -g 25 -keyint_min 25 -sc_threshold 0 -movflags +faststart -an
```

Dekodiranje se desi jednom, sva tri enkodera vide isti niz frejmova sa istim vremenskim oznakama. Tri odvojena poziva mogu dati fajlove koji se razlikuju za jedan frejm — a to je drift koji se ne može izliječiti u browseru.

`-r 25 -fps_mode cfr` je obavezno: snimci sa telefona su često VFR, a VFR i sinhronizacija se ne podnose.

Nakon enkodiranja **provjeri da sva tri fajla imaju identičan broj frejmova** (`ffprobe -count_frames`). Ako se razlikuju, označi posao kao neuspio i ne objavljuj.

---

## Konvencije

- Komentari i copy na našem jeziku; imena varijabli, funkcija i ruta na engleskom.
- Bez preuranjene apstrakcije. Ovo je aplikacija za jedan zid — direktan kod je bolji od slojeva.
- Player kod drži u jednom fajlu i odupri se želji da ga podijeliš na module.
- Svaka funkcija koja dodiruje vrijeme mora jasno reći da li radi sa lokalnim ili serverskim vremenom. Imenuj ih `serverNow()` i `localNow()`, nikad samo `now()`.
