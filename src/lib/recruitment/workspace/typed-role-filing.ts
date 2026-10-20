// Recruitment workspace — may this viewer TYPE this role onto a candidate?
//
// Saving the role answer from the pool (`whatsapp-answer`, key `job_title`) re-files the person: the
// saver stores the family the typed words read as and places the candidate in the tab that family maps
// to (`saveCandidateWhatsAppAnswer` → `placeFromAnswers`). So typing a role IS filing a CV, and it
// answers to the same rule as the "Place in a tab" drawer: nobody files a person in a tab they cannot
// see. Without this check the Talent Acquisition seat could type "HR Section Head" or "Talent
// Acquisition" and put a person into an HR tab she is never shown — a way to make a CV vanish from her
// own queue, and to file into a tab the owner closed to her (role-tabs.ts, `HR_ROLE_TABS`).
//
// PURE — the route resolves the typed words to a family (`roleFamilyForTypedRole`) and asks here. The
// wording of the tab refusal is `placementTabRefusal`'s and the Place form's, so a seat reads one
// sentence wherever the same refusal reaches her.

import { personVisibleToViewer, roleTabForFamily, type WorkspaceViewer } from "@/lib/recruitment/workspace/role-tabs";

export const TYPED_ROLE_TAB_REFUSAL = "You cannot file a CV in that tab.";
export const TYPED_ROLE_HR_REFUSAL = "You cannot file a CV under an HR role.";

/**
 * Why this viewer may not type a role that reads as `family`, or null when they may.
 *
 * Two refusals, both from what the filing would do to the person:
 *   1. The family files in a role tab this viewer does not have — the HR Section Head and Talent
 *      Acquisition tabs, for the Talent Acquisition seat.
 *   2. The family files in NO tab but still makes the person an HR applicant (the retired Human
 *      Resources tap), who the fence then hides from a fenced viewer — the same vanishing act by
 *      another door.
 *
 * A role that names no family files nowhere and is always allowed, as is clearing the answer.
 */
export function typedRoleRefusal(viewer: WorkspaceViewer, family: string | null): string | null {
  if (!family) return null;
  const tab = roleTabForFamily(family);
  if (tab && !viewer.roleTabs.includes(tab)) return TYPED_ROLE_TAB_REFUSAL;
  if (!personVisibleToViewer(viewer, { declaredRoleFamily: family, placementTabs: [] })) return TYPED_ROLE_HR_REFUSAL;
  return null;
}
