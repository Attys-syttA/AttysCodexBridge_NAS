# Emlekezteto: VSC - Telegram handoff, 2026-06-08

Ez a jegyzet az AttysCodexBridge VSC/Codex es Telegram kozotti atadas-atvetel tesztjenek allapotat rogziti. Celja, hogy VSC ujrainditas vagy uj Codex session utan gyorsan visszaolvashato legyen, hol tartunk es mi volt a kovetkezo tervezett lepes.

## Kiindulo cel

A cel az volt, hogy ha a VSC Codex Agent oldalrol indul munka, akkor Telegramon ne veletlenul uj szal induljon, hanem a bot a VSC-ben futo Codex thread folytatasakent kezelje az elso valaszt is.

Forditott iranyban is cel maradt: Telegramrol lehessen tisztan visszaadni a szalat VSC-be, legalabb `codex resume <thread-id>` blokk es kesobb celgephez kotott pending pickup formajaban.

## Fontos thread es tesztadat

- VSC/Codex thread ID: `00000000-1111-2222-3333-444444444444`
- Elvart workspace: `<CODEX_WORKS>\AttysCodexBridge`
- Handoff modell: `gpt-5.5`
- Host label: `sample-host`
- Telegram referencia teszt: a VSC oldali referencia szoveg `teszt-pelda-1` volt
- Telegram oldalon probalt szovegek: `teszt-pelda-2`, `teszt-pelda-3`, majd `/retry`

## Megerositett mukodo reszek

1. A Telegram reply kotest sikerult javitani.
   - A bot kimeneti uzenetei mar az eredeti felhasznaloi Telegram uzenetre fuzodnek `reply_parameters` hasznalataval.
   - Ez vonatkozik a normal szoveges valaszokra es az artifact/document kuldes utvonalara is.

2. A gepazonositas bekerult a lathato statuszba.
   - A bot uzenetekben latszik: `Host: sample-host (WORKSTATION\user)`.
   - Ez fontos, mert ugyanaz a Telegram bot tobb gep felol is kuldhet allapotot.

3. A VSC/Codex -> Telegram handoff alapallapot mukodik.
   - `scripts/send-vsc-handoff.ps1` tud handoff rekordot irni es Telegram uzenetet kuldeni.
   - A bot olvassa a `.telecodex/handoff-inbox.json` allapotot.
   - A Telegram chat kontextusban beall az atadas: `attached`.

4. A session context jo helyre mutatott.
   - `/session` szerint:
     - thread ID: `00000000-1111-2222-3333-444444444444`
     - workspace: `<CODEX_WORKS>\AttysCodexBridge`
     - modell: `gpt-5.5`
     - atadas allapot: `csatolva`

5. A rossz bot-token / rossz csatorna okat sikerult azonosítani es javitani.
   - A korabbi rossz csatornara kuldes oka az volt, hogy a kezzel inditott node folyamat orokolte a gep globalis `TELEGRAM_BOT_TOKEN` kornyezeti valtozojat, amely az orchestrator bothoz tartozott.
   - A projekt `.env` fajljaban jo token volt.
   - Javitas: a config loader a kritikus Telegram valtozoknal a repo `.env` erteket preferalja.
   - A handoff script is repo `.env` preferenciaval dolgozik.

6. A modelllista tisztult.
   - A bot `/model` listaja korabban mutatott nem API-kompatibilis vagy rejtett modelleket is.
   - Javitas utan a `visibility: hide/hidden` es `supported_in_api: false` rekordok nem kerulnek ajanlasra.

## Megerositett hiba

A Telegramrol inditott folytatas a megfelelo threadre es modellre mutatott, de a Codex stream ujra es ujra megszakadt:

```text
stream disconnected before completion: websocket closed by server before response.completed
```

Ezt a bot eloszor sima `error` tool itemkent kezelte, ezert ugy nezett ki, mintha normal valasz lett volna:

```text
Hasznalt eszkozok: error
```

Ezt javitottuk: az ilyen stream disconnect mar terminalis turn hibakent jelenik meg, magyar uzenettel:

```text
A Codex stream kapcsolata megszakadt. Hasznald a /retry parancsot, vagy probald ujra rovidebb uzenettel.
```

## Miert valoszinu a szakadas oka?

Nem Telegram timeout vagy bot fagyas latszik.

Ervek:

- A bot `health.json` szerint futott.
- A context fajlban a thread/workspace/model jo volt.
- A hiba a Codex CLI/SDK stream oldalrol jott.
- A VSC thread lokalis session fajlja nagyon nagy lett: kb. `73.6 MB`.
- A bot minden Telegram promptnal kulon `codex exec resume <thread-id>` folyamatot indit.
- Ez a nagy, VSC-ben elo thread kulon CLI-folyamatbol torteno resume-olasa latszik torékenynek.

Tovabbi fontos kulonbseg:

- VS Code Codex binaris: `codex-cli 0.137.0-alpha.4`
- SDK/bot oldali Codex CLI: `codex-cli 0.137.0`

Ez azt jelenti, hogy a VSC-ben elo hosszu threadet nem pontosan ugyanaz a futtatasi felulet probalja folytatni Telegram felol.

