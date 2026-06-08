import path from "node:path";

import { describe, expect, it } from "vitest";

import type { TeleCodexConfig } from "../src/config.js";
import {
  getOperatorEventsPath,
  getOperatorNotesDir,
  getRuntimeInboxDir,
  getRuntimeOutDir,
  getRuntimeRoot,
  getRuntimeTurnPaths,
} from "../src/runtime-paths.js";

describe("runtime paths", () => {
  const config = {
    stateDir: path.resolve("E:/codex_works/AttysCodexBridge/.telecodex"),
  } as TeleCodexConfig;

  it("keeps bot runtime paths under config.stateDir", () => {
    expect(getRuntimeRoot(config)).toBe(config.stateDir);
    expect(getRuntimeInboxDir(config, "turn-1")).toBe(path.join(config.stateDir, "inbox", "turn-1"));
    expect(getRuntimeOutDir(config, "turn-1")).toBe(path.join(config.stateDir, "turns", "turn-1", "out"));
    expect(getOperatorEventsPath(config)).toBe(path.join(config.stateDir, "operator-events.jsonl"));
    expect(getOperatorNotesDir(config)).toBe(path.join(config.stateDir, "operator-notes"));
  });

  it("returns grouped turn paths", () => {
    expect(getRuntimeTurnPaths(config, "abc")).toEqual({
      turnId: "abc",
      inboxDir: path.join(config.stateDir, "inbox", "abc"),
      outDir: path.join(config.stateDir, "turns", "abc", "out"),
    });
  });
});
