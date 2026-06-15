# Worker gep beallitas

Ez a gep futtatja a valódi Codex-munkát, a Git muveleteket, a GitHub-irast es a hangfeldolgozast.

## Fontos `.env` ertekek a worker oldalon

```env
TELECODEX_RUNTIME_MODE=remote-worker
TELECODEX_WORKER_SHARED_SECRET=<ugyanaz-a-titok-mint-a-bridge-oldalon>
TELECODEX_WORKER_PORT=8787
TELECODEX_STATE_DIR=.telecodex
```

## Gepfuggo `.env`

A worker `.env` gepenkent kulon marad.

Pelda munkahelyi gepen:

```env
TELECODEX_WORKSPACE_ROOT=<CODEX_WORKS_ON_WORK_PC>
TELECODEX_DEFAULT_WORKSPACE=<CODEX_WORKS_ON_WORK_PC>
TELECODEX_STATE_DIR=<CODEX_WORKS_ON_WORK_PC>\AttysCodexBridge\.telecodex-worker
```

Pelda otthoni gepen:

```env
TELECODEX_WORKSPACE_ROOT=<CODEX_WORKS_ON_HOME_PC>
TELECODEX_DEFAULT_WORKSPACE=<CODEX_WORKS_ON_HOME_PC>
TELECODEX_STATE_DIR=<CODEX_WORKS_ON_HOME_PC>\AttysCodexBridge\.telecodex-worker
```

## Elofeltetelek

1. A `codex` CLI mukodjon ezen a gepen.
2. A GitHub hitelesites itt legyen beallitva.
3. A worker lassa azokat a repokat, amelyeken a Codex dolgozni fog.
4. A worker gep erje el halozaton a Git szervert, kulonben a push probe es a tenyleges push is el fog bukni.

## Inditas

Buildelt worker:

```bash
npm run build
powershell -ExecutionPolicy Bypass -File .\scripts\start-worker.ps1
```

## Push-kepes mod

- Alapbol a bot biztonsagos modban indul.
- Ha egy feladat push vagy PR irast ker, a bridge jovahagyast ker.
- Jovahagyas utan ugyanaz a thread `github-write` profillal folytatodik.
- A GitHub-irasi hitelesites csak a worker gepen marad.
- A `Full Access` onmagaban nem jelenti azt, hogy a push mukodni fog. Ez csak annyit jelent, hogy nincs sandbox-korlatozas.
- A tenyleges push-hoz 3 kulon feltetel kell:
  - megfelelo inditasi profil a worker oldalon
  - mukodo halozati eleres a remote Git host fele
  - ervenyes Git hitelesites a worker oldalon
- A Telegram bot kulon ellenorzi a remote publish kepesseget. Eloszor read-only probe fut, utana dry-run push probe, es csak siker eseten engedi a `/push` megerositeset.
