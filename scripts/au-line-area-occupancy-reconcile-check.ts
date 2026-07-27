import { readFileSync } from "node:fs";

import { getSupabaseAdmin } from "../src/lib/supabase/server.ts";

// Read-only reconciliation tripwire for the "vacated area still reads as staffed" bug
// (six rep seats vacated across July 2026 kept au.line_area_map.area_state = 'occupied'
// until they were corrected by hand on 2026-07-27).
//
// The org model carries TWO independent vacancy representations:
//   * public.position_vacancies      — maintained by the resignation flow and by the
//                                      employees lifecycle triggers.
//   * au.line_area_map.area_state
//     + au.occupancy_history         — the sales-side seat model.
// The second pair only stayed consistent because a human noticed. This script is the
// machine that notices instead. It changes nothing: it selects from the
// public.au_v_line_area_occupancy_drift wrapper view (a bare SELECT over
// au.f_line_area_occupancy_drift()) and exits non-zero if that view returns any row.
//
// Drift kinds it reports:
//   occupied_but_seat_vacant        the reported bug — area says staffed, seat is empty
//   vacant_but_seat_occupied        the inverse — hired without releasing the vacancy
//   staffable_row_without_rep_seat  no rep seat to reconcile against (reads clean, isn't)
//   other_row_with_rep_seat         an Others area acquired a rep seat (modelling error)
//   rep_seat_absent_from_map        a REP seat no open map row points at
//
// Which project it checks is decided entirely by the env it runs with — the same
// NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY pair the app uses. Point it at
// staging or production deliberately; it prints the host it read so the output is never
// ambiguous about which database was checked.

type DriftRow = {
  area_code: string | null;
  area_state: string | null;
  detail: string | null;
  drift_kind: string;
  line_code: string | null;
  occupant_hr_id: string | null;
  rep_seat_id: string | null;
};

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

function projectHost(): string {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").host || "(unset)";
  } catch {
    return "(unparseable NEXT_PUBLIC_SUPABASE_URL)";
  }
}

async function main() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("au_v_line_area_occupancy_drift")
    .select("drift_kind,line_code,area_code,area_state,rep_seat_id,occupant_hr_id,detail");

  if (error) {
    // Distinguish "the guard cannot run" from "the guard passed". A missing view means
    // 20260727234500_au_area_state_follows_seat_occupancy.sql has not been applied to
    // this project yet — that is a failure to report, never a silent green.
    const missing = /could not find the table|does not exist|schema cache/i.test(error.message);
    console.error(JSON.stringify({
      checked_host: projectHost(),
      error: error.message,
      hint: missing
        ? "public.au_v_line_area_occupancy_drift is absent — apply supabase/migrations/20260727234500_au_area_state_follows_seat_occupancy.sql to this project first."
        : undefined,
      ok: false,
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const rows = (data ?? []) as DriftRow[];
  const byKind = new Map<string, number>();
  for (const row of rows) byKind.set(row.drift_kind, (byKind.get(row.drift_kind) ?? 0) + 1);

  console.log(JSON.stringify({
    checked_host: projectHost(),
    counts_by_kind: Object.fromEntries(byKind),
    drift: rows,
    ok: rows.length === 0,
    source: "read-only select from public.au_v_line_area_occupancy_drift (au.f_line_area_occupancy_drift())",
    summary: rows.length === 0
      ? "au.line_area_map.area_state is consistent with au.occupancy_history."
      : `${rows.length} row(s) drifted — a vacated area reads as staffed (or the reverse) in the sales territory views.`,
  }, null, 2));

  if (rows.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), ok: false }, null, 2));
  process.exitCode = 1;
});
