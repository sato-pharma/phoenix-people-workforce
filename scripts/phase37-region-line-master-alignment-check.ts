import { readFileSync } from "node:fs";

import { getSupabaseAdmin } from "../src/lib/supabase/server.ts";
import { bridgeEmployeeLineToOfficial, OFFICIAL_LINE_VALUES } from "../src/lib/sales/access-scope.ts";

// Read-only early-warning tripwire for the area/region/line unification-revert incident
// (2026-07-02 through 2026-07-07). Sales scope (District Manager region scoping, and every
// line-scoped role: NSM/PM/GPM/RM/DM/Marketing Manager) resolves geography through free-text
// `region_name` / `lines.name` matched against master tables — by design, a resolution failure
// fails CLOSED (empty dashboard), not open (a leak). That is the correct security posture, but
// it means drift is SILENT: nobody sees an error, a manager just sees an empty screen. This
// script catches that drift before a user reports it. It changes nothing — pure read-only
// comparison against the same master tables/constants the runtime code uses.
//
// Uses the app's own Supabase admin client (service-role key) rather than a raw Postgres
// connection — every table this script reads (employees, lines, app_auth_users,
// source_of_sales_*) is a normal PostgREST-exposed table, so it needs only the same
// NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY the app itself uses locally, not a
// separate SUPABASE_DB_URL connection string.

type Row = Record<string, unknown>;

const IGNORED_LINE_SENTINELS = ["IGNORE"];
const PAGE_SIZE = 1000;
const SALES_LINE_CODES = ["anti_infective", "pedia", "cns"];

function loadLocalEnv() {
  try {
    const text = readFileSync(".env.local", "utf8");
    for (const line of text.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // Environment variables may be injected by the runner.
  }
}

loadLocalEnv();

/** Pages through a table with `.range()` so a table that grows past PostgREST's default
 *  row cap is never silently truncated (the exact failure mode this script exists to catch
 *  elsewhere — see the organogram-audit "PostgREST 1000-row cap" finding this session).
 *  `orderColumn` must be the table's unique key, so the walk skips and repeats no row. */
async function fetchAll(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  table: string,
  select: string,
  orderColumn: string,
  eqFilter?: { column: string; value: unknown },
): Promise<Row[]> {
  const rows: Row[] = [];
  let from = 0;
  for (;;) {
    let query = supabase.from(table).select(select).order(orderColumn, { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (eqFilter) query = query.eq(eqFilter.column, eqFilter.value);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

function normalizeKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isActiveStatus(value: unknown): boolean {
  const status = normalizeKey(value) || "active";
  return status === "active" || status === "on_leave";
}

async function main() {
  const supabase = getSupabaseAdmin();

  const [authUsers, employees, regions, orgLines] = await Promise.all([
    fetchAll(supabase, "app_auth_users", "login_id, role", "login_id"),
    fetchAll(supabase, "employees", "hr_id, full_name, employment_status, region_name, line_id", "hr_id"),
    fetchAll(supabase, "source_of_sales_regions", "region_name", "region_code", { column: "active", value: true }),
    fetchAll(supabase, "lines", "id, code, name", "id"),
  ]);

  // ── 3 & 4: rogue line labels — bounded existence queries, not full-table enumeration.
  // These two source tables can be large (sales fact/product data); we only need to know IF
  // an out-of-list value exists and see a few examples, not page through every row.
  const excludedProductValues = [...OFFICIAL_LINE_VALUES, ...IGNORED_LINE_SENTINELS];
  const { data: rogueProductRows, error: productError } = await supabase
    .from("source_of_sales_products")
    .select("line")
    .eq("active", true)
    .not("line", "is", null)
    .not("line", "in", `(${excludedProductValues.join(",")})`)
    .limit(50);
  if (productError) throw new Error(`source_of_sales_products: ${productError.message}`);

  const { data: rogueRollupRows, error: rollupError } = await supabase
    .from("source_of_sales_fact_rollup")
    .select("official_line")
    .not("official_line", "is", null)
    .not("official_line", "in", `(${OFFICIAL_LINE_VALUES.join(",")})`)
    .limit(50);
  if (rollupError) throw new Error(`source_of_sales_fact_rollup: ${rollupError.message}`);

  const rogueProductLines = Array.from(new Set((rogueProductRows ?? []).map((row) => String(row.line))));
  const rogueRollupLines = Array.from(new Set((rogueRollupRows ?? []).map((row) => String(row.official_line))));

  // ── 2: every org line bridges to a canonical official line (BLOCKING) ──────────────────
  const distinctOrgLineNames = Array.from(new Set(orgLines.map((row) => String(row.name ?? "")).filter(Boolean)));
  const unbridgedLines = distinctOrgLineNames
    .map((name) => ({ name, bridged: bridgeEmployeeLineToOfficial(name) }))
    .filter((entry) => !entry.bridged || !OFFICIAL_LINE_VALUES.includes(entry.bridged));

  const salesLineIds = new Set(
    orgLines.filter((row) => SALES_LINE_CODES.includes(String(row.code))).map((row) => row.id),
  );
  const roleByHrKey = new Map(authUsers.map((row) => [normalizeKey(row.login_id), String(row.role)]));
  const regionNameSet = new Set(regions.map((row) => normalizeKey(row.region_name)));

  function regionMatchesMaster(regionName: unknown): boolean {
    const key = normalizeKey(regionName);
    return Boolean(key) && regionNameSet.has(key);
  }

  // ── 1: District Manager region_name → master (BLOCKING); Regional Manager and everyone
  // else are informational only (see comments on the constants above). Single pass over
  // employees, matching the semantics of the original SQL exactly.
  const dsmMismatches: Row[] = [];
  const rmOwnLabelGaps: Row[] = [];
  const nonRegionScopedGaps: Row[] = [];

  for (const emp of employees) {
    if (!isActiveStatus(emp.employment_status)) continue;
    const role = roleByHrKey.get(normalizeKey(emp.hr_id));
    if (!role) continue;
    if (regionMatchesMaster(emp.region_name)) continue;

    const entry = { hr_id: emp.hr_id, full_name: emp.full_name, region_name: emp.region_name };
    if (role === "District Manager") {
      dsmMismatches.push(entry);
    } else if (role === "Regional Manager") {
      rmOwnLabelGaps.push(entry);
    } else if (salesLineIds.has(emp.line_id)) {
      nonRegionScopedGaps.push({ ...entry, role });
    }
  }

  const checks = [
    { details: dsmMismatches, label: "Every active District Manager's region_name matches the Source-of-Sales region master", ok: dsmMismatches.length === 0 },
    { details: unbridgedLines, label: "Every org line bridges to a canonical official line", ok: unbridgedLines.length === 0 },
    { details: rogueProductLines, label: "Every active Product Master line value is canonical (or a known sentinel)", ok: rogueProductLines.length === 0 },
    { details: rogueRollupLines, label: "Every rollup official_line value is canonical (Head Office strip integrity)", ok: rogueRollupLines.length === 0 },
  ];

  console.log(JSON.stringify({
    checks,
    informational: {
      non_region_scoped_gaps: nonRegionScopedGaps,
      regional_manager_own_label_gaps: rmOwnLabelGaps,
    },
    note: "Informational entries are NOT failures — NSM/PM/GPM/CEO/MM don't region-scope by design, and an RM's own region_name is a descriptive label, not his scope source (subtree-resolved).",
    source: "read-only comparison of employees/lines/source_of_sales_* against access-scope.ts's canonical constants, via the app's own Supabase admin client",
  }, null, 2));

  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
