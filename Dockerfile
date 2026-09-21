# Jedan proces servira player, admin, media i izvor vremena — pa je i slika jedna.
# Debian (glibc), ne Alpine: better-sqlite3 i sharp imaju gotove binarne verzije
# za glibc, pa se ništa ne kompajlira ako ne mora.

# ---- admin build -------------------------------------------------------------
FROM node:22-bookworm-slim AS admin
WORKDIR /app/admin
COPY admin/package.json admin/package-lock.json ./
RUN npm ci
COPY admin/ ./
RUN npm run build

# ---- serverske zavisnosti ----------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Alati za node-gyp: trebaju samo ako prebuild binarna verzija ne postoji.
# Ostaju u ovom sloju i ne ulaze u finalnu sliku.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- izvršna slika -----------------------------------------------------------
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app

# ffmpeg reže svaki video na tri dijela od 1920 × 1080 (server/slicer.js).
# Bez njega upload prolazi, ali objava staje sa "ffmpeg nije instaliran".
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY --from=admin /app/admin/dist ./admin/dist

# Baza i media žive u volumenu, ne u slici.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 4000

# /time je najjeftiniji endpoint u sistemu i ne dira bazu.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/time').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
