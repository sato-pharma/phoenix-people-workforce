/**
 * Is the workload verdict STORED on an outstation request still true?
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `resolveOutstationWorkloadPayload` stamps `workload_match_status`, `am_workload` and
 * `pm_workload` onto the request when it is SUBMITTED, and nothing ever re-reads them. The CRM
 * fills in later: a rep enters visits through and after the working day, and the iReports360
 * mirror syncs after that. So the read happens at the one moment the CRM is guaranteed to be
 * emptiest, and the verdict it produces is frozen.
 *
 * Measured on production 2026-09-03, all 80 trips, counting the visits the live read counts —
 * Regular (0) and Campaign (-8), where the rep is the primary agent OR the double-visit partner:
 *
 *   - 26 requests carry a stored verdict of `no_activity`
 *   - 14 of those 26 are contradicted by the live read — 135 visit rows the stamp does not reflect
 *   - 12 are genuinely empty, and they are 1–46 days old
 *
 * The 14 split into TWO independent causes, which matters because only one of them is about time:
 *
 *   - 8 arrived AFTER the stamp, on average 8.6 hours later. Ordinary late entry: the rep files
 *     visits through and after the working day and the mirror syncs behind that.
 *   - 6 were ALREADY VISIBLE in the CRM when the verdict was stamped, and the verdict still read
 *     "no activity". Five of those six were stamped by `workload_source = 'double_visit_import'`,
 *     the retired path that could only ever see double visits and was structurally blind to a
 *     rep's SOLO field days — the defect `src/lib/crm/visit-workload.ts` was written to fix.
 *     Those rows are that path's residue, and nothing re-stamps them.
 *
 * So a stored verdict can be wrong for two reasons at once, and neither is repaired today. By
 * source, 8 of the 14 came from the old import path and 6 from the live `ireports360` one.
 *
 * The damage is not that a number is old. It is that the admin request drawer prints
 * "Workload match: No activity" as a plain fact directly above a live evidence panel that lists
 * the visits the traveller actually made. Two contradictory statements, twenty lines apart, and
 * the stale one is the one shaped like a summary. An approver who reads the fact and not the
 * panel is looking at evidence that the person did nothing on a trip they were paid for.
 *
 * ── What this module does, and deliberately does NOT do ──────────────────────
 *
 * It compares the stored verdict against a live read and says whether the stored one can still
 * be believed. That is all. It does NOT re-stamp the request, and it does NOT feed the decision
 * engine: `workload_evidence_snapshot` is also the input to the campaign-visit rule in
 * `decision.ts`, and quietly swapping a live read underneath a live rejection rule would change
 * outstation money with nobody asking for it. The owner's standing rule is that the system FLAGS
 * an expense and never auto-decides one — so this reports, and a human acts.
 *
 * Pure on purpose: the caller supplies both sides, so this is testable without a database and
 * without a CRM.
 */

/** A stored verdict is believable, contradicted, or not comparable. */
export type WorkloadFreshnessVerdict =
  /** Stored and live agree — the stamp can be read as current. */
  | "fresh"
  /** Live evidence contradicts the stored verdict; the stored one understates the work. */
  | "stale"
  /** One side is missing or unmapped, so no comparison is possible. */
  | "unknown";

export type WorkloadFreshness = {
  /** Total visits the stored snapshot recorded (AM + PM + Pharmacies). */
  readonly storedTotal: number;
  /** Total visits the live CRM read finds now (AM + PM + Pharmacies). */
  readonly liveTotal: number;
  /** How many visits the stored snapshot is missing. Never negative. */
  readonly missedVisits: number;
  readonly verdict: WorkloadFreshnessVerdict;
  /**
   * One sentence for a reviewer, or null when there is nothing to say. Written to be read next
   * to the stored fact, so it names the stored verdict rather than describing "a snapshot".
   */
  readonly headline: string | null;
};

/**
 * `unmapped` means the traveller has no CRM identity at all, so a live read of zero is not
 * evidence of anything and must never be reported as "the stored verdict was wrong".
 */
const UNCOMPARABLE_LIVE_STATUSES = new Set(["unmapped"]);

const count = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

const clean = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();

/**
 * Compare a request's stored workload verdict against a live CRM read of the same trip window.
 *
 * `stale` is deliberately narrow: it fires only when the live read found visits the stored
 * snapshot did not. The reverse case — stored higher than live — is NOT reported, because visits
 * can legitimately be deleted or re-dated in the CRM, and treating that as a contradiction would
 * accuse a traveller on the strength of someone else's edit.
 */
