# DS223j bridge telepites

Ez a mod akkor valo, ha a NAS csak a Telegram bridge-et futtatja, a Codex es a GitHub-irasi muveletek pedig egy kulon worker gepen maradnak.

## Javasolt mappak a NAS-on

- `/volume1/telegram_codex_bot/bridge`
- `/volume1/telegram_codex_bot/bridge-state`
- `/volume1/telegram_codex_bot/bridge-logs`
- `/volume1/telegram_codex_bot/bridge-config` opcionális

## Fontos `.env` ertekek a bridge oldalon

```env
TELECODEX_RUNTIME_MODE=remote-bridge
TELECODEX_WORKERS_JSON=[{"id":"munkahely","label":"Munkahely","baseUrl":"http://192.168.100.87:8787","sharedSecret":"<egyedi-titok>"},{"id":"otthon","label":"Otthon","baseUrl":"http://<otthoni-ip>:8787","sharedSecret":"<egyedi-titok>"}]
TELECODEX_DEFAULT_WORKER_ID=munkahely
TELECODEX_STATE_DIR=/data/bridge-state
NODE_OPTIONS=--max-old-space-size=384
```

Telegramon a `/workers` paranccsal lehet kivalasztani, hogy az adott beszelgetes melyik worker gepre menjen. Fontos: worker valtaskor az uj keres mar az uj gepre kerul, de a regi thread az elozo worker gepen marad.

## Két NAS mod

### 1. Stabil NAS mod

Ez az ajanlott mod DS223j-n:

- compose: `docker-compose.bridge.yml`
- Dockerfile: `Dockerfile.bridge`
- futas: `node dist/index.js`

Ebben a modban:

- nincs `tsx watch`
- nincs forraskod mount az `/app` ala
- nincs TypeScript forditas a NAS-on indulaskor

### 2. Opcionális NAS dev mod

Csak hibakeresesre:

- compose: `docker-compose.bridge.dev.yml`
- Dockerfile: `Dockerfile.bridge.dev`
- futas: `tsx watch src/index.ts`

Ebben a modban:

- a forraskod mountolva van
- a bridge automatikusan ujraindulhat fajlmodositas utan
- DS223j-n ez best effort, nem ez az ajanlott hosszu tavu futtatasi ut

## Inditasi sorrend

1. A lokalis pollingos botot allitsd le.
2. A worker gep fusson es valaszoljon a `/health` vegponton.
3. A NAS-on inditsd el a stabil bridge projektet.
4. Telegramon ellenorizd:
   - `/start`
   - `/workers`
   - `/doctor`

## Ellenorzes

1. A bridge kontener zold allapotba kerul.
2. A logban nincs `ERR_MODULE_NOT_FOUND`.
3. Telegramon valaszol a bot.
4. A `/doctor` szerint `runtime mode: remote-bridge`.
5. A `bridge-state` es `bridge-logs` mappaba tud irni.

## Megjegyzes a rejtett megosztott mappahoz

A rejtett DSM-beallitas onmagaban nem gond. A fontos az, hogy a kontener mountja mukodjon, es az a felhasznalo, akivel a kontener fut, tenyleg tudjon olvasni es irni a becsatolt mappakba.
