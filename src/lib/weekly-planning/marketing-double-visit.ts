import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { hrIdsMatch } from "@/lib/hr-id";

/**
 * Marketing Double Visit — a Product Manager or Group Product Manager going into the field
 * together with another member of the marketing team (owner request, 2026-09-14).
 *
 * The cascade is Region → Area → partner. The partner list is every active Product Manager,
 * Group Product Manager and Marketing Manager, company-wide, minus the person writing the plan —
 * nobody double-visits with themselves.
 *
 * Stored exactly the way Coaching is: `activity_type = "Other"` with a fixed `activity_title`, so
 * no database change is needed. The partner's name goes in `attendees`, NOT in the
 * `double_visit_medical_rep_*` columns: those feed the CRM double-visit, plan-adherence and
 * same-line booking readers, which would all treat a Product Manager as a Medical Rep.
 *
 * Pure and client-safe: the builder and the save/submit service both read it.
 */

export const MARKETING_DOUBLE_VISIT_TITLE = "Marketing Double Visit" as const;

const OFFERED_TO = new Set<string>(["Product Manager", "Group Product Manager"]);
const PARTNER_ROLES = new Set<string>(["Product Manager", "Group Product Manager", "Marketing Manager"]);

export type MarketingDoubleVisitPartner = {
  /** The name a person reads: the display name wherever the caller holds one. */
  fullName: string;
  hrId: string;
  jobTitle: string | null;
  /**
   * The legal name, when `fullName` is a display name. `attendees` is a raw snapshot: it is written
   * with this and a saved plan holds it, so a saved partner must still be recognised by it.
   */
  legalName?: string | null;
};

export function isMarketingDoubleVisit(activityType: string | null | undefined, activityTitle: string | null | undefined) {
  if (activityType === MARKETING_DOUBLE_VISIT_TITLE) return true;
  return (
    activityType === "Other" &&
    String(activityTitle ?? "").trim().toLowerCase() === MARKETING_DOUBLE_VISIT_TITLE.toLowerCase()
  );
}

/** Whether this plan owner is offered the option at all — Product Manager and Group Product Manager only. */
export function canPlanMarketingDoubleVisit(jobTitle: string | null | undefined, appRole?: string | null) {
  if (OFFERED_TO.has(resolveJobFunctionRole(jobTitle))) return true;
  return Boolean(appRole && OFFERED_TO.has(appRole));
}

/**
 * Everyone the owner may double-visit with. `candidates` must already be ACTIVE employees; the
 * caller owns that rule. The owner is removed however their HR id is cased or padded.
 */
export function marketingDoubleVisitPartners(
  candidates: ReadonlyArray<{ fullName: string; hrId: string; jobTitle: string | null; legalName?: string | null }>,
  ownerHrId: string | null | undefined,
): MarketingDoubleVisitPartner[] {
  return candidates
    .filter((candidate) => PARTNER_ROLES.has(resolveJobFunctionRole(candidate.jobTitle)))
    .filter((candidate) => !ownerHrId || !hrIdsMatch(candidate.hrId, ownerHrId))
    .map((candidate) => ({
      fullName: candidate.fullName,
      hrId: candidate.hrId,
      jobTitle: candidate.jobTitle,
      ...(candidate.legalName ? { legalName: candidate.legalName } : {}),
    }))
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
}

/**
 * The partner a stored or submitted name refers to, matched on the name alone (case and spacing
 * ignored): the name offered in the picker first, then the legal name a saved plan holds.
 */
export function findMarketingDoubleVisitPartner(
  partners: ReadonlyArray<MarketingDoubleVisitPartner>,
  name: string | null | undefined,
) {
  const key = String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!key) return null;
  const normalized = (value: string | null | undefined) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const onlyMatch = (read: (partner: MarketingDoubleVisitPartner) => string | null | undefined) => {
    const matches = partners.filter((partner) => normalized(read(partner)) === key);
    return matches.length === 1 ? matches[0] : null;
  };
  return onlyMatch((partner) => partner.fullName) ?? onlyMatch((partner) => partner.legalName);
}
