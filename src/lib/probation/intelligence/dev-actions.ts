// Probation development actions (Enhancement E1). Wires the probation_development_actions table
// (created in migration 20260713130000, previously unused). Feedback can spawn structured
// development actions ("improve objection handling, owner: TM, due before next DM DV"); later
// feedback marks improvement; the consolidated report + dashboard surface open actions. Read/write
// via the service role (RLS is service-role-only).

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeHrId } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import type { ProbationDevelopmentAction, ProbationDevelopmentActionStatus } from "./types";

type DevActionRow = {
  id: string; case_id: string; dv_day_id: string | null; employee_hr_id: string;
  title: string; description: string | null; owner_hr_id: string | null; due_date: string | null;
  score_category: string | null; status: ProbationDevelopmentActionStatus; follow_up_outcome: string | null;
  created_by: string | null; created_at: string; updated_at: string;
};

const COLS =
  "id, case_id, dv_day_id, employee_hr_id, title, description, owner_hr_id, due_date, " +
  "score_category, status, follow_up_outcome, created_by, created_at, updated_at";

function mapRow(row: DevActionRow): ProbationDevelopmentAction {
  return {
    id: row.id, caseId: row.case_id, dvDayId: row.dv_day_id, employeeHrId: row.employee_hr_id,
    title: row.title, description: row.description, ownerHrId: row.owner_hr_id, dueDate: row.due_date,
    scoreCategory: row.score_category, status: row.status, followUpOutcome: row.follow_up_outcome,
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export type DevelopmentActionInput = {
  title: string;
  description?: string | null;
  ownerHrId?: string | null;
  dueDate?: string | null;
  scoreCategory?: string | null;
};

/** Create development actions attached to a DV-Day / case. Skips entries with no title. Best-effort. */
export async function createDevelopmentActions(
  input: {
    caseId: string | null;
    dvDayId: string | null;
    employeeHrId: string;
    actions: DevelopmentActionInput[];
    createdBy: string | null;
  },
): Promise<number> {
  const rows = (input.actions ?? [])
    .filter((a) => a && typeof a.title === "string" && a.title.trim().length > 0)
    .map((a) => ({
      case_id: input.caseId,
      dv_day_id: input.dvDayId,
      employee_hr_id: input.employeeHrId,
      title: a.title.trim(),
      description: a.description ?? null,
      owner_hr_id: a.ownerHrId ? normalizeHrId(a.ownerHrId) : null,
      due_date: a.dueDate ?? null,
      score_category: a.scoreCategory ?? null,
      status: "open",
      created_by: input.createdBy,
    }));
  if (rows.length === 0) return 0;
  const { data, error } = await getSupabaseAdmin()
    .from("probation_development_actions")
    .insert(rows)
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

/** All development actions for a case, newest first. */
export async function listDevelopmentActionsByCase(caseId: string): Promise<ProbationDevelopmentAction[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("probation_development_actions")
    .select(COLS)
    .eq("case_id", caseId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown as DevActionRow[]).map(mapRow);
}

/**
 * Update a development action's status / follow-up outcome (mark improvement). Authorization is the
 * caller's responsibility (the route requires company-wide probation read, matching the UI gate);
 * `actor` is recorded in the audit log. The write is bounded to the single row by id.
 */
export async function updateDevelopmentAction(
  id: string,
  patch: { status?: ProbationDevelopmentActionStatus; followUpOutcome?: string | null },
  actor?: Pick<AccessContext, "hrId" | "loginId">,
): Promise<ProbationDevelopmentAction> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status) update.status = patch.status;
  if (patch.followUpOutcome !== undefined) update.follow_up_outcome = patch.followUpOutcome;
  const { data, error } = await getSupabaseAdmin()
    .from("probation_development_actions")
    .update(update)
    .eq("id", id)
    .select(COLS)
    .single();
  if (error) throw error;
  const row = mapRow(data as unknown as DevActionRow);
  await writeAuditLog({
    actorLoginId: actor?.loginId ?? normalizeHrId(actor?.hrId ?? null),
    entityType: "probation_development_action",
    entityId: row.id,
    newValues: { status: row.status, followUpOutcome: row.followUpOutcome, caseId: row.caseId },
    summary: `Probation development action updated for ${row.employeeHrId}`,
  }).catch(() => undefined);
  return row;
}
