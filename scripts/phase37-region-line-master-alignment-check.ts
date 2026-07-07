import { readFileSync } from "node:fs";

import postgres from "postgres";

import { bridgeEmployeeLineToOfficial, OFFICIAL_LINE_VALUES } from "../src/lib/sales/access-scope.ts";

// Read-only early-warning tripwire for the area/region/line unification-revert incident
// (2026-07-02 through 2026-07-07). Sales scope (District Manager / Regional Manager region
// scoping, and every line-scoped role: NSM/PM/GPM/RM/DM/Marketing Manager) resolves geography
// through free-text `region_name` / `lines.name` matched against master tables — by design, a
// resolution failure fails CLOSED (empty dashboard), not open (a leak). That is the correct
// security posture, but it means drift is SILENT: nobody sees an error, a manager just sees an
// empty screen. This script catches that drift before a user reports it. It changes nothing —
// pure read-only comparison against the same master tables/constants the runtime code uses.

type Row = Record<string, unknown>;

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

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!dbUrl) throw new Error("SUPABASE_DB_URL is required");

  const sql = postgres(dbUrl, { max: 1, prepare: false, ssl: "require" });

  try {
    // ── 1. District Manager region_name → master (BLOCKING) ──────────────────────────────
    // A DSM's OWN region_name IS the scope source (see access-scope.ts's `regionScoped`
    // set) — a mismatch here silently empties that manager's Source-of-Sales dashboard
    // today, with zero other symptom. Regional Manager is deliberately EXCLUDED: an RM's
    // scope is resolved from his reporting subtree (resolveRegionalManagerRegionCodes), not
    // his own region_name label — his own label is legitimately descriptive (e.g. "Alexandria
    // + Delta" for a combined territory) and is reported informationally below, not as a
    // failure, since this script can't cheaply re-derive subtree-based correctness.
    const dsmMismatches = await sql<Row[]>`
      select e.hr_id, e.full_name, au.role, e.region_name
      from employees e
      join app_auth_users au on lower(btrim(au.login_id)) = lower(btrim(e.hr_id))
      where au.role = 'District Manager'
        and lower(coalesce(e.employment_status, 'active')) in ('active', 'on_leave')
        and (
          e.region_name is null
          or btrim(e.region_name) = ''
          or not exists (
            select 1 from source_of_sales_regions r
            where r.active and lower(btrim(r.region_name)) = lower(btrim(e.region_name))
          )
        )
      order by e.hr_id
    `;

    // Informational: Regional Managers whose own label doesn't match the master. Expected
    // for a combined-territory RM (subtree resolution still works) — listed for visibility.
    const rmOwnLabelGaps = await sql<Row[]>`
      select e.hr_id, e.full_name, e.region_name
      from employees e
      join app_auth_users au on lower(btrim(au.login_id)) = lower(btrim(e.hr_id))
      where au.role = 'Regional Manager'
        and lower(coalesce(e.employment_status, 'active')) in ('active', 'on_leave')
        and (
          e.region_name is null
          or btrim(e.region_name) = ''
          or not exists (
            select 1 from source_of_sales_regions r
            where r.active and lower(btrim(r.region_name)) = lower(btrim(e.region_name))
          )
        )
      order by e.hr_id
    `;

    // ── 2. Every org line bridges to a canonical official line (BLOCKING) ────────────────
    // If a `lines.name` value doesn't bridge to one of the 4 canonical lines, every
    // line-scoped role assigned to that line (NSM/PM/GPM/RM/DM) sees empty data for it.
    const orgLines = await sql<{ name: string }[]>`select distinct name from lines where name is not null`;
    const unbridgedLines = orgLines
      .map((row) => ({ name: row.name, bridged: bridgeEmployeeLineToOfficial(row.name) }))
      .filter((entry) => !entry.bridged || !OFFICIAL_LINE_VALUES.includes(entry.bridged));

    // ── 3. Product Master `line` values are all canonical (BLOCKING) ─────────────────────
    // Defense-in-depth alongside the write-time allow-list added to the Product Master
    // importer: catches rows that predate the gate, or any direct-DB write that bypassed it.
    // "IGNORE" is a deliberate code-defined sentinel (product_code=line='IGNORE', name
    // "Ignored — not a Phoenix product" — see the normalizer_ignore_product_sentinel
    // migration) marking a row as excluded from real sales, not a mislabeled line.
    const IGNORED_LINE_SENTINELS = ["IGNORE"];
    const productLines = await sql<{ line: string }[]>`
      select distinct line from source_of_sales_products where active and line is not null
    `;
    const rogueProductLines = productLines
      .map((row) => row.line)
      .filter((line) => !OFFICIAL_LINE_VALUES.includes(line) && !IGNORED_LINE_SENTINELS.includes(line));

    // ── 4. Rollup `official_line` values are all canonical (BLOCKING) ────────────────────
    // This is exactly the column the Head Office confidentiality strip reads
    // (isHeadOfficeLine) — an unrecognized value here is the actual leak scenario.
    const rollupLines = await sql<{ official_line: string }[]>`
      select distinct official_line from source_of_sales_fact_rollup where official_line is not null
    `;
    const rogueRollupLines = rollupLines
      .map((row) => row.official_line)
      .filter((line) => !OFFICIAL_LINE_VALUES.includes(line));

    // ── 5. Informational only — NOT a failure ────────────────────────────────────────────
    // NSM/PM/GPM/CEO/Marketing Manager don't region-scope (see access-scope.ts:272-274), so a
    // region_name that doesn't match the master (e.g. "Egypt", "Head office") is expected and
    // harmless for these roles. Reported for visibility only.
    const nonRegionScopedGaps = await sql<Row[]>`
      select e.hr_id, au.role, e.region_name, count(*) over (partition by au.role) as role_count
      from employees e
      join app_auth_users au on lower(btrim(au.login_id)) = lower(btrim(e.hr_id))
      join lines l on l.id = e.line_id and l.code in ('anti_infective', 'pedia', 'cns')
      where au.role not in ('District Manager', 'Regional Manager')
        and lower(coalesce(e.employment_status, 'active')) in ('active', 'on_leave')
        and (
          e.region_name is null
          or btrim(e.region_name) = ''
          or not exists (
            select 1 from source_of_sales_regions r
            where r.active and lower(btrim(r.region_name)) = lower(btrim(e.region_name))
          )
        )
      order by au.role, e.hr_id
    `;

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
      source: "read-only comparison of employees/lines/source_of_sales_* against access-scope.ts's canonical constants",
    }, null, 2));

    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
