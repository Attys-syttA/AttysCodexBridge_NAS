import { escapeHTML } from "./format.js";

export interface DualText {
  html: string;
  plain: string;
}

type HelpTopic = {
  title: string;
  aliases: string[];
  lines: string[];
};

const HELP_TOPICS: HelpTopic[] = [
  {
    title: "/handback — átadás Telegramból Codex CLI / VS Code oldalra",
    aliases: ["handback", "hangback", "handoff", "atadas", "átadás"],
    lines: [
      "Mire való: az aktuális Telegramhoz kötött Codex threadet átadja CLI/VS Code folytatásra.",
      "Mikor használd: ha telefonon indult a munka, de gépen akarod folytatni.",
      "Lépések Telegramon:",
      "1. Küldj legalább egy valódi üzenetet Codexnek, hogy legyen Thread ID.",
      "2. Ellenőrizd: /session",
      "3. Futtasd: /handback",
      "4. A bot kiír egy cd ... && codex resume <thread-id> parancsot.",
      "Lépések gépen:",
      "1. Nyiss terminált abban a workspace-ben, amit a bot kiírt.",
      "2. Futtasd a bot által adott codex resume parancsot.",
      "Mit fog ismerni Codex: ugyanannak a threadnek az előzményeit, tehát a Telegramon addig folytatott beszélgetést is.",
      "Fontos: a VS Code chat UI nem tükrözi visszamenőleg a Telegram üzeneteket; a kontextus a Codex threadben él.",
    ],
  },
  {
    title: "/attach <thread-id> — átvétel Telegramra meglévő Codex threadből",
    aliases: ["attach", "atvetel", "átvétel", "csatolas", "csatolás"],
    lines: [
      "Mire való: egy már létező Codex threadet hozzáköt ehhez a Telegram chathez vagy témához.",
      "Mikor használd: ha gépen indult a munka, de Telegramon akarod folytatni.",
      "Hol találod a Thread ID-t:",
      "- Telegramon: /session",
      "- Telegram átadáskor: /handback kiírja a codex resume <thread-id> parancsot",
      "- Codex CLI oldalon: a resume parancsban szereplő thread ID az, amit csatolni kell",
      "Lépések Telegramon:",
      "1. Másold ki a thread ID-t.",
      "2. Futtasd: /attach <thread-id>",
      "3. Ellenőrizd: /session",
      "Mit fog ismerni a bot/Codex: a megadott thread korábbi előzményeit.",
      "Fontos: a Telegram chat nem kapja vissza automatikusan a gépen írt régi üzeneteket; a következő Codex válasz viszont ugyanabból a threadből dolgozik.",
    ],
  },
  {
    title: "/session — aktuális kapcsolat és Thread ID",
    aliases: ["session", "thread", "id"],
    lines: [
      "Mire való: megmutatja, melyik host, workspace, launch profil és Thread ID aktív ebben a Telegram kontextusban.",
      "Ha ezt látod: Thread ID: (még nincs elindítva), akkor még nincs folytatható Codex thread.",
      "Thread ID akkor keletkezik, amikor elküldesz egy valódi üzenetet Codexnek, és a Codex turn elindul.",
      "Átadás előtt mindig érdemes lefuttatni: /session",
    ],
  },
  {
    title: "/sessions és /switch — régebbi szálak keresése",
    aliases: ["sessions", "switch", "szalak", "szálak"],
    lines: [
      "Mire való: a korábbi Codex threadek között böngészhetsz és válthatsz.",
      "/sessions gombos listát ad, workspace-ek szerint rendezve.",
      "/switch <thread-id> közvetlenül vált egy ismert thread ID-ra.",
      "Hasznos, ha nem emlékszel pontosan, melyik threadet kell /attach paranccsal visszavenni.",
    ],
  },
  {
    title: "/new és /projekts — új szál vagy projektváltás",
    aliases: ["new", "projekts", "projects", "projekt"],
    lines: [
      "/new új Codex threadet indít az aktuális vagy kiválasztott workspace-ben.",
      "/projekts projektet választ ehhez a Telegram chathez, és ott friss threadet indít.",
      "Projektváltás után a régi thread nem törlődik, csak az aktuális Telegram kontextus másik workspace-re áll.",
      "Ha később vissza akarsz menni, használd a /sessions vagy /attach parancsot.",
    ],
  },
  {
    title: "/watchdog — bridge állapot",
    aliases: ["watchdog", "health", "status"],
    lines: [
      "Mire való: megmutatja, hogy a bridge bot fut-e, melyik hostról válaszol, van-e aktív kérés és mi volt az utolsó hiba.",
      "Ha két gépen is fut bot, a Host és Gép sor segít eldönteni, honnan jött az állapot.",
      "A watchdog nem a Codex válaszára támaszkodik; fájlalapú health információból dolgozik.",
    ],
  },
  {
    title: "/launch_profiles, /model, /effort — új szálak beállításai",
    aliases: ["launch", "launch_profiles", "model", "effort"],
    lines: [
      "Ezek a beállítások főleg új vagy újracsatolt threadekre érvényesek.",
      "/launch_profiles: sandbox és approval profil választása.",
      "/model: modell választása új threadekhez.",
      "/effort: reasoning effort választása új threadekhez.",
      "Ha egy aktív thread már fut, a /session mutatja, hogy mi az aktív és mi lesz a következő beállítás.",
    ],
  },
  {
    title: "/auth, /login, /logout — Codex hitelesítés",
    aliases: ["auth", "login", "logout"],
    lines: [
      "/auth megmutatja, hogy Codex hitelesítve van-e ezen a gépen.",
      "/login Telegramból indítja a Codex bejelentkezést, ha ez engedélyezett.",
      "/logout kijelentkeztet CLI-alapú auth esetén.",
      "Ha CODEX_API_KEY van használatban, a logout nem Telegramból történik; a .env beállítást kell módosítani.",
    ],
  },
  {
    title: "/abort és /retry — futó kérés kezelése",
    aliases: ["abort", "retry"],
    lines: [
      "/abort megszakítja az aktuális Codex kört.",
      "/retry újraküldi az utolsó Telegram promptot.",
      "Ha a bot azt írja, hogy még dolgozik az előző üzeneten, előbb várj vagy használd a /abort parancsot.",
    ],
  },
];

