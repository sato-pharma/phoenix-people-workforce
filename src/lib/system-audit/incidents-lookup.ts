/**
 * System Error & Data Integrity Audit — the two small lookups the Incidents filters need.
 *
 *   · people: a name or HR ID typed into the person box → the people the ledger has recorded, so
 *     the filter sends their canonical keys (the `hrKeys` the page function matches on).
 *   · modules: the distinct sidebar module labels in the chosen period, for the module
 *     multi-select.
 *
 * Both read `system_audit_occurrences` through the service-role client and so run only behind
 * assertSystemAdministratorWorkspaceAccess. A failed read THROWS — the filter then says
 * "Unavailable", never an empty list that reads as "nobody".
 */

import { cairoOffsetMinutes } from "@/lib/format/cairo-zone";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Client = ReturnType<typeof getSupabaseAdmin>;

function client(override?: Client): Client {
  return override ?? getSupabaseAdmin({ requestTimeoutMs: 15_000 });
}

export type AuditPersonOption = { hrKey: string; hrId: string; name: string };

const PEOPLE_SCAN = 400;
const PEOPLE_RETURNED = 25;

/**
 * The typed text as a quoted PostgREST `ilike` pattern. Names and HR IDs never carry the
 * characters PostgREST's `or=` grammar or LIKE treat specially, so those are dropped rather than
 * escaped (a backslash escape inside a quoted PostgREST value is itself consumed by PostgREST).
 */
export function personSearchPattern(text: string): string | null {
  const clean = text.replace(/[,().:"\\%_*]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length < 2) return null;
  return `"*${clean}*"`;
}

export async function lookupAuditPeople(query: string, override?: Client): Promise<AuditPersonOption[]> {
  const text = query.trim();
  if (text.length > 80) throw new Error("Type at most 80 characters to find a person.");
  const pattern = personSearchPattern(text);
  if (!pattern) return [];
  const { data, error } = await client(override)
    .from("system_audit_occurrences")
    .select("hr_key, hr_id_display, employee_name")
    .not("hr_key", "is", null)
    .or(`employee_name.ilike.${pattern},hr_id_display.ilike.${pattern},hr_key.ilike.${pattern}`)
    .order("last_event_at", { ascending: false })
    .limit(PEOPLE_SCAN);
  if (error) throw new Error(`The person lookup failed: ${error.message}`);
  const byKey = new Map<string, AuditPersonOption>();
  for (const row of (data ?? []) as Array<{ hr_key: string | null; hr_id_display: string | null; employee_name: string | null }>) {
    if (!row.hr_key || byKey.has(row.hr_key)) continue;
    byKey.set(row.hr_key, {
      hrKey: row.hr_key,
      hrId: row.hr_id_display?.trim() || row.hr_key.toUpperCase(),
      name: row.employee_name?.trim() || "Name not recorded",
    });
  }
  return Array.from(byKey.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, PEOPLE_RETURNED);
}

/**
 * Cairo midnight of a YYYY-MM-DD, as a UTC instant — the same bound `system_audit_page` computes
 * with `(day::timestamp at time zone 'Africa/Cairo')`. The offset comes from the table that ships
 * with the code (cairo-zone.ts), never from the engine.
 */
export function cairoDayStartIso(day: string): string {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  // Two passes: the offset at "midnight UTC minus two hours" decides the instant, and the offset
  // AT that instant confirms it (Egypt is UTC+2 in winter, UTC+3 in summer).
  let instant = utcMidnight - cairoOffsetMinutes(new Date(utcMidnight - 2 * 3_600_000)) * 60_000;
  instant = utcMidnight - cairoOffsetMinutes(new Date(instant)) * 60_000;
  return new Date(instant).toISOString();
}

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export type AuditModuleOptions = { labels: string[] };

const MODULE_BATCH = 1000;
const MODULE_ROUND_TRIPS = 120;

/**
 * Distinct module labels in the period, by skipping ahead: each call reads the next labels in
 * order and the following call starts AFTER the last label seen, so a module with 50,000 rows
 * costs one call, not fifty. Throws rather than returning a partial list.
 */
export async function listAuditModuleLabels(
  period: { from?: string | null; to?: string | null; includeTest?: boolean },
  override?: Client,
): Promise<AuditModuleOptions> {
  const supabase = client(override);
  const labels = new Set<string>();
  let after: string | null = null;
  for (let trip = 0; trip < MODULE_ROUND_TRIPS; trip += 1) {
    let request = supabase.from("system_audit_occurrences").select("module_label");
    if (period.from) request = request.gte("occurred_at", cairoDayStartIso(period.from));
    if (period.to) request = request.lt("occurred_at", cairoDayStartIso(nextDay(period.to)));
    if (!period.includeTest) request = request.eq("is_test", false);
    if (after !== null) request = request.gt("module_label", after);
    const { data, error } = await request.order("module_label", { ascending: true }).limit(MODULE_BATCH);
    if (error) throw new Error(`The module list could not be read: ${error.message}`);
    const rows = (data ?? []) as Array<{ module_label: string }>;
    if (rows.length === 0) return { labels: Array.from(labels) };
    for (const row of rows) labels.add(row.module_label);
    after = rows[rows.length - 1].module_label;
    if (rows.length < MODULE_BATCH) return { labels: Array.from(labels) };
  }
  throw new Error(`The module list has more than ${MODULE_ROUND_TRIPS} pages of labels; narrow the dates to list them.`);
}