export function resolveWorkloadFreshness(input: {
  readonly liveAmWorkload: number | null | undefined;
  /** THE AM · PM · PHARMACIES GOLDEN RULE: the live read keeps pharmacies out of AM/PM, and a
   * pharmacy visit is field work (owner, 2026-09-21), so it belongs in both totals. */
  readonly livePharmacyWorkload?: number | null | undefined;
  readonly livePmWorkload: number | null | undefined;
  /** The live read's own verdict, so an `unmapped` traveller is never judged. */
  readonly liveMatchStatus: string | null | undefined;
  /** Trip days on which the live read found the traveller's own recorded meeting (trip-day-meetings.ts).
   * Not visits — they never enter either total — but a day with one is a worked day. */
  readonly liveMeetingDays?: number | null | undefined;
  readonly storedAmWorkload: number | null | undefined;
  /** When the stored verdict was stamped, ISO. Only used to date the headline. */
  readonly storedMatchedAt: string | null | undefined;
  readonly storedMatchStatus: string | null | undefined;
  /** NULL on a request stamped before the split — its pharmacies are already inside stored AM/PM,
   * so counting NULL as 0 keeps that request's total comparable with the live three figures. */
  readonly storedPharmacyWorkload?: number | null | undefined;
  readonly storedPmWorkload: number | null | undefined;
}): WorkloadFreshness {
  const storedTotal =
    count(input.storedAmWorkload) + count(input.storedPmWorkload) + count(input.storedPharmacyWorkload);
  const liveTotal = count(input.liveAmWorkload) + count(input.livePmWorkload) + count(input.livePharmacyWorkload);
  const missedVisits = Math.max(0, liveTotal - storedTotal);
  const storedStatus = clean(input.storedMatchStatus);
  const liveStatus = clean(input.liveMatchStatus);

  // No stored verdict to judge, or a live read that cannot judge one.
  if (!storedStatus || storedStatus === "manual_override" || UNCOMPARABLE_LIVE_STATUSES.has(liveStatus)) {
    return { headline: null, liveTotal, missedVisits, storedTotal, verdict: "unknown" };
  }

  // The case that matters: the request says the traveller did nothing, and the CRM now says
  // otherwise. Reported even when the counts happen to tie, because the VERDICT is what the
  // reviewer reads, and "no activity" beside live visits is wrong regardless of arithmetic.
  const storedSaysNothingHappened = storedStatus === "no_activity";
  if (storedSaysNothingHappened && liveTotal > 0) {
    return {
      headline: `The stored verdict on this request is “no activity”${stampedOn(input.storedMatchedAt)}, but the CRM read above now finds ${plural(liveTotal, "visit")} in the same trip window. Visits reach the CRM during and after the trip, so a verdict stamped at submission can be out of date. The stored verdict is what the decision engine used — re-check before treating it as evidence the traveller did nothing.`,
      liveTotal,
      missedVisits,
      storedTotal,
      verdict: "stale",
    };
  }

  // A meeting is not a visit, but it IS the day's work (owner, 2026-11-07, Weaam Gweed's 5 Oct trip:
  // stamped at 13:09, her meeting saved at 13:54). "No activity" beside a recorded meeting is wrong.
  const liveMeetingDays = count(input.liveMeetingDays);
  if (storedSaysNothingHappened && liveMeetingDays > 0) {
    return {
      headline: `The stored verdict on this request is “no activity”${stampedOn(input.storedMatchedAt)}, but the CRM read above now finds a recorded meeting on ${plural(liveMeetingDays, "day")} of the trip. A meeting is not a field visit, but it is the day's work, so the trip is not a day with nothing done.`,
      liveTotal,
      missedVisits,
      storedTotal,
      verdict: "stale",
    };
  }

  if (missedVisits > 0) {
    return {
      headline: `The stored workload on this request${stampedOn(input.storedMatchedAt)} is ${plural(storedTotal, "visit")}; the CRM read above now finds ${plural(liveTotal, "visit")}. ${plural(missedVisits, "visit")} landed after the stamp was written.`,
      liveTotal,
      missedVisits,
      storedTotal,
      verdict: "stale",
    };
  }

  return { headline: null, liveTotal, missedVisits, storedTotal, verdict: "fresh" };
}

function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/**
 * " (stamped 14 Aug 2026)" or "" — Africa/Cairo, because every time the owner reads is Cairo.
 * A stamp that cannot be parsed is simply left out rather than rendered as "Invalid Date".
 */
function stampedOn(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  const formatted = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(parsed);
  return ` (stamped ${formatted})`;
}
