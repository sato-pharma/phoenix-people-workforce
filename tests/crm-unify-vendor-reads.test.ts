import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripSqlComments } from "./support/comment-strip.ts";

// CRM phase 6, part 1: the three database objects the cutover (phase 5) left reading the vendor tables
// directly. Each now reads the unified views, so it keeps working once Phoenix's own visits and plans
// are the record. Pinned from the migration's text because CI never sees the database.

const MIGRATION = "supabase/migrations/20260914000000_crm_unify_vendor_reads.sql";
const CONTACT_MASTER_MIGRATION = "supabase/migrations/20260913150000_crm_contact_master.sql";

/** The whole `create or replace function public.crm_contact_master_refresh(...)` statement. */
function refreshFunction(sql: string): string {
  const start = sql.indexOf("create or replace function public.crm_contact_master_refresh(");
  assert.ok(start >= 0, "the contact master refresh function must be defined");
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, "the contact master refresh function must be closed");
  return sql.slice(start, end + "\n$$;".length);
}

export function runCrmUnifyVendorReadsTests() {
  const raw = readFileSync(MIGRATION, "utf8");
  const code = stripSqlComments(raw);

  // ── 1. The departed-agent scan ────────────────────────────────────────────────────────────────
  const scanStart = code.indexOf("create or replace function public.phx_crm_agent_crm_ids_for_hr_ids(");
  assert.ok(scanStart >= 0, "the departed-agent scan must be redefined");
  const scan = code.slice(scanStart, code.indexOf("$function$;", scanStart));
  assert.match(scan, /from public\.crm_visits_unified v/, "the departed-agent scan reads crm_visits_unified");
  assert.doesNotMatch(scan, /ireports360_/, "the departed-agent scan no longer reads a vendor table");
  assert.match(scan, /returns table\(agent_crm_id bigint\)/, "the scan keeps its signature, so reads.ts needs no change");
  assert.match(
    code,
    /grant execute on function public\.phx_crm_agent_crm_ids_for_hr_ids\(text\[\]\) to service_role/,
    "the scan stays callable by the service role",
  );

  // ── 2. The contact master refresh ─────────────────────────────────────────────────────────────
  // Byte-identical to the function it replaces except for the two activity sources. Anything else
  // changing here is an unreviewed rewrite of the list-history logic.
  const next = refreshFunction(raw);
  const expected = refreshFunction(readFileSync(CONTACT_MASTER_MIGRATION, "utf8"))
    .replace("        from public.ireports360_visits v\n", "        from public.crm_visits_unified v\n")
    .replace("        from public.ireports360_plan_entries p\n", "        from public.crm_plan_entries_unified p\n");
  assert.equal(next, expected, "the refresh changes ONLY its visit and plan sources");
  assert.doesNotMatch(next, /ireports360_(visits|plan_entries)\b/, "the activity pass reads no vendor visit or plan table");
  assert.match(
    next,
    /from public\.ireports360_contacts m/,
    // Why this still holds: the refresh SEEDS the list master from the scrape while the sweep runs, but no report reads the scrape any more — the KPI panels and Reps List read crm_contact_assignments, so switching the sweep off leaves Phoenix's own list as the record.
    "the refresh still seeds rep lists from the scraped vendor list while the vendor sweep runs",
  );

  // ── 3. The check-in flag view ─────────────────────────────────────────────────────────────────
  const viewStart = code.indexOf("create or replace view public.crm_visits_checkin_flags");
  assert.ok(viewStart >= 0, "the check-in flag view must be created");
  const view = code.slice(viewStart, code.indexOf("comment on view public.crm_visits_checkin_flags", viewStart));
  assert.match(view, /security_invoker = true/, "the view can never read more than its caller");
  assert.match(view, /from public\.crm_visits_unified v/, "the flag view is built on the unified visits");
  assert.doesNotMatch(view, /ireports360_/, "the flag view reads no vendor table");
  assert.doesNotMatch(
    view,
    /effective_visit_type|then -8/,
    "a regular visit without a GPS check-in is FLAGGED, never reclassified as campaign (owner decisions 1 and 7)",
  );
  assert.match(view, /\(v\.visit_type = 0 and not ck\.has_checkin\) as regular_no_checkin/, "the flag is regular AND no check-in");
  assert.match(view, /c\.crm_checkin_id = v\.crm_visit_id/, "a Phoenix visit is its own check-in when it captured a fix");
  assert.match(code, /revoke all on table public\.crm_visits_checkin_flags from anon, authenticated/, "no browser role reads the view");
  assert.doesNotMatch(code, /drop view[^;]*ireports360_visits_effective/, "the old view goes with the vendor tables, not here");

  // ── The CRM Master reads the new view ─────────────────────────────────────────────────────────
  const master = readFileSync("src/lib/crm/master.ts", "utf8");
  assert.doesNotMatch(master, /ireports360_visits_effective|reclassified_no_checkin/, "the CRM Master no longer reads the reclassifying view");
  assert.match(master, /q\.eq\("regular_no_checkin", true\)/, "the No Check-in tabs filter on the flag");
}
