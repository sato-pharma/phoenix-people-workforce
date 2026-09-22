// Unified Deductions module: the ACTIVE pushed lines for a month.
//
// One deliberately lean reader, shared by two very different callers:
//   * the Automated Payroll bridge (deductions-source.ts), the hot path that
//     decides real money — it must not transitively import the notification /
//     CRM-org graph that push.ts pulls in, so the "which candidates are pushed"
//     query lives HERE, next to nothing;
//   * the admin candidates route and workspace, to show which candidates have
//     already been pushed (and the line id needed to withdraw one).
//
// This file's only dependencies are the Supabase admin client and the month-key
// normalizer — nothing else, on purpose.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { normalizeMonthKey } from "./candidate-key.ts";

/** One currently-released line: enough to gate payroll and to withdraw it. */
export type ActivePushedLine = {
  lineId: string;
  candidateId: string;
  employeeHrIdCompact: string;
  publicationId: string;
};

type ActiveLineRow = {
  id: string;
  publication_id: string;
  candidate_id: string;
  employee_hr_id_compact: string;
};

/**
 * The active (line_status='active') publication lines for a month, restricted to
 * the live status='published' publication(s).
 *
 * Joined through published publications exactly as the portal read does, rather
 * than trusting line_status alone: a legacy wholesale REpublish supersedes its
 * prior publication but leaves that publication's 'active' lines in place, so a
 * bare month_key + line_status filter would resurrect a stale line. For months
 * from the push cutover onward there is only ever one published publication, but
 * mirroring the portal keeps the two read paths provably identical.
 */
export async function loadActivePushedLines(monthKey: string): Promise<ActivePushedLine[]> {
  const normalized = normalizeMonthKey(monthKey);
  const supabase = getSupabaseAdmin();

  const { data: pubs, error: pubsError } = await supabase
    .from("deductions_publications")
    .select("id")
    .eq("month_key", normalized)
    .eq("status", "published");
  if (pubsError) throw new Error(`Failed to load publications for ${normalized}: ${pubsError.message}`);

  const publicationIds = ((pubs ?? []) as Array<{ id: string }>).map((p) => p.id);
  if (publicationIds.length === 0) return [];

  const rows = await fetchAllRows<ActiveLineRow>(
    () =>
      supabase
        .from("deductions_publication_lines")
        .select("id, publication_id, candidate_id, employee_hr_id_compact")
        .in("publication_id", publicationIds)
        .eq("line_status", "active"),
    "id",
  );

  return rows.map((row) => ({
    lineId: row.id,
    candidateId: row.candidate_id,
    employeeHrIdCompact: row.employee_hr_id_compact,
    publicationId: row.publication_id,
  }));
}

/** The candidate ids currently pushed (released) for a month — the payroll gate. */
export async function loadActivePushedCandidateIds(monthKey: string): Promise<Set<string>> {
  const lines = await loadActivePushedLines(monthKey);
  return new Set(lines.map((line) => line.candidateId));
}

/** candidateId → active line id, for surfacing "already pushed" and its withdraw target. */
export async function loadActivePushedLineIdByCandidate(monthKey: string): Promise<Map<string, string>> {
  const lines = await loadActivePushedLines(monthKey);
  const map = new Map<string, string>();
  for (const line of lines) map.set(line.candidateId, line.lineId);
  return map;
}
