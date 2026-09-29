// Has STAGING drifted from PRODUCTION? Answered over PostgREST, with the secrets that already exist.
//
//   node scripts/check-staging-drift-rest.mjs     # read-only, both sides. Exit 0 in sync, 2 drifted.
//
// WHY THIS EXISTS, AND WHY IT IS NOT sync-staging-hr.mjs.
// The full reconciler reads and writes rows, so it needs a postgres connection string for each side.
// Production's has never existed as a repo secret — measured 2026-09-29 across all 65 secrets, the
// repo variables, both Phoenix environments, the second repo and the (non-existent) organisation —
// so the daily alarm stopped at "Report a missing secret" on every dispatch and measured nothing.
//
// The alarm does not need to WRITE, and it does not need every column. It needs to answer one
// question — has staging fallen behind? — and row counts answer it. Tonight's real drift was one
// employee, one occupancy row and one line_area_map row; the employees count alone would have caught
// it. So this probe counts rows on both projects over PostgREST, using the service-role keys that
// ARE secrets, and the project refs, which are public constants in AGENTS.md section 3.
//
// WHAT IT CANNOT SEE, stated rather than glossed: PostgREST exposes `public`, so the `au` tables are
// reached through their public views where one exists, and `au.occupancy_history` has none — a
// change confined to it is invisible here. That is a weaker alarm than the reconciler, and a working
// weak alarm beats a perfect one that has never run.
import { existsSync, readFileSync } from "node:fs";

/** AGENTS.md section 3. Public identifiers, not secrets. */
export const PRODUCTION_REF = "ozucdzovmcqvepbozvqf";
export const STAGING_REF = "cifwmndunmlxjhyjugxa";

/**
 * What to count. The public tables the reconciler covers, plus the au views that stand in for its
 * au tables. `dependsOn` is not needed here — nothing is written.
 */
export const TARGETS = [
  { name: "departments", path: "departments" },
  { name: "lines", path: "lines" },
  { name: "areas", path: "areas" },
  { name: "teams", path: "teams" },
  { name: "positions", path: "positions" },
  { name: "employees", path: "employees" },
  { name: "au regions (view)", path: "au_v_regions" },
  { name: "au canonical areas (view)", path: "au_v_canonical_areas" },
  { name: "au line-area map (view)", path: "au_v_line_area_map" },
  { name: "au org tree (view)", path: "au_v_org_tree" },
];

const ENV_FILES = [".env.staging.rls.local", ".env.production.rls.local", ".env.local"];

function envVar(name) {
  if (process.env[name]) return process.env[name];
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.startsWith(`${name}=`)) continue;
      return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

/**
 * An exact count, from PostgREST's Content-Range header.
 *
 * `count=exact` with a zero-row window: the body is empty and the header carries the total, so this
 * never downloads a table to count it. A missing relation answers 404 and is reported as null rather
 * than as zero — a zero would read as "this table is empty on that side", which is a different and
 * much more alarming statement than "I could not see it".
 */
export async function countRows(baseUrl, key, path, fetchImpl = fetch) {
  const res = await fetchImpl(`${baseUrl}/rest/v1/${path}?select=*&limit=0`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact", Range: "0-0" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 160)}`);
  const range = res.headers.get("content-range") ?? "";
  const total = range.split("/")[1];
  if (!total || total === "*") throw new Error(`${path}: no exact count in content-range "${range}"`);
  return Number(total);
}

export function summarize(rows) {
  const drifted = rows.filter((r) => r.production !== r.staging);
  const unreadable = rows.filter((r) => r.production === null || r.staging === null);
  return { drifted, unreadable, inSync: drifted.length === 0 };
}

async function main() {
  const productionKey = envVar("PRODUCTION_SUPABASE_SERVICE_ROLE_KEY") || envVar("SUPABASE_SERVICE_ROLE_KEY");
  const stagingKey = envVar("STAGING_SUPABASE_SERVICE_ROLE_KEY");

  const missing = [
    !productionKey && "PRODUCTION_SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_ROLE_KEY)",
    !stagingKey && "STAGING_SUPABASE_SERVICE_ROLE_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(`cannot compare — missing: ${missing.join(", ")}`);
    process.exit(1);
  }

  const production = `https://${PRODUCTION_REF}.supabase.co`;
  const staging = `https://${STAGING_REF}.supabase.co`;
  console.log(`production ${PRODUCTION_REF} (read only)  vs  staging ${STAGING_REF} (read only)\n`);

  const rows = [];
  for (const target of TARGETS) {
    const [p, s] = await Promise.all([
      countRows(production, productionKey, target.path),
      countRows(staging, stagingKey, target.path),
    ]);
    rows.push({ ...target, production: p, staging: s });
    const mark = p === s ? "in sync" : `DRIFTED  ${p} -> ${s}`;
    console.log(`  ${target.name.padEnd(28)} prod ${String(p ?? "n/a").padStart(5)} | staging ${String(s ?? "n/a").padStart(5)}   ${mark}`);
  }

  const { drifted, unreadable, inSync } = summarize(rows);
  console.log("");
  if (unreadable.length > 0) {
    console.log(`not comparable on one side: ${unreadable.map((r) => r.name).join(", ")}`);
  }
  if (inSync) {
    console.log("STAGING IS IN SYNC on every table this probe can see.");
    process.exit(0);
  }
  console.log(`STAGING HAS DRIFTED on ${drifted.length}: ${drifted.map((r) => `${r.name} (${r.production} vs ${r.staging})`).join(", ")}`);
  console.log("Fix: node scripts/sync-staging-hr.mjs --apply  (needs both database URLs, run by a human)");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("check-staging-drift-rest.mjs")) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
}
