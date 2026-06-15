#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_INVENTORY = "nas-runtime-inventory.json";
export const DEFAULT_MANIFEST = "nas-bundle.manifest.json";
const SCHEMA_VERSION = 1;

const VALID_FAMILIES = new Set([
  "runtime-required",
  "runtime-optional",
  "docs-payload",
  "developer-only",
  "test-only",
  "local-sensitive-forbidden",
  "excluded-generated",
  "needs-classification",
]);

const PACKAGE_ELIGIBLE_FAMILIES = new Set([
  "runtime-required",
  "runtime-optional",
  "docs-payload",
]);

const WALK_SKIP_DIRS = new Set([
  ".git",
  ".serena",
  "coverage",
  "node_modules",
  "telegram_codex_bot",
]);

const RUNTIME_REQUIRED_ROOT_FILES = new Set([
  ".dockerignore",
  ".env.bridge.example",
  "package-lock.json",
  "package.json",
  "Dockerfile.bridge",
  "docker-compose.bridge.yml",
]);

const RUNTIME_OPTIONAL_ROOT_FILES = new Set([
  "tsconfig.json",
  "Dockerfile.bridge.dev",
  "docker-compose.bridge.dev.yml",
  DEFAULT_INVENTORY,
]);

const DEVELOPER_ONLY_ROOT_FILES = new Set([
  "AGENTS.md",
  "CODEX_RESEARCH.md",
  "Dockerfile",
  "Dockerfile.worker",
  "LICENSE",
  "README.md",
  ".gitignore",
  "docker-compose.yml",
  "package-lock.json",
  "package.json",
  "start-attyscodexbridge-workspace.ps1",
  "vitest.config.ts",
  DEFAULT_MANIFEST,
]);

const LOCAL_SENSITIVE_EXACT = new Set([
  ".env",
  ".env.example",
  ".env.worker.example",
  "telecodex-run.err.log",
  "telecodex-run.log",
  "tmp_node_test.txt",
  "tmp_write_test.txt",
  "worker/.env",
]);

