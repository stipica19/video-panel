# Video zid — lokalno pokretanje

Sistem iz `Claude.md`, bez VPS-a: jedan Fastify proces servira player, admin, media i
izvor vremena. Nema nginxa, nema TLS-a, nema systemd unita.

## Pokretanje

```bash
npm run setup     # instalira backend + admin i pravi admin build
npm run seed      # testni masteri 1920 × 3336 i prva objava
npm start         # http://localhost:4000
```

Port je 4000 jer je 3000 na ovoj mašini zauzet drugim projektom. Mijenja se sa `PORT=…`
(vidi `.env.example`, kopiraj u `.env`).

| URL                               | Šta je                                             |
| --------------------------------- | -------------------------------------------------- |
| `/admin/`                         | admin (basic auth: `admin` / `videowall`)          |
| `/player?displej=1..3`            | player za pojedini panel, `&hud=1` za dijagnostiku |
| `/kalibracija?displej=1&bezel=48` | testni uzorak za mjerenje razmaka                  |
| `/m0`                             | smoke test — ispisuje `innerWidth`, dpr, UA, fps   |
| `/time`                           | izvor vremena, plain text                          |

Za razvoj admina sa hot reloadom: `npm run dev` (server) i `npm run dev:admin`
(Vite na 5173, proksira `/api`, `/media`, `/player` na 4000).

## Kako testirati bez panela

**Pregled zida** u adminu vrti tri prava playera u iframeovima, jedan ispod drugog, sa
simuliranim razmakom za okvire. Iframe je 1920 × 1080 CSS px — isto što panel prijavi ako
Tizen radi na 1920 sa `devicePixelRatio = 2`. Tu se vidi lomi li se linija na spoju.

Za ozbiljniji test otvori tri prozora `/player?displej=1`, `2`, `3` i posloži ih. Svaki
nezavisno računa poziciju iz serverskog vremena — ako se razlikuju, sinhronizacija ne valja.

## Video

Radi po **opciji B** iz `Claude.md`: server reže svaki video na **tri dijela od 1920 × 1080** i
svaki panel pušta samo svoj.

**Zašto.** Prvo je bila opcija A — panel dobije cijeli kadar zida (1920 × 3336) i CSS-om prikaže
svoju trećinu, isto kao kod slika. Slike tako rade, video ne: na Samsung QM55C (Tizen) ekran
ostane crn, bez ijedne greške u konzoli. Hardverski dekoder ne pušta kadar viši od ~2160 px, a
slika prolazi jer ide drugim putem. Isti fajl uredno radi na Fire TV Sticku, pa se na stolu ništa
ne primijeti.

### Tok posla

1. Upload ide kao i do sada — prima se **.mp4 / .m4v / .mov, H.264 ili HEVC**, do 200 MB
   (`MAX_VIDEO_MB`). Dimenzije, trajanje i kodek i dalje čita `server/mp4.js` iz kontejnera.
2. `server/slicer.js` pokupi novi video u najviše 3 s (`setInterval` + zastavica, bez reda poslova)
   i jednim pozivom ffmpega napravi tri fajla `<ime>-b<B>-1.mp4`, `-2`, `-3`.
   **Jedan prolaz, ne tri poziva** — tako sva tri izlaza vide isti niz frejmova; tri odvojena
   poziva umiju dati fajlove koji se razlikuju za jedan frejm, a taj drift se u browseru ne može
   izliječiti. Piše se u `tmp/` pa se premješta u `media/`.
3. Nakon rezanja `ffprobe -count_packets` broji frejmove u sva tri dijela. Ako se razlikuju, posao
   je neuspio i ne objavljuje se ništa.
4. Objava čeka: dok se neki video iz plejliste reže, `POST /api/publish` vraća **409** sa porukom
   („video se još reže na tri dijela…”). Kad rezanje pukne, u biblioteci stoji greška i dugme
   **Pokušaj ponovo**.

U `playlist.json` video stavka nosi i `files` (tri putanje) pored starog `file`. Panel pušta
`files[displej - 1]`.

### Razmak za okvire i `panel_h`

Rez zavisi od razmaka, pa se dijelovi imenuju po njemu. Razmak u pikselima videa nije isti broj
kao `bezel_px`, koji je u CSS pikselima panela:

```
B = round(bezel_px × 1080 / panel_h)      zaokruženo na paran broj
```

`panel_h` je nova postavka (podrazumijevano 1080, dozvoljeno 400–4320) — visina panela u CSS px,
onaj broj koji `/m0` ispiše. `B` mora biti paran: `yuv420p` ima poduzorkovanu hromu i neparan
`y` offset tiho pomjeri boju.

