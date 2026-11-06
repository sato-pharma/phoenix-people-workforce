// Daily Deductions module: employee-portal read path (self-only).
//
// WIRED to the employee's Deductions page (app/employee-portals/deductions/page.tsx) since
// 2026-11-07 — owner, asked whether the release email's "Open your Deductions page" should lead to
// the released lines: "Show daily lines". Only RELEASED lines reach it (the active snapshot; a
// withdrawn line is deleted from it), never the running tally the Super Admin computes.
//
// SELF-ONLY FOR EVERY ROLE, exactly as the month module's getPortalDeductions
// (owner, 2026-08-06: "everyone can only see his deductions only"). A deduction
// figure is financial AND disciplinary PII derived from base salary; a manager
// who needs a subordinate's figure asks HR. Only the system scope reads all.

import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import { getActiveDailyPublication, mapDailyLineRow, mapDailyPortalLine } from "./service.ts";
import type { DailyDeductionsPortalLine } from "./types.ts";

/** Self-only for every role; the system scope reads all. Mirrors the month module. */
export function collectDailyPortalScope(input: { access: AccessContext }): {
  all: boolean;
  compactHrIds: Set<string>;
} {
  if (input.access.scope === "system") return { all: true, compactHrIds: new Set<string>() };
  const root = compactDeductionsHrId(input.access.hrId ?? input.access.loginId);
  return { all: false, compactHrIds: new Set<string>(root ? [root] : []) };
}

export function sortDailyPortalLines(lines: DailyDeductionsPortalLine[]): DailyDeductionsPortalLine[] {
  return [...lines].sort((a, b) => {
    const nameCompare = String(a.employeeName ?? "").localeCompare(String(b.employeeName ?? ""));
    if (nameCompare !== 0) return nameCompare;
    return a.category.localeCompare(b.category);
  });
}

export type PortalDailyPublicationRef = {
  id: string;
  rangeStart: string;
  rangeEnd: string;
};

/**
 * The lines of the single active (published, not superseded) snapshot, scoped to
 * the caller. Returns an empty list when nothing is currently published.
 */
export async function getPortalDailyDeductions(input: {
  access: AccessContext;
}): Promise<{ publication: PortalDailyPublicationRef | null; lines: DailyDeductionsPortalLine[] }> {
  const publication = await getActiveDailyPublication();
  if (!publication) return { publication: null, lines: [] };

  const supabase = getSupabaseAdmin();
  const rows = await fetchAllRows<Record<string, unknown>>(
    () => supabase.from("daily_deductions_lines").select("*").eq("publication_id", publication.id),
    "id",
  );
  const allLines = rows.map(mapDailyLineRow).map((row) => mapDailyPortalLine(row, publication));

  const scope = collectDailyPortalScope({ access: input.access });
  const scoped = scope.all ? allLines : allLines.filter((line) => scope.compactHrIds.has(line.employeeHrIdCompact));

  return {
    publication: { id: publication.id, rangeStart: publication.rangeStart, rangeEnd: publication.rangeEnd },
    lines: sortDailyPortalLines(scoped),
  };
}
