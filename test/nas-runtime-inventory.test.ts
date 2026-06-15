import { describe, expect, it } from "vitest";

import {
  classifyFile,
  validateNasRuntimeInventory,
} from "../scripts/nas-runtime-inventory-check.mjs";

describe("nas-runtime-inventory-check", () => {
  it("classifies stable docker inputs as runtime-required", () => {
    expect(classifyFile("Dockerfile.bridge")[0]).toBe("runtime-required");
    expect(classifyFile(".dockerignore")[0]).toBe("runtime-required");
    expect(classifyFile("dist/index.js")[0]).toBe("runtime-required");
  });

  it("classifies dev bundle source and local state separately", () => {
    expect(classifyFile("src/index.ts")[0]).toBe("runtime-optional");
    expect(classifyFile("worker/.env")[0]).toBe("local-sensitive-forbidden");
    expect(classifyFile("telegram_codex_bot/bridge/.env")[0]).toBe("excluded-generated");
  });

  it("fails validation when a file still needs classification", () => {
    const result = validateNasRuntimeInventory({
      manifest: { include: ["dist/**"] },
      currentFiles: ["new-runtime-file.txt"],
      packageFiles: [],
      inventory: {
        schemaVersion: 1,
        packageEligibleFamilies: ["runtime-required", "runtime-optional", "docs-payload"],
        files: [
          {
            path: "new-runtime-file.txt",
            family: "needs-classification",
            status: "needs-classification",
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.id === "classification:new-runtime-file.txt")).toBe(true);
  });
});
