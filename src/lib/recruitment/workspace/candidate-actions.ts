// Recruitment workspace — the writes a row's own buttons make: file a person in a tab (or take them
// out), log a call, archive, and reject with a reason.
//
// WHO MAY. Every function here asks `workspaceViewer` first and refuses anyone who only READS the
// workspace — the CEO reads it under its own named gate and must never write through it (role-tabs.ts).
// The route already asked `candidates: update`; this is the second lock, so a future caller that
// forgets the route's gate still cannot write. And the Talent Acquisition seat cannot FILE anyone into
// the two HR tabs she does not see: a placement there would hide that person from her on the next
// read, which is a way to make a CV vanish from her own queue.
//
// THE REJECTION REASON (owner, 2026-10-20, #24: "a rejection reason from a fixed list … it makes
// rejections countable"). The status move is the existing one — `updateCandidateStatus`, with its
// refusal rules and its history row — and the reason rides beside it in its own two columns, so a
// report can count by reason without parsing a note. The status note carries the reason in words
// too, so every older screen that prints the note still says why. The sorry message is NOT sent
// here: it is a separate call the screen makes only after the 10-second Undo has passed.
//
// Every write also leaves an audit row — these change who sees a person, and why they were turned
// away, the questions an audit is asked. BEST-EFFORT (`writeAuditLog`, which logs its own failure
// loudly), because the write has already committed by then and carries its own who-and-when (the
// status history, `placed_by_hr_id`, the call's `hr_id`, `archived_by`): a missing audit row must not
// tell the screen a reject failed that in fact happened, and invite a second press.

import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { hrIdForStorage } from "@/lib/hr-id";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { bulkUpdateCandidateStatus, updateCandidateStatus } from "@/lib/recruitment/candidates";
import { bulkDecisionRefusal } from "@/lib/recruitment/candidate-status";
import { chunkIds, fetchRowsInBatches } from "@/lib/recruitment/db-batch";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { familiesForTab } from "@/lib/recruitment/workspace/answer-chips";
import { recomputeCompleteness } from "@/lib/recruitment/workspace/completeness";
import { validRegionCode } from "@/lib/recruitment/workspace/placement-from-reply";
import { listPlacementsFor, removePlacement, upsertPlacement } from "@/lib/recruitment/workspace/placements-db";
import { findWorkspaceArea } from "@/lib/recruitment/workspace/places";
import { rejectionStatusNote } from "@/lib/recruitment/workspace/rejection";
import {
  isWorkspaceRoleTab,
  roleTabForFamily,
  tabsWithAreas,
  tabsWithRegions,
  workspaceRoleTabLabels,
  workspaceViewer,
  type WorkspaceRoleTab,
  type WorkspaceViewer,
} from "@/lib/recruitment/workspace/role-tabs";
import { toWorkspacePlacement } from "@/lib/recruitment/workspace/rows-db";
import type { WorkspacePlacement, WorkspaceRow } from "@/lib/recruitment/workspace/types";
import {
  callResultLabels,
  isCallResult,
  rejectionReasonLabels,
  rejectionRefusal,
  type CallResult,
  type RejectionReason,
} from "@/lib/recruitment/workspace/vocabulary";

const AUDIT_ENTITY = "recruitment_candidate" as const;
/** A call note, as the table's CHECK holds it. */
export const CALL_NOTE_MAX_LENGTH = 300;

// ---------------------------------------------------------------------------------------------
// Who may write
// ---------------------------------------------------------------------------------------------

/** The viewer, when they WORK the workspace; a 403 for anyone who only reads it (the CEO) or neither. */
export function assertWorkspaceWorker(access: AccessContext): WorkspaceViewer {
  const viewer = workspaceViewer(access);
  if (!viewer.canWork) throw forbiddenError("Only the recruitment team can change a CV here.");
  return viewer;
}