function normalizeRelativePath(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    inventory: null,
    manifest: null,
    write: false,
    json: false,
  };

  for (const arg of argv) {
    if (arg === "--write") {
      options.write = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg.startsWith("--inventory=")) {
      options.inventory = arg.slice("--inventory=".length);
    } else if (arg.startsWith("--manifest=")) {
      options.manifest = arg.slice("--manifest=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.root = path.resolve(options.root);
  options.inventory = path.resolve(options.root, options.inventory ?? DEFAULT_INVENTORY);
  options.manifest = path.resolve(options.root, options.manifest ?? DEFAULT_MANIFEST);
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeStat(root, relativePath) {
  const fullPath = path.join(root, relativePath);
  if (!fs.existsSync(fullPath)) return null;
  return fs.statSync(fullPath);
}

function isWildcard(pattern) {
  return normalizeRelativePath(pattern).endsWith("/**");
}

function patternBase(pattern) {
  return normalizeRelativePath(pattern).replace(/\/\*\*$/, "");
}

function matchesPattern(relativePath, pattern) {
  const target = normalizeRelativePath(relativePath);
  const normalizedPattern = normalizeRelativePath(pattern);
  if (isWildcard(normalizedPattern)) {
    const base = patternBase(normalizedPattern);
    return target === base || target.startsWith(`${base}/`);
  }
  return target === normalizedPattern;
}

function collectFilesFromDisk(root) {
  const files = [];
  const stack = [""];

  while (stack.length > 0) {
    const relativeDir = stack.pop();
    const absoluteDir = path.join(root, relativeDir);
    if (!fs.existsSync(absoluteDir)) continue;

    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = normalizeRelativePath(path.join(relativeDir, entry.name));
      if (entry.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(entry.name) && !WALK_SKIP_DIRS.has(relativePath)) {
          stack.push(relativePath);
        }
      } else {
        files.push(relativePath);
      }
    }
  }

  return files.sort();
}

function buildManifestContext(manifest) {
  const include = Array.isArray(manifest?.include) ? manifest.include.map(normalizeRelativePath) : [];
  return {
    include,
    docsPayload: new Set(include.filter((item) => item.startsWith("docs/") && !isWildcard(item))),
  };
}

export function classifyFile(relativePath, manifestContext = { docsPayload: new Set() }) {
  const file = normalizeRelativePath(relativePath);

  if (file === ".env.bridge.example") {
    return ["runtime-required", "Bridge-side example env file shipped with the NAS bundle."];
  }
  if (LOCAL_SENSITIVE_EXACT.has(file) || /^\.env\./.test(path.basename(file))) {
    return ["local-sensitive-forbidden", "Local env, log, or machine-specific runtime file must stay out of the NAS bundle."];
  }
  if (file.startsWith("worker/")) {
    return ["local-sensitive-forbidden", "Worker-side local runtime files are never part of the NAS bridge bundle."];
  }
  if (file.startsWith("telegram_codex_bot/")) {
    return ["excluded-generated", "Generated NAS staging output; must not be treated as source of truth."];
  }
  if (file.startsWith("dist/")) {
    return ["runtime-required", "Compiled runtime output required by the stable NAS bridge image."];
  }
  if (file.startsWith("src/")) {
    return ["runtime-optional", "Source payload kept for the optional NAS dev image."];
  }
  if (file.startsWith("test/")) {
    return ["test-only", "Test code never belongs to the NAS runtime bundle."];
  }
  if (file.startsWith(".github/")) {
    return ["developer-only", "Repository automation file."];
  }
  if (file.startsWith(".serena/")) {
    return ["local-sensitive-forbidden", "Local Serena workspace state must not be packaged."];
  }
  if (file.startsWith("scripts/")) {
    return ["developer-only", "Build or operator helper script kept in the repo only."];
  }
  if (file.startsWith("launchd/")) {
    return ["developer-only", "Host-specific launcher helper not used by the NAS Docker bundle."];
  }
  if (file.startsWith("docs/")) {
    if (manifestContext.docsPayload?.has(file)) {
      return ["docs-payload", "Selected operator documentation shipped with the NAS bundle."];
    }
    return ["developer-only", "Repository documentation not shipped in the NAS runtime bundle."];
  }
  if (RUNTIME_REQUIRED_ROOT_FILES.has(file)) {
    return ["runtime-required", "Required top-level NAS bridge packaging input."];
  }
  if (RUNTIME_OPTIONAL_ROOT_FILES.has(file)) {
    if (file === DEFAULT_INVENTORY) {
      return ["runtime-optional", "Versioned NAS runtime inventory used as packaging guardrail."];
    }
    return ["runtime-optional", "Optional NAS dev/runtime packaging input."];
  }
  if (DEVELOPER_ONLY_ROOT_FILES.has(file)) {
    return ["developer-only", "Repository-level file not needed inside the NAS bundle payload."];
  }
  return ["needs-classification", "New or changed file needs an explicit NAS bundle classification decision."];
}

function buildInventoryEntries(root, manifest) {
  const manifestContext = buildManifestContext(manifest);
  const files = new Set(collectFilesFromDisk(root));
  files.add(DEFAULT_INVENTORY);
  return [...files].sort().map((relativePath) => {
    const [family, reason] = classifyFile(relativePath, manifestContext);
    const stat = safeStat(root, relativePath);
    return {
      path: relativePath,
      name: path.basename(relativePath),
      family,
      status: family === "needs-classification" ? "needs-classification" : "classified",
      reason,
      lastModifiedAt: stat?.mtime.toISOString() ?? null,
    };
  });
}

export function validateNasRuntimeInventory({ inventory, manifest, currentFiles, packageFiles }) {
  const issues = [];
  if (inventory?.schemaVersion !== SCHEMA_VERSION) {
    issues.push({ status: "fail", id: "schema-version", message: `Unsupported inventory schema version: ${inventory?.schemaVersion}` });
  }

  const entries = Array.isArray(inventory?.files) ? inventory.files : [];
  const entryMap = new Map(entries.map((entry) => [normalizeRelativePath(entry.path), entry]));

  for (const family of inventory?.packageEligibleFamilies ?? []) {
    if (!PACKAGE_ELIGIBLE_FAMILIES.has(family)) {
      issues.push({ status: "fail", id: "package-family", message: `Unknown package eligible family: ${family}` });
    }
  }

  for (const entry of entries) {
    if (!VALID_FAMILIES.has(entry.family)) {
      issues.push({ status: "fail", id: `family:${entry.path}`, message: `Unknown inventory family for ${entry.path}: ${entry.family}` });
    }
  }

  for (const relativePath of currentFiles) {
    const normalized = normalizeRelativePath(relativePath);
    const entry = entryMap.get(normalized);
    if (!entry) {
      issues.push({ status: "fail", id: `missing:${normalized}`, message: `Missing inventory entry: ${normalized}` });
      continue;
    }
    if (entry.family === "needs-classification" || entry.status === "needs-classification") {
      issues.push({ status: "fail", id: `classification:${normalized}`, message: `File still needs NAS bundle classification: ${normalized}` });
    }
  }

  for (const packageFile of packageFiles) {
    const normalized = normalizeRelativePath(packageFile);
    const entry = entryMap.get(normalized);
    if (!entry) {
      issues.push({ status: "fail", id: `package-missing:${normalized}`, message: `Packaged file is missing from the inventory: ${normalized}` });
      continue;
    }
    if (!PACKAGE_ELIGIBLE_FAMILIES.has(entry.family)) {
      issues.push({
        status: "fail",
        id: `package-family:${normalized}`,
        message: `Packaged file has non-packagable family ${entry.family}: ${normalized}`,
      });
    }
  }

  const manifestInclude = Array.isArray(manifest?.include) ? manifest.include : [];
  if (manifestInclude.length === 0) {
    issues.push({ status: "fail", id: "manifest-include", message: "nas-bundle manifest must define at least one include entry." });
  }

  return { ok: issues.length === 0, issues };
}

export function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const manifest = readJson(options.manifest);
  const inventoryEntries = buildInventoryEntries(options.root, manifest);
  const inventory = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      fileSet: "repo-files-excluding-local-generated-and-bundle-staging",
      dateField: "filesystem-mtime",
      hashPolicy: "not-recorded",
    },
    packageEligibleFamilies: [...PACKAGE_ELIGIBLE_FAMILIES],
    families: {
      "runtime-required": "Required for the stable NAS bridge runtime bundle.",
      "runtime-optional": "Needed for optional NAS dev/runtime support.",
      "docs-payload": "Selected operator docs shipped with the NAS bundle.",
      "developer-only": "Repo-only source, tooling, or docs file.",
      "test-only": "Test file not shipped in the bundle.",
      "local-sensitive-forbidden": "Local env, secret, state, or machine-specific file.",
      "excluded-generated": "Generated output or staging directory that must stay out of source packaging.",
      "needs-classification": "New or changed file awaiting explicit NAS bundle classification.",
    },
    files: inventoryEntries,
  };

  if (options.write) {
    writeJson(options.inventory, inventory);
    console.log(`NAS runtime inventory written to ${options.inventory}`);
    return { ok: true, inventory };
  }

  const currentFiles = inventoryEntries.map((entry) => entry.path);
  const validation = validateNasRuntimeInventory({
    inventory: fs.existsSync(options.inventory) ? readJson(options.inventory) : inventory,
    manifest,
    currentFiles,
    packageFiles: [],
  });

  if (options.json) {
    console.log(JSON.stringify(validation, null, 2));
  } else if (validation.ok) {
    console.log("NAS runtime inventory check passed.");
  } else {
    for (const issue of validation.issues) {
      console.error(`${issue.id}: ${issue.message}`);
    }
  }

  return validation;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = runCli();
  if (!result.ok) {
    process.exitCode = 1;
  }
}
