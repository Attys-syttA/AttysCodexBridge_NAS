import { describe, expect, it } from "vitest";

import {
  formatGitStatusPlain,
  normalizeLocalPathForCompare,
  parseGitPorcelainStatus,
} from "../src/repo-diagnostics.js";

describe("repo diagnostics", () => {
  it("parses clean branch status", () => {
    expect(parseGitPorcelainStatus("## main...origin/main\n")).toEqual({
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      changedFiles: [],
    });
  });

  it("parses ahead, behind, and changed files", () => {
    expect(parseGitPorcelainStatus("## main...origin/main [ahead 1, behind 2]\n M src/a.ts\n?? test/b.ts\n")).toEqual({
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 2,
      changedFiles: ["src/a.ts", "test/b.ts"],
    });
  });

  it("formats no-repo status", () => {
    const text = formatGitStatusPlain({
      isRepo: false,
      workspace: "E:/x",
      ahead: 0,
      behind: 0,
      dirty: false,
      changedFiles: [],
      error: "not a git repository",
    });
    expect(text).toContain("Git repo: nincs");
  });

  it("normalizes Windows extended-length paths for comparisons", () => {
    expect(normalizeLocalPathForCompare("\\\\?\\E:\\codex_works")).toBe(
      normalizeLocalPathForCompare("E:\\codex_works"),
    );
  });
});
