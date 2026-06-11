# `telegram_codex_bot` megosztott mappa javasolt rendje

## Vegleges elrendezes

```text
/volume1/telegram_codex_bot/
  README.hu.md
  bridge/
  bridge-state/
  bridge-logs/
  bridge-config/        optionalis
```

## Mit hova erdemes tenni

### `bridge/`

Ez a NAS-ra feltoltott kesz bridge csomag.

Stabil modhoz:

- `Dockerfile.bridge`
- `docker-compose.bridge.yml`
- `dist/`
- `package.json`
- `package-lock.json`
- `.env.bridge.example`
- `README.hu.md`

Opcionális dev modhoz:

- `Dockerfile.bridge.dev`
- `docker-compose.bridge.dev.yml`
- `src/`
- `tsconfig.json`

Doksi:

- `docs/nas-bridge-setup.hu.md`
- `docs/nas-shared-folder-layout.hu.md`
- `docs/worker-setup.hu.md`

### `bridge-state/`

- runtime allapot
- context metadata
- inbox/outbox

### `bridge-logs/`

- bridge logok

### `bridge-config/`

- optionalis sajat config vagy masolatok

## Fontos elv

A `telegram_codex_bot` mappa mar nem a repo nyers masolata, hanem egy kesz NAS-feltoltesi csomag. A stabil mod az elsodleges, a dev mod csak kulon hibakeresesi ut.
