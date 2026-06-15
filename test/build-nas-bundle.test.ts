import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCopyPlan } from "../scripts/build-nas-bundle.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "telecodex-nas-bundle-"));
}

function writeFile(root: string, relativePath: string, content = "x") {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

describe("build-nas-bundle", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves exact and wildcard include entries for the NAS bridge payload", () => {
    const root = makeTempDir();
    tempDirs.push(root);

    writeFile(root, "package.json");
    writeFile(root, "dist/index.js");
    writeFile(root, "src/index.ts");
    writeFile(root, "docs/worker-setup.hu.md");

    const plan = resolveCopyPlan(
      {
        include: ["package.json", "dist/**", "src/**", "docs/worker-setup.hu.md"],
        forbiddenPackageEntries: ["test/**"],
      },
      root,
    );

    expect(plan.files).toEqual([
      "dist/index.js",
      "docs/worker-setup.hu.md",
      "package.json",
      "src/index.ts",
    ]);
  });

  it("skips forbidden files if an include would otherwise catch them", () => {
    const root = makeTempDir();
    tempDirs.push(root);

    writeFile(root, "src/index.ts");
    writeFile(root, "src/secret.txt");

    const plan = resolveCopyPlan(
      {
        include: ["src/**"],
        forbiddenPackageEntries: ["src/secret.txt"],
      },
      root,
    );

    expect(plan.files).toEqual(["src/index.ts"]);
    expect(plan.skipped).toEqual([{ file: "src/secret.txt", reason: "forbidden by manifest: src/secret.txt" }]);
  });
});