/** Why this viewer may not file people in this tab, or null when they may. */
export function placementTabRefusal(viewer: WorkspaceViewer, roleTab: string): string | null {
  if (!isWorkspaceRoleTab(roleTab)) return "Choose one of the role tabs.";
  if (!viewer.roleTabs.includes(roleTab)) return "You cannot file a CV in that tab.";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------------------------

export type PlacementInput = {
  roleTab: string;
  regionCode?: string | null;
  areaCode?: string | null;
};

async function placementsOf(candidateId: string): Promise<WorkspacePlacement[]> {
  const records = (await listPlacementsFor([candidateId])).get(candidateId) ?? [];
  const names = await namesByHrId(records.map((record) => record.placedByHrId));
  return records.map((record) => toWorkspacePlacement(record, (hrId) => names.get(hrId)));
}

/** A recompute that fails leaves the old numbers; it never fails the write it follows. */
async function recomputeQuietly(candidateIds: string[]): Promise<void> {
  try {
    await recomputeCompleteness(candidateIds);
  } catch (error) {
    logError("Recruitment completeness recompute failed after a workspace write", {
      context: { candidateCount: candidateIds.length },
      error,
      labels: { event: "recruitment_workspace_completeness_recompute_failed" },
    });
  }
}

/**
 * HR files a person in a tab — with a region (District Manager, Medical Rep) and an area (Medical
 * Rep) where the tab has them. The area decides the region: an area always sits under the region the
 * bot files it under, so a mismatched pair can never be stored. Adds to the person's tabs; taking them
 * out of another tab is its own act (`unplaceCandidate`). HR's row wins over the bot's from then on.
 */
export async function placeCandidate(
  access: AccessContext,
  candidateId: string,
  input: PlacementInput,
): Promise<WorkspacePlacement[]> {
  const viewer = assertWorkspaceWorker(access);
  const refusal = placementTabRefusal(viewer, input.roleTab);
  if (refusal) throw validationError(refusal);
  const roleTab = input.roleTab as WorkspaceRoleTab;

  const { data: candidate, error } = await recruitmentDb()
    .from("ats_candidates")
    .select("id,declared_role_family")
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw error;
  if (!candidate) throw notFoundError("Candidate not found.");

  let regionCode: string | null = null;
  let areaCode: string | null = null;
  let areaName: string | null = null;
  const rawArea = textOrNull(input.areaCode);
  const rawRegion = textOrNull(input.regionCode);
  if (rawArea) {
    if (!tabsWithAreas.includes(roleTab)) throw validationError("Only a Medical Rep is filed under an area.");
    const area = await findWorkspaceArea(rawArea);
    if (!area) throw validationError("That area is not one of the company's active areas.");
    areaCode = area.code;
    areaName = area.name;
    regionCode = validRegionCode(area.regionCode);
  } else if (rawRegion) {
    if (!tabsWithRegions.includes(roleTab)) throw validationError("This tab is not split by region.");
    regionCode = validRegionCode(rawRegion);
    if (!regionCode) throw validationError("That is not one of the recruitment regions.");
  }

  // The role inside the tab: a one-role tab says it; a shared tab keeps what the bot recorded, else
  // the role the applicant declared when it belongs to this tab.
  const existing = ((await listPlacementsFor([candidateId])).get(candidateId) ?? []).find((row) => row.roleTab === roleTab);
  const families = familiesForTab(roleTab) ?? [];
  const declared = textOrNull((candidate as { declared_role_family?: unknown }).declared_role_family);
  const botRoleFamily =
    families.length === 1
      ? families[0]
      : (existing?.botRoleFamily ?? (declared && roleTabForFamily(declared) === roleTab ? declared : null));

  const actorHrId = hrIdForStorage(access.hrId);
  await upsertPlacement({
    areaCode,
    areaName,
    botRoleFamily,
    candidateId,
    placedBy: "hr",
    placedByHrId: actorHrId,
    regionCode,
    roleTab,
  });
  await writeAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: candidateId,
    entityType: AUDIT_ENTITY,
    newValues: { action: "placed", areaCode, regionCode, roleTab },
    oldValues: existing ? { areaCode: existing.areaCode, regionCode: existing.regionCode, roleTab } : null,
    summary: `Filed a CV in ${workspaceRoleTabLabels[roleTab]}${areaName ? ` · ${areaName}` : ""}`,
  });
  await recomputeQuietly([candidateId]);
  return placementsOf(candidateId);
}

