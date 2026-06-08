# Telegram és Codex thread átadás / átvétel

Ez a súgó azt írja le, hogyan lehet ugyanazt a Codex beszélgetést folytatni Telegramról gépre, vagy gépről Telegramra.

Fontos különbség: ez nem élő chat-szinkron a VS Code panel és a Telegram között. A közös pont a Codex `thread ID`. Ha ugyanazt a threadet folytatod, Codex ismeri a korábbi kontextust, de a másik felület régi üzenetei nem jelennek meg automatikusan a chatablakban.

## Alapfogalmak

- **Telegram context:** egy sima Telegram chat vagy egy forum topic. A bot ezekhez külön sessiont tart.
- **Workspace:** az a helyi projektmappa, ahol Codex dolgozik, például `<CODEX_WORKS>\email-header-analyzer`.
- **Thread ID:** a Codex beszélgetés azonosítója. Ezzel lehet ugyanazt a munkát másik felületen folytatni.
- **Nincs még thread:** ha `/session` alatt ezt látod: `Thread ID: (még nincs elindítva)`, akkor még nincs mit átadni. Küldj egy valódi üzenetet Codexnek, várd meg, hogy elinduljon a kör, utána lesz thread ID.

## Hol találom a thread ID-t?

Telegramon:

```text
/session
```

Ez megmutatja:

- host / gép azonosító
- `Thread ID`
- `Workspace`
- indítási profil
- modell és reasoning effort, ha be van állítva

Átadáskor:

```text
/handback
```

Ez kiír egy ilyen jellegű parancsot:

```powershell
cd '<CODEX_WORKS>\email-header-analyzer' && codex resume '<thread-id>'
```

A `<thread-id>` az az azonosító, amit később `/attach <thread-id>` paranccsal vissza tudsz venni Telegramra.

## Telegramról gépre: `/handback`

Ezt akkor használd, ha telefonon kezdtél dolgozni, de a gépen, Codex CLI-ben vagy VS Code terminálból akarod folytatni.

Lépések:

1. Telegramon küldj legalább egy valódi üzenetet Codexnek.
2. Ellenőrizd:

   ```text
   /session
   ```

3. Ha van valódi `Thread ID`, futtasd:

   ```text
   /handback
   ```

4. A bot kiírja a `codex resume <thread-id>` parancsot.
5. Gépen nyiss terminált abban a workspace-ben, amit a bot kiírt.
6. Futtasd a bot által adott parancsot.

Mit fog tudni Codex?

- Ugyanannak a threadnek az előzményeit látja.
- A Telegramon addig folytatott beszélgetés kontextusa megmarad.

Mit nem fogsz látni?

- A VS Code chat panel nem fogja automatikusan visszamenőleg kirajzolni a Telegram üzeneteket.
- A folytatás kontextusa megvan, de a felületek nem tükrözik egymás teljes chatnaplóját.

## Gépről Telegramra: VSC/Codex átadó script

Ezt akkor használd, ha a gépen futó VS Code / Codex Agent munkát akarod Telegramon folytatni.

Lépések:

1. Keresd meg a gépen futó Codex szál `thread ID` értékét.
2. Menj abba a workspace-be, amelyikhez a VSC/Codex munka tartozik.
3. Futtasd az átadó scriptet:

   ```powershell
   <CODEX_WORKS>\AttysCodexBridge\scripts\send-vsc-handoff.ps1 -ThreadId <thread-id> -Model gpt-5.5
   ```

   Ha nem abból a workspace-ből futtatod, add meg külön:

   ```powershell
   <CODEX_WORKS>\AttysCodexBridge\scripts\send-vsc-handoff.ps1 -ThreadId <thread-id> -Workspace <CODEX_WORKS>\AttysCodexBridge -Model gpt-5.5
   ```

4. A script Telegram üzenetet küld, és `.telecodex/handoff-inbox.json` rekordot ír.
5. Ha válaszolsz erre Telegramon, a bot előbb átvált a megadott `thread ID` + `Workspace` párra, és csak utána küldi be az üzenetedet Codexnek.

Ha a VSC oldali thread modellje eltér a bot alapértelmezett modelljétől, add át explicit módon `-Model <modell>` paraméterrel. Például ha a VS Code panelen `5.5` látszik, használd: `-Model gpt-5.5`.

Alapértelmezés:

- a script `attached` állapotot ír, tehát az első Telegram válasz már folytatás
- ha előbb megerősítést akarsz kérni, használd:

  ```powershell
  <CODEX_WORKS>\AttysCodexBridge\scripts\send-vsc-handoff.ps1 -ThreadId <thread-id> -Model gpt-5.5 -Pending
  ```

Szintetikus ellenőrzés Telegram küldés és fájlírás nélkül:

```powershell
<CODEX_WORKS>\AttysCodexBridge\scripts\send-vsc-handoff.ps1 -ThreadId <thread-id> -Model gpt-5.5 -DryRun
```

Fontos: ez a script nem a Telegram chat korábbi állapotából találgat. Mindig a megadott `thread ID` és az aktuális vagy megadott `Workspace` kerül átadásra.

## Gépről Telegramra: kézi `/attach <thread-id>`

Ezt akkor használd, ha egy már létező Codex threadet kézzel akarsz Telegramon folytatni.

Lépések:

1. Keresd meg a thread ID-t. Tipikus források:
   - korábbi `/session`
   - korábbi `/handback` válasz
   - `codex resume <thread-id>` parancs
2. Telegramon futtasd:

   ```text
   /attach <thread-id>
   ```

3. Ellenőrizd:

   ```text
   /session
   ```

4. Küldj új üzenetet Telegramon. Codex ugyanabból a threadből dolgozik tovább.

Mit fog tudni Codex?

- A megadott thread korábbi előzményeit.
- A gépen addig folytatott Codex beszélgetés kontextusát.

Mit nem fogsz látni?

- Telegramon nem jelennek meg automatikusan a gépen korábban írt üzenetek.
- A következő válasz viszont ugyanannak a threadnek a kontextusából készül.

## Gyakori helyzetek

### `/session` azt írja: `Thread ID: (még nincs elindítva)`

Ez normális, ha még nem küldtél Codexnek valódi feladatot ebben a Telegram contextben.

Teendő:

1. Küldj egy rövid üzenetet, például: `Nézd meg röviden a repo állapotát.`
2. Várd meg, hogy Codex elkezdjen válaszolni.
3. Futtasd újra:

   ```text
   /session
   ```

### Rossz projektre állt a Telegram chat

Használd:

```text
/projekts
```

Ez projektet választ ehhez a Telegram chathez, és ott friss threadet indít.

Ha régi threadhez akarsz visszatérni:

```text
/sessions
```

vagy:

```text
/attach <thread-id>
```

### Nem tudom, melyik géptől jön az állapot

Használd:

```text
/watchdog
```

vagy:

```text
/session
```

Mindkettő mutat host/gép információt, például `otthon`.

## Telegram bővített súgó

A botban ezek működnek:

```text
/help attach
/help handback
/help session
/help sessions
/help new
/help projekts
/help watchdog
/help launch_profiles
/help model
/help effort
/help auth
/help abort
/help retry
```

Gyakori elgépelésként a bot a `/help hangback` témát is a `/handback` súgóra irányítja.
