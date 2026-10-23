#!/usr/bin/env node
// Keep infra/runtime-extras in step with pnpm-lock.yaml (audit F-22 / S-INT-16, 2026-10-23).
//
// The production image adds two packages AFTER Next's standalone trace — puppeteer-core (offer-letter PDFs) and
// sharp (invoice extraction, hiring-document scans) — with `npm ci` from infra/runtime-extras/package-lock.json
// (the Dockerfile says why). Their versions MUST equal what pnpm-lock.yaml resolves, because that is what every
// test and the dev server run against; tests/dockerfile-reproducible.test.ts fails the required checks the moment
// the two differ. This rewrites both files from pnpm-lock.yaml:
//
//   node scripts/sync-runtime-extras.mjs           # write package.json + regenerate package-lock.json (needs npm + network)
//   node scripts/sync-runtime-extras.mjs --check   # read-only: exit 1 and say which version differs
//
// npm, not pnpm, and --package-lock-only: it resolves and writes the lockfile and installs nothing, so it is safe
// in a worktree (no node_modules is touched).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs): a
// mistyped `--chek` would otherwise REWRITE the lockfile instead of only checking it.
refuseUnknownFlags({
  name: "sync-runtime-extras",
  entry: import.meta.url,
  known: ["--check"],
});

export const RUNTIME_EXTRAS_DIR = "infra/runtime-extras";
/** The packages the Dockerfile installs into the runtime image, in the order package.json lists them. */
export const RUNTIME_EXTRAS = Object.freeze(["puppeteer-core", "sharp"]);

/**
 * The version pnpm-lock.yaml resolves for a direct dependency of the root importer (`importers: .:`), with any
 * peer suffix — `25.15.0(yauzl@2.10.0)` — removed. Null when the root importer does not declare it.
 *
 * @param {string} lockText
 * @param {string} name
 * @returns {string | null}
 */
export function lockedImporterVersion(lockText, name) {
  const lines = String(lockText).split(/\r?\n/);
  const importers = lines.indexOf("importers:");
  if (importers === -1) return null;
  const root = lines.indexOf("  .:", importers);
  if (root === -1) return null;
  const key = name.startsWith("@") ? `'${name}':` : `${name}:`;
  for (let i = root + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // The root importer ends at the next importer (two-space key) or the next top-level key.
    if (/^ {0,2}\S/.test(line)) break;
    if (line !== `      ${key}`) continue;
    for (let j = i + 1; j < lines.length && /^ {8}\S/.test(lines[j]); j += 1) {
      const match = /^ {8}version: (\S+)$/.exec(lines[j]);
      if (match) return match[1].replace(/\(.*$/, "");
    }
    return null;
  }
  return null;
}

/**
 * Every difference between pnpm-lock.yaml and the runtime extras' two files, as sentences. Empty when in step.
 *
 * @param {{ pnpmLock: string, manifest: { dependencies?: Record<string, string> }, npmLock: { packages?: Record<string, { version?: string }> } }} input
 * @returns {string[]}
 */
export function runtimeExtrasDrift({ pnpmLock, manifest, npmLock }) {
  const problems = [];
  const declared = Object.keys(manifest.dependencies ?? {}).sort();
  const expectedNames = [...RUNTIME_EXTRAS].sort();
  if (JSON.stringify(declared) !== JSON.stringify(expectedNames)) {
    problems.push(`${RUNTIME_EXTRAS_DIR}/package.json declares [${declared.join(", ")}], expected exactly [${expectedNames.join(", ")}]`);
  }
  for (const name of RUNTIME_EXTRAS) {
    const locked = lockedImporterVersion(pnpmLock, name);
    if (!locked) {
      problems.push(`pnpm-lock.yaml's root importer no longer resolves ${name}`);
      continue;
    }
    const pinned = manifest.dependencies?.[name];
    if (pinned !== locked) {
      problems.push(`${RUNTIME_EXTRAS_DIR}/package.json pins ${name} ${pinned ?? "(nothing)"} but pnpm-lock.yaml resolves ${locked}`);
    }
    const installed = npmLock.packages?.[`node_modules/${name}`]?.version;
    if (installed !== locked) {
      problems.push(`${RUNTIME_EXTRAS_DIR}/package-lock.json installs ${name} ${installed ?? "(nothing)"} but pnpm-lock.yaml resolves ${locked}`);
    }
  }
  return problems;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main(argv) {
  const check = argv.includes("--check");
  const pnpmLock = readFileSync("pnpm-lock.yaml", "utf8");
  const manifestPath = resolve(RUNTIME_EXTRAS_DIR, "package.json");
  const lockPath = resolve(RUNTIME_EXTRAS_DIR, "package-lock.json");
  const manifest = readJson(manifestPath);

  if (check) {
    const problems = runtimeExtrasDrift({ pnpmLock, manifest, npmLock: readJson(lockPath) });
    for (const problem of problems) console.error(`sync-runtime-extras: ${problem}`);
    if (problems.length === 0) console.log("sync-runtime-extras: in step with pnpm-lock.yaml");
    return problems.length === 0 ? 0 : 1;
  }

  const dependencies = {};
  for (const name of RUNTIME_EXTRAS) {
    const locked = lockedImporterVersion(pnpmLock, name);
    if (!locked) throw new Error(`pnpm-lock.yaml's root importer does not resolve ${name}; nothing to sync to.`);
    dependencies[name] = locked;
  }
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, dependencies }, null, 2)}\n`);
  // One constant command string through the shell: npm is `npm.cmd` on Windows, which cannot be spawned without
  // one, and a constant string carries no argument a caller could inject.
  const npm = spawnSync("npm install --package-lock-only --ignore-scripts --no-audit --no-fund", {
    cwd: resolve(RUNTIME_EXTRAS_DIR),
    stdio: "inherit",
    shell: true,
  });
  if (npm.status !== 0) throw new Error("npm could not regenerate infra/runtime-extras/package-lock.json.");
  const problems = runtimeExtrasDrift({ pnpmLock, manifest: readJson(manifestPath), npmLock: readJson(lockPath) });
  if (problems.length) throw new Error(problems.join("\n"));
  console.log(`sync-runtime-extras: ${Object.entries(dependencies).map(([n, v]) => `${n}@${v}`).join(", ")} — commit both files.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`sync-runtime-extras: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
