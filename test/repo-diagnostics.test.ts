import { describe, expect, it } from "vitest";

import {
  classifyGitPublishFailure,
  formatGitPushCapabilityPlain,
  formatGitStatusPlain,
  normalizeLocalPathForCompare,
  parseGitRemoteList,
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

  it("parses fetch and push remotes", () => {
    expect(parseGitRemoteList("origin\thttps://github.com/example/repo.git (fetch)\norigin\thttps://github.com/example/repo.git (push)\n")).toEqual([
      {
        name: "origin",
        fetchUrl: "https://github.com/example/repo.git",
        pushUrl: "https://github.com/example/repo.git",
      },
    ]);
  });

  it("classifies remote network failures for publish checks", () => {
    expect(classifyGitPublishFailure("fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443")).toContain(
      "hálózaton nem érhető el",
    );
  });

  it("formats push capability summary", () => {
    const text = formatGitPushCapabilityPlain({
      status: "available",
      reason: "A remote elérhető.",
      remoteName: "origin",
      branch: "main",
      targetBranch: "main",
    });

    expect(text).toContain("Remote GitHub push: available");
    expect(text).toContain("Remote: origin");
    expect(text).toContain("Cél branch: main");
  });

  it("normalizes Windows extended-length paths for comparisons", () => {
    expect(normalizeLocalPathForCompare("\\\\?\\E:\\codex_works")).toBe(
      normalizeLocalPathForCompare("E:\\codex_works"),
    );
  });
});
