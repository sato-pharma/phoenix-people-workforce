#!/usr/bin/env node
// Pre-apply guard for Railway Infrastructure-as-Code (`.railway/railway.ts`).
//
// 🔴 WHY THIS EXISTS. `.railway/railway.ts` owns variable EXISTENCE: a `railway config apply` DELETES
// every live variable whose name is not in that service's `env:` block. The committed file is a
// snapshot of a `railway config pull` taken on one day, and the live project drifts fast — 13 new
// names in 9 days on `phoenix-people-workforce` (measured 2026-10-10, written into the IaC file's
// own header). So an apply from the committed file, without a fresh pull first, silently deletes
// whatever was added since the snapshot — real production secrets. Until 2026-10-23 the only
// safeguard was a comment in the file telling a human to remember. This makes it mechanical.
//
// WHAT IT DOES. Reads every service's `env:` names out of `.railway/railway.ts`, reads the live
// variable names from Railway for each service, and REFUSES (exit 1) if applying the file as
// committed would delete any live variable. Run it immediately before `railway config plan/apply`.
// It writes nothing and changes nothing — it only reads the live project and the committed file.
//
// Platform-injected `RAILWAY_*` names are ignored on both sides: `config pull` never writes them
// and they are not the project's to own (same rule the IaC file states for its own env lists).
//
// Auth mirrors validate-railway-production-secrets.mjs: RAILWAY_API_TOKEN or RAILWAY_TOKEN, plus
// RAILWAY_PROJECT_ID. Being unable to read the live project is itself a refusal — a gate that
// cannot see the live state must never wave an apply through.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { RAILWAY_CLI_PACKAGE } from "./secret-policy.mjs";
import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// Names the Railway platform injects; they appear live but are never authored, so neither side
// should ever treat them as drift.
const PLATFORM_PREFIX = "RAILWAY_";

/**
 * Extract each service's declared env variable names from `.railway/railway.ts` source.
 * Returns a Map of service name -> Set of variable names. A service with no `env:` block maps to an
 * empty set. Env blocks in this file hold only `NAME: preserve()` entries, so they never nest.
 * @param {string} tsSource
 * @returns {Map<string, Set<string>>}
 */
export function parseRailwayIacEnv(tsSource) {
  const out = new Map();
  const serviceRe = /service\(\s*"([^"]+)"/g;
  const starts = [];
  let m;
  while ((m = serviceRe.exec(tsSource)) !== null) {
    starts.push({ name: m[1], index: m.index });
  }
  for (let i = 0; i < starts.length; i += 1) {
    const { name, index } = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].index : tsSource.length;
    const block = tsSource.slice(index, end);
    const names = new Set();
    // The first `env: { ... }` after the service( call is this service's env. preserve() values
    // carry no braces, so a non-greedy match to the first closing brace captures the whole block.
    const envMatch = block.match(/env:\s*\{([\s\S]*?)\}/);
    if (envMatch) {
      const keyRe = /([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
      let k;
      while ((k = keyRe.exec(envMatch[1])) !== null) names.add(k[1]);
    }
    out.set(name, names);
  }
  return out;
}

/**
 * Compare one service's committed env names against its live names.
 * `wouldDelete` are live names absent from the committed file — applying would remove them.
 * `wouldAdd` are committed names not yet live. Platform `RAILWAY_*` names are ignored on both sides.
 * @param {Iterable<string>} committedNames
 * @param {Iterable<string>} liveNames
 * @returns {{ wouldDelete: string[], wouldAdd: string[] }}
 */
export function classifyDrift(committedNames, liveNames) {
  const committed = new Set([...committedNames].filter((n) => !n.startsWith(PLATFORM_PREFIX)));
  const live = new Set([...liveNames].filter((n) => !n.startsWith(PLATFORM_PREFIX)));
  const wouldDelete = [...live].filter((n) => !committed.has(n)).sort();
  const wouldAdd = [...committed].filter((n) => !live.has(n)).sort();
  return { wouldDelete, wouldAdd };
}

/**
 * Normalize the shapes `railway variable list --json` can return into a flat array of names.
 * @param {unknown} input
 * @returns {string[]}
 */
export function variableNamesFromCliJson(input) {
  if (Array.isArray(input)) return input.map((v) => (typeof v === "string" ? v : v?.name)).filter(Boolean);
  if (input && typeof input === "object") {
    const obj = /** @type {Record<string, unknown>} */ (input);
    if (Array.isArray(obj.variables)) {
      return obj.variables.map((v) => (typeof v === "string" ? v : /** @type {any} */ (v)?.name)).filter(Boolean);
    }
    if (obj.variables && typeof obj.variables === "object") return Object.keys(obj.variables);
    return Object.keys(obj);
  }
  return [];
}

