#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_INVENTORY,
  DEFAULT_MANIFEST,
  validateNasRuntimeInventory,
  runCli as runInventoryCli,
} from "./nas-runtime-inventory-check.mjs";

const PACKAGE_BUILD_MANIFEST = "nas-bundle.resolved.json";

function normalizeRelativePath(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    manifest: null,
    inventory: null,
    bundleRoot: null,
    write: false,
    clean: false,
    json: false,
  };

  for (const arg of argv) {
    if (arg === "--write") {
      options.write = true;
    } else if (arg === "--clean") {
      options.clean = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg.startsWith("--manifest=")) {
      options.manifest = arg.slice("--manifest=".length);
    } else if (arg.startsWith("--inventory=")) {
      options.inventory = arg.slice("--inventory=".length);
    } else if (arg.startsWith("--bundle-root=")) {
      options.bundleRoot = arg.slice("--bundle-root=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.root = path.resolve(options.root);
  options.manifest = path.resolve(options.root, options.manifest ?? DEFAULT_MANIFEST);
  options.inventory = path.resolve(options.root, options.inventory ?? DEFAULT_INVENTORY);
  options.bundleRoot = options.bundleRoot
    ? path.resolve(options.bundleRoot)
    : path.resolve(options.root, "telegram_codex_bot");
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isWildcard(pattern) {
  return normalizeRelativePath(pattern).endsWith("/**");
}

function patternBase(pattern) {
  return normalizeRelativePath(pattern).replace(/\/\*\*$/, "");
}

function collectFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [""];
  while (stack.length > 0) {
    const relativeDir = stack.pop();
    const absoluteDir = path.join(root, relativeDir);
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = normalizeRelativePath(path.join(relativeDir, entry.name));
      if (entry.isDirectory()) {
        stack.push(relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }
  return files.sort();
}

function matchesForbiddenPath(relativePath, forbiddenEntry) {
  const target = normalizeRelativePath(relativePath).toLowerCase();
  const forbidden = normalizeRelativePath(forbiddenEntry).toLowerCase();
  return target === forbidden || target.startsWith(`${forbidden}/`);
}

export function resolveCopyPlan(manifest, root) {
  const include = Array.isArray(manifest.include) ? manifest.include.map(normalizeRelativePath) : [];
  const forbidden = Array.isArray(manifest.forbiddenPackageEntries)
    ? manifest.forbiddenPackageEntries.map(normalizeRelativePath)
    : [];

  const sourceFiles = new Set();
  const skipped = [];

  function shouldSkip(relativePath) {
    const forbiddenMatch = forbidden.find((entry) => matchesForbiddenPath(relativePath, entry));
    if (forbiddenMatch) return `forbidden by manifest: ${forbiddenMatch}`;
    return null;
  }

  for (const item of include) {
    const base = patternBase(item);
    const absoluteBase = path.join(root, base);
    if (!fs.existsSync(absoluteBase)) {
      throw new Error(`Manifest include entry does not exist: ${item}`);
    }

    const candidates = isWildcard(item)
      ? collectFiles(absoluteBase).map((file) => normalizeRelativePath(path.join(base, file)))
      : [base];

    for (const candidate of candidates) {
      const reason = shouldSkip(candidate);
      if (reason) {
        skipped.push({ file: candidate, reason });
      } else {
        sourceFiles.add(candidate);
      }
    }
  }

  return {
    files: [...sourceFiles].sort(),
    skipped,
  };
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function removeChildren(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  for (const entry of fs.readdirSync(targetPath)) {
    fs.rmSync(path.join(targetPath, entry), { recursive: true, force: true });
  }
}

function assertSafeBundleRoot(bundleRoot) {
  const normalized = path.resolve(bundleRoot);
  if (path.basename(normalized).toLowerCase() !== "telegram_codex_bot") {
    throw new Error(`Unsafe bundle root refused: ${bundleRoot}`);
  }
}

function runRepoBuild(root) {
  execSync("npm run build", {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
}

function copyPlanToBridge(plan, root, bridgeRoot) {
  for (const relativePath of plan.files) {
    const source = path.join(root, relativePath);
    const target = path.join(bridgeRoot, relativePath);
    ensureDir(path.dirname(target));
    fs.copyFileSync(source, target);
  }
}

function writeReadmes(bundleRoot, bridgeRoot) {
  const bundleReadme = `# telegram_codex_bot NAS csomag

Ez a mappa a Synology NAS-ra szant feltoltesi csomag.

## Mappak

- bridge/ - a bridge kontener futtatasahoz szukseges fajlok
- bridge-state/ - runtime allapot
- bridge-logs/ - logok
- bridge-config/ - opcionalis sajat kiegeszito fajlok

## Elsoleges NAS mod

Az alapertelmezett es ajanlott inditas a stabil mod:

- docker-compose.bridge.yml
- Dockerfile.bridge

Ez a mod kesz dist/ builddel fut, nem hasznal tsx watch-ot.

## Opcionalis NAS dev mod

Csak hibakereseshez:

- docker-compose.bridge.dev.yml
- Dockerfile.bridge.dev

Ez a mod forraskodot es tsx watch-ot hasznal, ezert DS223j-n nem ez az ajanlott ut.
`;

  const bridgeReadme = `# Bridge csomag

## Stabil NAS inditas

- compose: docker-compose.bridge.yml
- Dockerfile: Dockerfile.bridge
- futas: node dist/index.js

## NAS dev inditas

- compose: docker-compose.bridge.dev.yml
- Dockerfile: Dockerfile.bridge.dev
- futas: tsx watch src/index.ts

## Fontos

- A stabil mod az elsoleges.
- A src/ mappa a dev mod miatt marad benne.
- A worker kulon PC-n fut, nem ezen a bridge konteneren belul.
`;

  fs.writeFileSync(path.join(bundleRoot, "README.hu.md"), `${bundleReadme}\n`, "utf8");
  fs.writeFileSync(path.join(bridgeRoot, "README.hu.md"), `${bridgeReadme}\n`, "utf8");
}

function buildResolvedManifest(plan, inventory, manifest) {
  const inventoryByPath = new Map(
    Array.isArray(inventory.files) ? inventory.files.map((entry) => [normalizeRelativePath(entry.path), entry]) : [],
  );

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packageName: manifest.packageName ?? "telegram-codex-bot-bridge",
    sources: {
      manifest: DEFAULT_MANIFEST,
      inventory: DEFAULT_INVENTORY,
    },
    files: plan.files.map((file) => {
      const entry = inventoryByPath.get(normalizeRelativePath(file));
      return {
        path: normalizeRelativePath(file),
        family: entry?.family ?? "unknown",
      };
    }),
    skipped: plan.skipped,
  };
}

export function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const manifest = readJson(options.manifest);

  runRepoBuild(options.root);

  const inventoryWrite = runInventoryCli([
    `--root=${options.root}`,
    `--manifest=${options.manifest}`,
    `--inventory=${options.inventory}`,
    ...(options.write ? ["--write"] : []),
  ]);
  if (!inventoryWrite.ok) {
    return inventoryWrite;
  }

  const inventory = readJson(options.inventory);
  const plan = resolveCopyPlan(manifest, options.root);
  const validation = validateNasRuntimeInventory({
    inventory,
    manifest,
    currentFiles: inventory.files.map((entry) => entry.path),
    packageFiles: plan.files,
  });

  if (!validation.ok) {
    if (options.json) {
      console.log(JSON.stringify(validation, null, 2));
    } else {
      for (const issue of validation.issues) {
        console.error(`${issue.id}: ${issue.message}`);
      }
    }
    return validation;
  }

  if (!options.write) {
    console.log(`NAS bundle preflight passed. ${plan.files.length} files would be packaged.`);
    return { ok: true, plan };
  }

  assertSafeBundleRoot(options.bundleRoot);
  const bridgeRoot = path.join(options.bundleRoot, "bridge");
  const bridgeStateDir = path.join(options.bundleRoot, "bridge-state");
  const bridgeLogsDir = path.join(options.bundleRoot, "bridge-logs");
  const bridgeConfigDir = path.join(options.bundleRoot, "bridge-config");

  const existingEnvPath = path.join(bridgeRoot, ".env");
  const existingEnv = fs.existsSync(existingEnvPath) ? fs.readFileSync(existingEnvPath, "utf8") : null;

  ensureDir(options.bundleRoot);
  ensureDir(bridgeRoot);
  ensureDir(bridgeStateDir);
  ensureDir(bridgeLogsDir);
  ensureDir(bridgeConfigDir);
  if (options.clean) {
    removeChildren(bridgeRoot);
  }

  copyPlanToBridge(plan, options.root, bridgeRoot);
  writeReadmes(options.bundleRoot, bridgeRoot);
  fs.writeFileSync(
    path.join(bridgeRoot, PACKAGE_BUILD_MANIFEST),
    `${JSON.stringify(buildResolvedManifest(plan, inventory, manifest), null, 2)}\n`,
    "utf8",
  );

  if (existingEnv !== null) {
    fs.writeFileSync(existingEnvPath, existingEnv, "utf8");
  }

  console.log(`NAS bundle updated at: ${options.bundleRoot}`);
  return { ok: true, plan, bundleRoot: options.bundleRoot };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = runCli();
  if (!result.ok) {
    process.exitCode = 1;
  }
}
