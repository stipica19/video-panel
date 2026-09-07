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

Radi po **opciji A** iz `Claude.md`: panel dobija cijeli kadar i CSS-om prikazuje svoju trećinu,
isto kao kod slika. Nema sječenja ffmpegom, nema reda poslova, razmak za okvire ostaje podesiv
uživo. Cijena je što svaki panel dekodira cijeli frejm od 1920 × 3336 a prikazuje trećinu — to
treba izmjeriti na pravom panelu prije nego se odluči da je gotovo.

- Prima se **.mp4 / .m4v / .mov, H.264 (avc1)**, do 200 MB (`MAX_VIDEO_MB`).
- Trajanje, dimenzije i kodek čita `server/mp4.js` direktno iz kontejnera — **ffmpeg nije potreban**.
  Rotacija sa telefona se poštuje, pa portret snimak ne biva odbijen kao pejzaž.
- Trajanje stavke i pokret za video **nameće server**: trajanje je vlastito trajanje snimka, pokret
  je `none`. Ken Burns preko videa je samo dodatni posao dekoderu.
- Player pušta video iz blob URL-a (kao i slike) i stalno poredi `currentTime` sa serverskim satom:
  sitno zaostajanje popravlja brzinom reprodukcije, veliko od 350 ms skokom.
- Priprema materijala:

```bash
ffmpeg -i ulaz.mp4 -vf "scale=1920:3336:force_original_aspect_ratio=increase,crop=1920:3336" \
  -c:v libx264 -profile:v high -level 4.1 -pix_fmt yuv420p -preset veryfast -crf 20 \
  -r 25 -fps_mode cfr -g 25 -keyint_min 25 -sc_threshold 0 -movflags +faststart -an izlaz.mp4
```

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

```bash
# Docker + compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"      # odjava i prijava nakon ovoga

sudo mkdir -p /srv/videowall && sudo chown "$USER" /srv/videowall
cd /srv/videowall

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

Settings → Secrets and variables → Actions:

| Tajna             | Šta je                                                                  |
| ----------------- | ----------------------------------------------------------------------- |
| `SSH_HOST`        | adresa VPS-a                                                            |
| `SSH_USER`        | korisnik sa pravom na docker                                            |
| `SSH_KEY`         | privatni ključ (cijeli, sa `-----BEGIN`), javni ide u `authorized_keys` |
| `SSH_KNOWN_HOSTS` | izlaz iz `ssh-keyscan -H vps.adresa`                                    |
| `SSH_PORT`        | opciono, ako SSH nije na 22                                             |

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