## Kulso repo ellenorzes

A `benedict2310/telecodex` repoban nem talaltunk konkret nyomot erre a hibara.

Megfigyelesek:

- Az upstream TeleCodex is `@openai/codex-sdk` es Codex CLI subprocess alapu.
- Az upstream `src/codex-session.ts` is sima failed tool eventkent kezelte az `item.type === "error"` eseteket.
- Az upstream `src/error-messages.ts` nem tartalmazott kulon kezelest a `stream disconnected before completion` / `response.completed` szovegre.

Az `openai/codex` repoban viszont talalhato hasonlo jelenseg `codex exec` stream megszakadasra, kulonosen nagy/komplex output vagy hosszu futas mellett. Ez megerositi, hogy a hiba valoszinuleg a Codex CLI/streaming resume utvonalban van, nem a Telegram bot kuldesi retegeben.

## Jelenlegi kodvaltozasok fo iranyai

A munkafa meg nem volt commitolva ennél a pontnal. Erintett teruletek:

- `src/bot.ts`
  - reply target atadas
  - handoff state kezeles
  - pending handoff vedokapu
  - VSC/Codex handoff fogadas

- `src/codex-session.ts`
  - explicit workspace override a VSC handoffhoz
  - explicit model override a VSC handoffhoz
  - VSC thread resume kozben ne a tarolt regi workspace/model nyerjen
  - terminalis stream disconnect error item hibakent kezelese

- `src/config.ts`
  - repo `.env` preferencia a Telegram token/user ID esetekben

- `src/codex-state.ts`
  - modelllista szurese API-kompatibilis modellekre

- `src/handoff-inbox.ts`, `src/session-registry.ts`
  - optional `model` mezo atvezetese a handoff state-ben

- `scripts/send-vsc-handoff.ps1`
  - `-ThreadId`, `-Workspace`, `-Model` alapu VSC handoff kuldes
  - repo `.env` preferencia

- tesztek:
  - reply target
  - handoff state
  - model/context override
  - terminalis Codex stream disconnect hiba
  - error message forditas

## Mar lefutott validaciok

A javitasok utan ezek lefutottak es zold eredmenyt adtak:

```powershell
npm run build
npm test
npm audit --audit-level=moderate
git diff --check
```

Commit elott meg futtatni kell:

```powershell
ggshield secret scan repo .
```

## Kovetkezo tervezett javitas

A VSC ujrainditas utan kisebb sessionnel ujra lehet probalni a direkt VSC thread handoffot.

Ha a direkt resume tovabbra is torékeny, a botot ugy kell boviteni, hogy nagy vagy VSC-bol atvett thread eseten ne vakon `resume`-oljon, hanem kerjen/keszitsen osszefoglalos atvetelt:

1. VSC/Codex oldalon keszuljon rovid, celzott atadasi osszefoglalo.
   - workspace
   - thread ID
   - modell
   - aktualis feladat
   - eddigi dontesek
   - modosult fajlok
   - kovetkezo lepes

2. Telegram oldalon a bot vagy:
   - friss threadet indit ezzel az osszefoglaloval, vagy
   - megerositest ker, hogy a felhasznalo direkt resume-ot akar-e.

3. A bot jelezze, ha a forras thread tul nagy.
   - Pelda policy: ha a lokalis session fajl merete nagyobb, mint egy kuszob, pl. 10-20 MB, akkor alapbol osszefoglalos atvetelt ajanljon.

4. A `/session` mutassa, hogy a chat:
   - direkt VSC threadhez van csatolva, vagy
   - osszefoglalos uj Telegram threadben dolgozik.

## /restart parancs otlet

Beepitheto, de ovatosan:

- A bot sajat magat nem tudja megbizhatoan ujrainditani, ha mar beragadt vagy meghalt.
- Jo megoldas: a `/restart` parancs csak restart kerest irjon egy fajlba, peldaul `.telecodex/restart-request.json`.
- A launcher vagy watchdog figyelje ezt a fajlt.
- A launcher/watchdog allitsa le es inditsa ujra a bot folyamatot.
- Siker eseten nem feltetlen kell Telegram uzenet, mert a bot ujra el.
- Sikertelen restart eseten a watchdog kuldjon kozvetlen Telegram Bot API uzenetet.

Javasolt policy:

- `/restart` csak engedelyezett Telegram usernek.
- Futó Codex turn alatt a bot kerjen megerositest vagy tagadja meg.
- Restart budget legyen, peldaul max 3 restart 10 percen belul.
- A restart oka keruljon be a `.telecodex/process-events.jsonl` es `.telecodex/watchdog-events.jsonl` naploba.

## Fontos gyakorlati tanulsag

A direkt VSC thread atadas akkor tunik jonak, ha:

- a thread kicsi vagy friss,
- a VSC es a bot oldali Codex CLI elegge kompatibilis,
- a modell explicit atmegy,
- a workspace explicit atmegy,
- a Telegram reply csak ezutan indul.

Hosszu, nagy VSC threadnel biztonsagosabb lehet az osszefoglalos atadas, mert a Telegram bot igy nem egy hatalmas VSC session fajlt probal ujra streamelve folytatni.
