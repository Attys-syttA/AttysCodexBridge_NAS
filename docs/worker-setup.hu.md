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

Munkahely:

```env
TELECODEX_WORKSPACE_ROOT=D:\codex_works
TELECODEX_DEFAULT_WORKSPACE=D:\codex_works
TELECODEX_STATE_DIR=D:\codex_works\AttysCodexBridge\.telecodex-worker
```

Otthon:

```env
TELECODEX_WORKSPACE_ROOT=E:\codex_works
TELECODEX_DEFAULT_WORKSPACE=E:\codex_works
TELECODEX_STATE_DIR=E:\codex_works\AttysCodexBridge\.telecodex-worker
```

## Elofeltetelek

1. A `codex` CLI mukodjon ezen a gepen.
2. A GitHub hitelesites itt legyen beallitva.
3. A worker lassa azokat a repokat, amelyeken a Codex dolgozni fog.

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