**Svaka izmjena `bezel_px` ili `panel_h` znači ponovno rezanje svih videa.** Stari dijelovi ostaju
na disku dok se novi ne izrežu — objava koja se trenutno vrti i dalje čita svoje fajlove. Brišu se
tek kad se obriše sam video.

### Player

- Video elementi su **izvan** slojeva sa slikama: `#videos` je ispod `#wall`. Na `<video>` nema
  ni `transform`, ni `opacity`, ni `transition` — samo `visibility`. Na Tizenu video ide u zasebnu
  hardversku ravninu i te osobine se ili ignorišu ili daju crn pravougaonik.
- Video se pušta **pravo sa URL-a**, ne iz blob-a. `&videoblob=1` vraća staro ponašanje.
- Prelaz: video se pokrene i pozicionira po serverskom satu, a **otkrije se tek kad ima frejm**
  (`playing` / `timeupdate` sa `readyState >= 2`, najviše 2 s čekanja). Tek tada slika izblijedi —
  zato nema crnog bljeska. Obrnuto, slika se fade-uje preko videa, pa se video nakon 400 ms
  pauzira i oslobodi (`removeAttribute('src')` + `load()`), osim ako je sljedeća stavka isti video.
- Zaostatak se i dalje popravlja brzinom reprodukcije, a od 350 ms skokom.
- Stara objava bez `files` se i dalje vrti: player pusti cijeli kadar i pomjeri ga `top`-om.
  HUD u tom slučaju piše **CIJELI KADAR (stara objava)**.
- `/player?displej=N&hud=1` u redu `video` pokazuje poziciju, zaostatak, brzinu, `readyState`,
  `videoWidth × videoHeight` i grešku, a red `video fajl` ime dijela koji taj panel pušta.

### ffmpeg

U Docker slici je `ffmpeg` instaliran. Lokalno mora biti u `PATH`, inače rezanje pukne sa
„ffmpeg nije instaliran na serveru”. Putanje se mogu prebaciti sa `FFMPEG_PATH` i `FFPROBE_PATH`.

```bash
sudo apt install ffmpeg
```

Master se i dalje priprema kao kadar cijelog zida (server ga dalje reže sam):

```bash
ffmpeg -i ulaz.mp4 -vf "scale=1920:3336:force_original_aspect_ratio=increase,crop=1920:3336" \
  -c:v libx264 -profile:v high -level 4.1 -pix_fmt yuv420p -preset veryfast -crf 20 \
  -r 25 -fps_mode cfr -g 25 -keyint_min 25 -sc_threshold 0 -movflags +faststart -an izlaz.mp4
```

Trajanje stavke i pokret za video i dalje **nameće server**: trajanje je vlastito trajanje snimka,
pokret je `none`.

## Redoslijed rada po `Claude.md`

- **M0** — otvori `/m0` na panelu preko URL Launchera. Upiši izmjereni `innerWidth` u
  `Claude.md`. Od njega zavisi sve ostalo.
- **M2** — `/kalibracija?displej=N&bezel=48` na sva tri panela, mijenjaj `bezel` dok
  vertikalne linije ne budu neprekinute, upiši broj u Pregled zida → „Razmak za okvire”.
- Objava je dvofazna: `Objavi` postavlja `next` sa `activeFrom = sada + 90 s`, paneli
  preuzimaju u pozadini i prebacuju istovremeno, bez reloada stranice. Prva objava ide odmah.

## Deploy na VPS

Push na `main` → GitHub Action gradi sliku, gura je na GHCR, pa se preko SSH-a na
serveru povuče i podigne. Deploy prijavi uspjeh tek kad `/time` odgovori.

### Jednom, na serveru

Folder može biti bilo koji — podrazumijevano `/srv/videowall`, a ako je aplikacija
već negdje drugdje, samo postavi repo varijablu `APP_DIR` (Settings → Secrets and
variables → Actions → **Variables**) na tu putanju.

**Mora biti apsolutna.** `~/apps/video-panel` ne radi: tilda bi se proširila kod
`mkdir` i `scp`, ali ne i u zadnjem koraku, pa bi deploy pukao na pola. Piši
`/home/korisnik/apps/video-panel`. Workflow to i provjerava i javlja jasnu grešku.

Ime compose projekta je fiksirano na `videowall`, pa volumen sa bazom i medijima
ne zavisi od imena foldera — aplikacija se može premjestiti bez gubitka sadržaja.