/** HR takes a person out of one tab. Out of every tab, they wait in Needs placing. */
export async function unplaceCandidate(
  access: AccessContext,
  candidateId: string,
  roleTabRaw: string,
): Promise<WorkspacePlacement[]> {
  const viewer = assertWorkspaceWorker(access);
  const refusal = placementTabRefusal(viewer, roleTabRaw);
  if (refusal) throw validationError(refusal);
  const roleTab = roleTabRaw as WorkspaceRoleTab;
  const existing = ((await listPlacementsFor([candidateId])).get(candidateId) ?? []).find((row) => row.roleTab === roleTab);
  if (existing) {
    await removePlacement(candidateId, roleTab);
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: candidateId,
      entityType: AUDIT_ENTITY,
      newValues: { action: "unplaced", roleTab },
      oldValues: { areaCode: existing.areaCode, placedBy: existing.placedBy, regionCode: existing.regionCode, roleTab },
      summary: `Took a CV out of ${workspaceRoleTabLabels[roleTab]}`,
    });
    await recomputeQuietly([candidateId]);
  }
  return placementsOf(candidateId);
}

// ---------------------------------------------------------------------------------------------
// Call results
// ---------------------------------------------------------------------------------------------

/** One tap on the call bar — "No answer", "Interested", … — kept as a log, newest shown. */
export async function recordCallResult(
  access: AccessContext,
  candidateId: string,
  resultRaw: string,
  noteRaw?: string | null,
): Promise<NonNullable<WorkspaceRow["latestCall"]>> {
  assertWorkspaceWorker(access);
  if (!isCallResult(resultRaw)) throw validationError("Choose what the call came to.");
  const result: CallResult = resultRaw;
  const note = textOrNull(noteRaw);
  if (note && note.length > CALL_NOTE_MAX_LENGTH) {
    throw validationError(`Keep the note to ${CALL_NOTE_MAX_LENGTH} characters.`);
  }
  const actorHrId = hrIdForStorage(access.hrId);
  const { data, error } = await recruitmentDb()
    .from("ats_candidate_call_results")
    .insert({ candidate_id: candidateId, hr_id: actorHrId, note, result })
    .select("result,note,hr_id,created_at")
    .single();
  if (error) throw error;
  await writeAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: candidateId,
    entityType: AUDIT_ENTITY,
    newValues: { action: "call_result", note, result },
    summary: `Logged a call: ${callResultLabels[result]}`,
  });
  const row = data as { result: string; note: string | null; hr_id: string | null; created_at: string };
  const names = await namesByHrId([row.hr_id]);
  return { at: row.created_at, byName: names.get(row.hr_id), note: row.note, result };
}

// ---------------------------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------------------------

/** Moves a CV to the archive (out of every tab, kept and searchable) or brings it back. */
export async function setCandidateArchived(
  access: AccessContext,
  candidateId: string,
  archived: boolean,
): Promise<{ archivedAt: string | null }> {
  assertWorkspaceWorker(access);
  const actorHrId = hrIdForStorage(access.hrId);
  const now = new Date().toISOString();
  const { data, error } = await recruitmentDb()
    .from("ats_candidates")
    .update({ archived_at: archived ? now : null, archived_by: archived ? actorHrId : null, updated_at: now })
    .eq("id", candidateId)
    .select("archived_at")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("Candidate not found.");
  await writeAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: candidateId,
    entityType: AUDIT_ENTITY,
    newValues: { action: archived ? "archived" : "unarchived" },
    summary: archived ? "Archived a CV" : "Brought a CV back from the archive",
  });
  return { archivedAt: (data as { archived_at: string | null }).archived_at };
}

// ---------------------------------------------------------------------------------------------
// Reject, with a reason
// ---------------------------------------------------------------------------------------------

export type RejectionPrevious = {
  status: string | null;
  note: string | null;
  reason: string | null;
  reasonNote: string | null;
};

