// Recruitment / ATS — saving one edited WhatsApp answer from the pool. The rules (what each answer
// key writes, what is refused) are whatsapp-answer-edit-rules.ts; this is the write.
//
// SINCE 2026-10-20 an answer HR types is MARKED as HR's (`answer_marks`: who and when — the chip says
// "added by HR"), and the applicant answering that question again on WhatsApp clears the mark: their
// own word wins over a recruiter's. Extra answers go through `ats_merge_screening_answer`, one key at a
// time, so two people saving two different answers at once cannot erase each other's. A corrected
// role, region or area re-files the person (placed by `hr`), and the stored completeness follows.

import { writeAuditLog } from "@/lib/admin/audit";
import { candidateRoleFamilies, candidateRoleFamilyOrNull } from "@/lib/recruitment/candidate-role-family";
import { getCandidate } from "@/lib/recruitment/candidates";
import { mapCandidate, recruitmentDb, type CandidateDbRow } from "@/lib/recruitment/db";
import type { Candidate } from "@/lib/recruitment/types";
import { whatsAppAnswerEditPayload } from "@/lib/recruitment/whatsapp-answer-edit-rules";
import { recomputeCompleteness } from "@/lib/recruitment/workspace/completeness";
import { placeFromAnswers } from "@/lib/recruitment/workspace/placements-db";

/** Who typed the answer. Without an HR id no "added by HR" mark can be written. */
export type AnswerEditActor = { hrId: string | null; loginId?: string | null };

/** The mark key for an edit key: `job_title` is shown as `role`, `extra:<key>` as `<key>`. */
export function answerMarkKey(editKey: string): string {
  if (editKey === "job_title") return "role";
  return editKey.startsWith("extra:") ? editKey.slice("extra:".length) : editKey;
}

/**
 * The role family a typed role answer names: a family code as the workspace sends it, else the
 * family its words read as. Null when it names none.
 */
export function roleFamilyForTypedRole(value: string | null): string | null {
  const text = value?.trim() ?? "";
  if (!text) return null;
  if ((candidateRoleFamilies as readonly string[]).includes(text)) return text;
  return candidateRoleFamilyOrNull(text);
}

/** Saves one edited answer on the candidate's record and returns the record. */
export async function saveCandidateWhatsAppAnswer(
  candidateId: string,
  key: string,
  value: unknown,
  actor?: AnswerEditActor | null,
): Promise<Candidate> {
  const existing = await getCandidate(candidateId);
  if (!existing) throw new Error("Candidate not found.");
  const edit = whatsAppAnswerEditPayload(key, value, existing.screeningExtraAnswers ?? null);
  if (!edit.ok) throw new Error(edit.message);

  const db = recruitmentDb();
  const hrId = actor?.hrId?.trim() || null;
  const typed = typeof value === "string" && value.trim() ? value.trim() : null;
  const isExtra = key.startsWith("extra:");

  if (isExtra) {
    // One key, merged — never the whole map read a moment ago and written back over a newer one.
    const { error } = await db.rpc("ats_merge_screening_answer", {
      p_candidate_id: candidateId,
      p_key: answerMarkKey(key),
      p_marked_by_hr_id: typed ? hrId : null,
      p_value: typed,
    });
    if (error) throw error;
  } else {
    const payload: Record<string, unknown> = { ...edit.payload, updated_at: new Date().toISOString() };
    // The role is filed by its FAMILY, so a corrected role carries its family with it.
    if (key === "job_title") payload.declared_role_family = roleFamilyForTypedRole(typed);
    const { error } = await db.from("ats_candidates").update(payload).eq("id", candidateId);
    if (error) throw error;
    // A cleared answer carries no mark; a typed one is HR's.
    const { error: markError } = await db.rpc("ats_set_answer_mark", {
      p_candidate_id: candidateId,
      p_key: answerMarkKey(key),
      p_marked_by_hr_id: typed ? hrId : null,
    });
    if (markError) throw markError;
  }

  // Best effort: the answer is already saved, and a failed audit row must not report a failed save.
  await writeAuditLog({
    actorLoginId: actor?.loginId ?? hrId,
    entityId: candidateId,
    entityType: "recruitment_candidate_answer",
    newValues: { key, value: typed },
    oldValues: { value: previousAnswer(existing, key) },
    summary: typed ? `Recruitment: HR set the "${answerMarkKey(key)}" answer` : `Recruitment: HR cleared the "${answerMarkKey(key)}" answer`,
  });

  const { data, error } = await db.from("ats_candidates").select("*").eq("id", candidateId).single();
  if (error) throw error;
  const row = data as CandidateDbRow;

  // Re-filed from the corrected answers — HR's filing, so the bot never moves it back.
  if (key === "job_title" || key === "region" || key === "area") {
    await placeFromAnswers({
      areaName: (row.preferred_area_name as string | null) ?? null,
      candidateId,
      placedBy: "hr",
      placedByHrId: hrId,
      regionCode: (row.preferred_region_code as string | null) ?? null,
      roleFamily: (row.declared_role_family as string | null) ?? null,
    });
  }
  await recomputeCompleteness([candidateId]);

  return mapCandidate(row);
}

/** What the answer was before the edit, for the audit row. */
function previousAnswer(candidate: Candidate, key: string): unknown {
  if (key.startsWith("extra:")) return (candidate.screeningExtraAnswers ?? {})[key.slice("extra:".length)] ?? null;
  const field: Record<string, string | null> = {
    area: candidate.preferredAreaName,
    background: candidate.declaredBackground,
    experience: candidate.declaredExperience,
    job_title: candidate.appliedForJobTitle,
    region: candidate.preferredRegionCode,
    salary: candidate.declaredExpectedSalary,
  };
  return field[key] ?? null;
}