function readLiveNames({ service, projectId, environment }) {
  const npmCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const cliArgs = ["--yes", RAILWAY_CLI_PACKAGE, "variable", "list", "--json", "--service", service, "--environment", environment, "--project", projectId];
  let last = null;
  for (const varName of ["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"]) {
    const token = process.env.RAILWAY_API_TOKEN?.trim() || process.env.RAILWAY_TOKEN?.trim() || "";
    last = spawnSync(npmCommand, cliArgs, {
      cwd: process.cwd(),
      env: { ...process.env, RAILWAY_API_TOKEN: varName === "RAILWAY_API_TOKEN" ? token : "", RAILWAY_TOKEN: varName === "RAILWAY_TOKEN" ? token : "" },
      stdio: "pipe",
      encoding: "utf8",
    });
    if (last.status === 0) break;
    const message = `${last.stderr || ""}${last.stdout || ""}`;
    if (!/Unauthorized|Invalid RAILWAY/i.test(message)) break;
  }
  if (!last || last.status !== 0) {
    throw new Error(`railway variable list failed for ${service}: ${(last?.stderr || last?.stdout || "unknown error").trim()}`);
  }
  let payload;
  try {
    payload = JSON.parse(last.stdout || "{}");
  } catch {
    throw new Error(`could not parse railway CLI JSON for ${service}`);
  }
  return variableNamesFromCliJson(payload);
}

function main() {
  refuseUnknownFlags({
    name: "railway-iac-preapply-check",
    entry: import.meta.url,
    known: ["--service", "--environment", "--iac-file"],
  });

  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const onlyService = flag("--service", "");
  const environment = flag("--environment", "production");
  const iacFile = flag("--iac-file", ".railway/railway.ts");

  const projectId = process.env.RAILWAY_PROJECT_ID?.trim();
  const token = process.env.RAILWAY_API_TOKEN?.trim() || process.env.RAILWAY_TOKEN?.trim();
  if (!token || !projectId) {
    console.error("[railway-iac-preapply-check] RAILWAY_API_TOKEN (or RAILWAY_TOKEN) and RAILWAY_PROJECT_ID are required.");
    console.error("[railway-iac-preapply-check] A gate that cannot read the live project refuses rather than waving the apply through.");
    process.exit(1);
  }

  let tsSource;
  try {
    tsSource = readFileSync(iacFile, "utf8");
  } catch {
    console.error(`[railway-iac-preapply-check] could not read ${iacFile} — run from the repo root.`);
    process.exit(1);
  }

  const envByService = parseRailwayIacEnv(tsSource);
  const services = [...envByService.keys()].filter((name) => (onlyService ? name === onlyService : envByService.get(name).size > 0));
  if (services.length === 0) {
    console.error(`[railway-iac-preapply-check] no service with an env block found in ${iacFile}${onlyService ? ` for --service ${onlyService}` : ""}.`);
    process.exit(1);
  }

  let dangerous = 0;
  for (const service of services) {
    const committed = envByService.get(service) || new Set();
    let live;
    try {
      live = readLiveNames({ service, projectId, environment });
    } catch (err) {
      console.error(`[railway-iac-preapply-check] ${service}: ${err.message}`);
      process.exitCode = 1;
      dangerous += 1;
      continue;
    }
    const { wouldDelete, wouldAdd } = classifyDrift(committed, live);
    if (wouldDelete.length > 0) {
      dangerous += 1;
      console.error(`\n🔴 ${service}: applying the committed file would DELETE ${wouldDelete.length} live variable(s):`);
      for (const n of wouldDelete) console.error(`     - ${n}`);
      console.error(`   Run \`railway config pull\` to refresh ${iacFile} before applying.`);
    } else {
      console.log(`✓ ${service}: no live variable would be deleted (${committed.size} committed, +${wouldAdd.length} new in file).`);
    }
    if (wouldAdd.length > 0) {
      console.log(`   note — ${service}: ${wouldAdd.length} name(s) in the file are not live yet: ${wouldAdd.join(", ")}`);
    }
  }

  if (dangerous > 0) {
    console.error(`\n[railway-iac-preapply-check] REFUSED — ${dangerous} service(s) would lose variables. Do NOT apply until the file is re-pulled.`);
    process.exit(1);
  }
  console.log("\n[railway-iac-preapply-check] OK — no apply would delete a live variable.");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