```bash
# Docker + compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"      # odjava i prijava nakon ovoga

mkdir -p ~/apps/video-panel          # ili gdje već stoji
cd ~/apps/video-panel

# Tajne koje ne idu u sliku ni u git.
cat > .env <<'EOF'
ADMIN_USER=admin
ADMIN_PASS=<duga lozinka>
PANEL_TOKEN=<dug nasumičan niz>
MAX_VIDEO_MB=200
EOF
chmod 600 .env
```

`IMAGE=` u taj `.env` upisuje sam Action pri svakom deployu — ne diraj ga ručno
osim kad vraćaš staru verziju.

### Jednom, na GitHubu

Settings → Secrets and variables → Actions → **Secrets**:

| Tajna             | Šta je                                                                  |
| ----------------- | ----------------------------------------------------------------------- |
| `SSH_HOST`        | adresa VPS-a                                                            |
| `SSH_USER`        | korisnik sa pravom na docker                                            |
| `SSH_KEY`         | privatni ključ (cijeli, sa `-----BEGIN`), javni ide u `authorized_keys` |
| `SSH_KNOWN_HOSTS` | izlaz iz `ssh-keyscan -H vps.adresa`                                    |
| `SSH_PORT`        | opciono, ako SSH nije na 22                                             |

Ista stranica, kartica **Variables**:

| Varijabla | Šta je                                                             |
| --------- | ------------------------------------------------------------------ |
| `APP_DIR` | apsolutna putanja foldera na serveru; bez nje se koristi `/srv/videowall` |

Ključ napravi zasebno za deploy, ne koristi svoj lični:

```bash
ssh-keygen -t ed25519 -f deploy_key -N "" -C "github-deploy"
ssh-copy-id -i deploy_key.pub korisnik@vps            # javni na server
cat deploy_key                                         # sadržaj u SSH_KEY
ssh-keyscan -H vps.adresa                              # izlaz u SSH_KNOWN_HOSTS
```

`SSH_KNOWN_HOSTS` postoji da deploy ne bi slijepo prihvatao bilo koji server koji
se javi na toj adresi — zato nema `StrictHostKeyChecking=no`.

### nginx i sertifikat

Tizen odbija nevažeći sertifikat, pa HTTPS nije opcion.

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name app.skin-glow.beauty;

    ssl_certificate     /etc/letsencrypt/live/app.skin-glow.beauty/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.skin-glow.beauty/privkey.pem;

    # Video ide do 200 MB — podrazumijevanih 1 MB bi odbilo svaki upload.
    client_max_body_size 200M;
    proxy_read_timeout   300s;
    proxy_send_timeout   300s;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name  app.skin-glow.beauty;
    return 301 https://$host$request_uri;
}
```

`certbot --nginx -d  app.skin-glow.beauty` za sertifikat.

Za razliku od plana u `Claude.md`, `/media/` servira Fastify a ne nginx — fajlovi
su u Docker volumenu. Zaglavlja su ista (`public, max-age=2592000, immutable`),
pa panel i dalje ne skida isti fajl dvaput.

### Sadržaj i vraćanje unazad

Baza i media su u volumenu `videowall_videowall-data`, ne u slici — nova verzija
ih ne dira.

```bash
# rezervna kopija
docker run --rm -v videowall_videowall-data:/data -v "$PWD":/izlaz alpine \
  tar czf /izlaz/videowall-$(date +%F).tar.gz -C /data .

# vraćanje na stariju verziju: promijeni IMAGE= u .env na stariji sha tag
cd /srv/videowall && nano .env && docker compose up -d
```

## Šta je drugačije od VPS varijante

- Media servira Fastify (`Cache-Control: public, max-age=30d, immutable`), ne nginx.
- Nema sertifikata. Tizen odbija self-signed, pa za prave panele treba pravi domen —
  lokalno panel može ići samo na `http://<ip-mašine>:4000/player?displej=N` ako je na istoj mreži
  (server sluša na `0.0.0.0`).
- Token panela je `panel-dev-token`. Player ga uzima iz `?token=` parametra, ili koristi tu
  podrazumijevanu vrijednost.

## Struktura

```
server/      Fastify + better-sqlite3, schema.sql se izvrši pri startu
public/      player.html, kalibracija.html, m0.html — bez builda, bez zavisnosti
admin/       Vite + React + TanStack Query, build ide u admin/dist
scripts/     seed.js (testni masteri), reset.js (briše sve)
data/        SQLite baza i media (nije u gitu)
```

`npm run reset -- --yes` briše bazu i sve slike.