/**
 * Grouped command reference for /help.
 */
export function renderHelpMessage(): DualText {
  const sections = [
    {
      title: "💬 Beszélgetés",
      commands: [
        ["/new", "Új szál indítása"],
        ["/projekts", "Aktív projekt kiválasztása ehhez a chathez"],
        ["/session", "Aktuális szál adatai"],
        ["/sessions", "Szálak böngészése és váltása"],
        ["/attach", "Codex szál hozzákötése ehhez a témához"],
        ["/handback", "Szál visszaadása a Codex CLI-nek"],
        ["/abort", "Futó művelet megszakítása"],
        ["/retry", "Utolsó kérés újraküldése"],
      ],
    },
    {
      title: "🤖 Modell",
      commands: [
        ["/launch_profiles", "Indítási profil kiválasztása"],
        ["/model", "Modell megtekintése és váltása"],
        ["/effort", "Reasoning effort beállítása"],
      ],
    },
    {
      title: "🔐 Hitelesítés",
      commands: [
        ["/auth", "Hitelesítési állapot ellenőrzése"],
        ["/login", "Bejelentkezés indítása"],
        ["/logout", "Kijelentkezés"],
      ],
    },
    {
      title: "ℹ️ Segédeszközök",
      commands: [
        ["/start", "Üdvözlés és állapot"],
        ["/help", "Parancslista"],
        ["/voice", "Hangfelismerés állapota"],
        ["/watchdog", "Bridge állapotkép"],
      ],
    },
  ];

  const htmlLines: string[] = [];
  const plainLines: string[] = [];

  for (const section of sections) {
    htmlLines.push(`<b>${escapeHTML(section.title)}</b>`);
    plainLines.push(section.title);
    for (const [cmd, desc] of section.commands) {
      htmlLines.push(`  ${cmd} — ${escapeHTML(desc)}`);
      plainLines.push(`  ${cmd} — ${desc}`);
    }
    htmlLines.push("");
    plainLines.push("");
  }

  while (htmlLines.at(-1) === "") {
    htmlLines.pop();
  }
  while (plainLines.at(-1) === "") {
    plainLines.pop();
  }

  return {
    html: htmlLines.join("\n"),
    plain: plainLines.join("\n"),
  };
}

