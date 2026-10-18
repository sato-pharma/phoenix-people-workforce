// Recruitment / ATS — saving one edited WhatsApp answer from the pool. The rules (what each answer
// key writes, what is refused) are whatsapp-answer-edit-rules.ts; this is only the write.

import { getCandidate } from "@/lib/recruitment/candidates";
import { mapCandidate, recruitmentDb, type CandidateDbRow } from "@/lib/recruitment/db";
import type { Candidate } from "@/lib/recruitment/types";
import { whatsAppAnswerEditPayload } from "@/lib/recruitment/whatsapp-answer-edit-rules";

/** Saves one edited answer on the candidate's record and returns the record. */
export async function saveCandidateWhatsAppAnswer(
  candidateId: string,
  key: string,
  value: unknown,
): Promise<Candidate> {
  const existing = await getCandidate(candidateId);
  if (!existing) throw new Error("Candidate not found.");
  const edit = whatsAppAnswerEditPayload(key, value, existing.screeningExtraAnswers ?? null);
  if (!edit.ok) throw new Error(edit.message);
  const { data, error } = await recruitmentDb()
    .from("ats_candidates")
    .update({ ...edit.payload, updated_at: new Date().toISOString() })
    .eq("id", candidateId)
    .select("*")
    .single();
  if (error) throw error;
  return mapCandidate(data as CandidateDbRow);
}