async function writeReason(ids: readonly string[], reason: RejectionReason, note: string | null): Promise<void> {
  for (const batch of chunkIds([...ids])) {
    const { error } = await recruitmentDb()
      .from("ats_candidates")
      .update({ rejection_reason: reason, rejection_reason_note: note })
      .in("id", batch);
    if (error) throw error;
  }
}

/**
 * Rejects one CV with a reason. Returns what it was before, for the 10-second Undo (the existing
 * revert-status route restores the status and note, and clears the reason — candidates.ts).
 * A CV that is already rejected only has its reason changed: a second "rejected → rejected" history
 * row would claim a decision nobody made.
 */
export async function rejectWithReason(
  access: AccessContext,
  candidateId: string,
  reasonRaw: unknown,
  noteRaw?: string | null,
): Promise<{ previous: RejectionPrevious }> {
  assertWorkspaceWorker(access);
  const note = textOrNull(noteRaw);
  const refusal = rejectionRefusal(reasonRaw, note);
  if (refusal) throw validationError(refusal);
  const reason = reasonRaw as RejectionReason;

  const { data: before, error } = await recruitmentDb()
    .from("ats_candidates")
    .select("id,status,status_note,rejection_reason,rejection_reason_note")
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw error;
  if (!before) throw notFoundError("Candidate not found.");
  const row = before as { status: string | null; status_note: string | null; rejection_reason: string | null; rejection_reason_note: string | null };
  const previous: RejectionPrevious = {
    note: row.status_note,
    reason: row.rejection_reason,
    reasonNote: row.rejection_reason_note,
    status: row.status,
  };

  if (row.status !== "rejected") {
    await updateCandidateStatus(access, candidateId, "rejected", rejectionStatusNote(reason, note));
  }
  await writeReason([candidateId], reason, note);
  await writeAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: candidateId,
    entityType: AUDIT_ENTITY,
    newValues: { action: "rejected", note, reason },
    oldValues: previous,
    summary: `Rejected a CV: ${rejectionReasonLabels[reason]}`,
  });
  return { previous };
}

export type BulkRejectMove = { id: string; fromStatus: string | null; fromNote: string | null };

/**
 * One reason across many ticked CVs, through the existing one-transaction bulk decision. Each moved
 * row comes back with the status AND note it had, which is everything the Undo needs to restore it.
 */
export async function bulkRejectWithReason(
  access: AccessContext,
  candidateIds: readonly string[],
  reasonRaw: unknown,
  noteRaw?: string | null,
): Promise<{ updated: number; moved: BulkRejectMove[]; missing: string[] }> {
  assertWorkspaceWorker(access);
  const note = textOrNull(noteRaw);
  const refusal = rejectionRefusal(reasonRaw, note);
  if (refusal) throw validationError(refusal);
  const reason = reasonRaw as RejectionReason;
  const ids = Array.from(new Set(candidateIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  const countRefusal = bulkDecisionRefusal("rejected", ids.length);
  if (countRefusal) throw validationError(countRefusal);

  const before = await fetchRowsInBatches<{ id: string; status_note: string | null }>(ids, (batch) =>
    recruitmentDb().from("ats_candidates").select("id,status_note").in("id", batch),
  );
  const noteBefore = new Map(before.map((row) => [row.id, row.status_note]));

  const result = await bulkUpdateCandidateStatus(access, ids, "rejected", rejectionStatusNote(reason, note));
  const movedIds = result.moved.map((move) => move.id);
  await writeReason(movedIds, reason, note);
  await writeAuditLog({
    actorLoginId: access.loginId ?? null,
    entityId: null,
    entityType: AUDIT_ENTITY,
    newValues: { action: "bulk_rejected", candidateIds: movedIds, note, reason },
    summary: `Rejected ${movedIds.length} CV${movedIds.length === 1 ? "" : "s"}: ${rejectionReasonLabels[reason]}`,
  });
  return {
    missing: result.missing,
    moved: result.moved.map((move) => ({ fromNote: noteBefore.get(move.id) ?? null, fromStatus: move.fromStatus, id: move.id })),
    updated: movedIds.length,
  };
}
