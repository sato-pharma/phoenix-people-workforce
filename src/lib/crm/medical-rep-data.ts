// ─────────────────────────────────────────────────────────────────────────────
// The reader half of the medical-rep rule. The rule itself is pure and lives in
// crm/medical-rep.ts; this file only fetches what it needs and hands it over.
//
// Both reads underneath are already cached (`loadOrgPlacementTree` through
// unstable_cache, `loadJobTitlesByHrId` through the employee directory's own
// cache), and both are read by the boards that call this anyway — so building a
// roster costs no extra round trip on a warm process.
// ─────────────────────────────────────────────────────────────────────────────

import { isMedicalRep } from "@/lib/crm/medical-rep";
import { orgHrKey } from "@/lib/crm/org-placement";
import { loadOrgPlacementTree } from "@/lib/crm/org-placement-data";
import { loadJobTitlesByHrId } from "@/lib/crm/call-rate-service";

/** Answers the medical-rep question for one hr id. */
export type MedicalRepRoster = {
  isMedicalRep(hrId: string | null | undefined): boolean;
};

/**
 * The roster, resolved once for a whole board render.
 *
 * Keyed through `orgHrKey`, which lower-cases: hr ids reach these boards in
 * whatever case the CRM mirror carries, which is mixed, and a case-sensitive
 * miss here would read as "not a medical rep" and delete the person from the
 * board. That is the same class of silent under-return that has cost this repo
 * a quarter of a board's rows before (AGENTS.md §2.1).
 *
 * An agent with no hr id at all is not a medical rep: there is nothing to
 * resolve him by. In production's August window that is 47 CRM accounts holding
 * 52 visits between them — roughly one apiece, which is what a stale or test
 * login looks like, not a working rep.
 */
export async function loadMedicalRepRoster(): Promise<MedicalRepRoster> {
  const [tree, jobTitleByHrId] = await Promise.all([loadOrgPlacementTree(), loadJobTitlesByHrId()]);
  return {
    isMedicalRep(hrId) {
      const key = orgHrKey(hrId);
      if (!key) return false;
      const placement = tree.index.get(key);
      return isMedicalRep({
        // `scored` is "holds a REP seat", including the person who holds several
        // seats of which one is a rep's. Null placement means UNSEATED, which is
        // the only case the job title is allowed to answer.
        placement: placement ? { hasRepSeat: placement.scored } : null,
        jobTitle: jobTitleByHrId.get(key) ?? null,
      });
    },
  };
}