export function renderHelpTopicMessage(rawTopic: string): DualText {
  const topic = normalizeHelpTopic(rawTopic);
  const helpTopic = HELP_TOPICS.find((entry) => entry.aliases.includes(topic));

  if (!helpTopic) {
    const knownTopics = HELP_TOPICS.flatMap((entry) => entry.aliases.slice(0, 1)).join(", ");
    const lines = [
      `Nincs ilyen részletes súgó: ${rawTopic}`,
      "",
      `Elérhető témák: ${knownTopics}`,
      "",
      "Példák: /help attach, /help handback, /help session",
    ];
    return {
      html: lines.map((line) => escapeHTML(line)).join("\n"),
      plain: lines.join("\n"),
    };
  }

  const htmlLines = [`<b>${escapeHTML(helpTopic.title)}</b>`, "", ...helpTopic.lines.map((line) => escapeHTML(line))];
  const plainLines = [helpTopic.title, "", ...helpTopic.lines];

  return {
    html: htmlLines.join("\n"),
    plain: plainLines.join("\n"),
  };
}

export function listHelpTopicAliases(): string[] {
  return HELP_TOPICS.flatMap((entry) => entry.aliases);
}

function normalizeHelpTopic(rawTopic: string): string {
  return rawTopic.trim().toLowerCase().replace(/^\/+/, "");
}

/**
 * Short /start message for first-time users (no prior interaction in this context).
 */
export function renderWelcomeFirstTime(authWarning?: string): DualText {
  const htmlLines = [
    "<b>👋 AttysCodexBridge készen áll.</b>",
    "",
    "Küldj egy üzenetet, és indulhat a beszélgetés Codexszel.",
    "Küldhetsz hangüzenetet, fotót vagy dokumentumot is.",
    "",
    "A parancsok listájához írd be: /help",
  ];
  const plainLines = [
    "👋 AttysCodexBridge készen áll.",
    "",
    "Küldj egy üzenetet, és indulhat a beszélgetés Codexszel.",
    "Küldhetsz hangüzenetet, fotót vagy dokumentumot is.",
    "",
    "A parancsok listájához írd be: /help",
  ];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Concise /start message for returning users with session info.
 */
export function renderWelcomeReturning(
  sessionHtml: string,
  sessionPlain: string,
  isTopicSession: boolean,
  authWarning?: string,
): DualText {
  const label = isTopicSession ? "AttysCodexBridge (téma szál)" : "AttysCodexBridge";

  const htmlLines = [`<b>👋 ${escapeHTML(label)}</b>`, "", sessionHtml];
  const plainLines = [`👋 ${label}`, "", sessionPlain];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Format a session button label for /sessions list.
 * Wider workspace name (12 chars), model tag, short thread snippet.
 */
export function formatSessionLabel(
  options: {
    workspace: string;
    title: string;
    relativeTime: string;
    model?: string;
    isActive: boolean;
  },
): string {
  const prefix = options.isActive ? "✅" : "📁";
  const workspaceName = trimLabel(getWorkspaceShortName(options.workspace), 12) || "(ismeretlen)";
  const title = trimLabel(options.title || "(cím nélkül)", 20) || "(cím nélkül)";
  const time = options.relativeTime;

  let label = `${prefix} ${workspaceName} · ${title} · ${time}`;

  if (options.model) {
    const shortModel = trimLabel(options.model, 10);
    label += ` · ${shortModel}`;
  }

  return label;
}

function trimLabel(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}
