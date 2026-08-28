/**
 * CRM identity matching — the single definition of how an iReports360 agent/double-visitor
 * (a numeric `crm_id` + a display name) resolves to a Phoenix employee `hr_id`.
 *
 * Waterfall: manual override (an admin's explicit decision) → `employees.crm_id` →
 * unique, normalized `employees.crm_username` (display-name) match. An ambiguous username
 * (2+ employees) is dropped rather than guessed, and check-ins (which carry no name) only
 * ever use the first two tiers. Deduction-sensitive consumers (Field Workforce Compliance)
 * must never rely on the username tier — they read the already-stored `agent_hr_id`.
 *
 * Extracted verbatim from visits-report/service.ts so the sync engine and every read share
 * one resolver.
 */

import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { CRM_IDENTITY_RESOLUTIONS_TABLE } from "@/lib/crm/tables";
import { isCrmSchemaMissingError } from "@/lib/crm/schema";
import type { CrmIdentityMaps, CrmManualOverride, CrmResolutionAction, CrmResolutionRow } from "@/lib/crm/types";

export type { CrmIdentityMaps, CrmManualOverride, CrmResolutionAction, CrmResolutionRow } from "@/lib/crm/types";

/**
 * Trims + lowercases + collapses internal whitespace runs to a single space. The CRM's own
 * display-name text has been observed with inconsistent spacing for the same person across
 * records (e.g. "Alex East / P" vs "Alex East  / P" — a stray double space), so a plain
 * trim+lowercase alone under-matches; this normalizes both sides of the comparison the same way.
 */
export function normalizeCrmName(name: string | null | undefined): string | null {
  const normalized = name?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized ? normalized : null;
}

/**
 * The crm_username map only keeps values unique across the active+inactive roster — an
 * ambiguous (2+) match is excluded rather than guessing wrong, same safety rule as the
 * double-visit-analytics precedent.
 */
export function buildCrmIdentityMaps(
  employees: EmployeeDirectoryRow[],
  resolutions: CrmResolutionRow[] = [],
): CrmIdentityMaps {
  const hrIdByCrmId = new Map<string, string>();
  for (const employee of employees) {
    if (employee.crmId) hrIdByCrmId.set(employee.crmId, employee.hrId);
  }

  const usernameGroups = new Map<string, string[]>();
  for (const employee of employees) {
    const key = normalizeCrmName(employee.crmUsername);
    if (!key) continue;
    usernameGroups.set(key, [...(usernameGroups.get(key) ?? []), employee.hrId]);
  }
  const hrIdByCrmUsername = new Map<string, string>();
  for (const [key, hrIds] of usernameGroups) {
    if (hrIds.length === 1) hrIdByCrmUsername.set(key, hrIds[0]);
  }

  const hrIdByManualOverride = new Map<string, CrmManualOverride>();
  for (const resolution of resolutions) {
    if (resolution.status === "mapped" && resolution.mappedHrId) {
      hrIdByManualOverride.set(String(resolution.crmId), {
        hrId: resolution.mappedHrId,
        label: normalizeCrmName(resolution.crmName),
      });
    }
  }

  const hireDateByHrId = new Map<string, string>();
  const lastWorkingDateByHrId = new Map<string, string>();
  const crmUsernameByHrId = new Map<string, string>();
  for (const employee of employees) {
    const hireDate = employee.hireDate?.slice(0, 10);
    if (hireDate) hireDateByHrId.set(employee.hrId, hireDate);
    const lastWorkingDate = employee.lastWorkingDate?.slice(0, 10);
    if (lastWorkingDate) lastWorkingDateByHrId.set(employee.hrId, lastWorkingDate);
    // NOT filtered for ambiguity the way hrIdByCrmUsername is: that map answers "which single
    // employee owns this label", so a shared label must be dropped. This one answers "what is THIS
    // employee's own label", which is well defined even when two people share one.
    const ownLabel = normalizeCrmName(employee.crmUsername);
    if (ownLabel) crmUsernameByHrId.set(employee.hrId, ownLabel);
  }

  return {
    hrIdByCrmId,
    hrIdByCrmUsername,
    hrIdByManualOverride,
    hireDateByHrId,
    lastWorkingDateByHrId,
    crmUsernameByHrId,
  };
}

/**
 * EMPLOYMENT-SPAN ATTRIBUTION GUARD. Work dated outside someone's employment cannot be theirs —
 * not after their last working day, and not before their hire date either.
 *
 * The two ends are the SAME bug seen from opposite sides, because the cause is the same: whoever
 * administers iReports360 hands one person's CRM account to the next person to hold that territory
 * instead of creating a new account. Looking forward from the leaver you see the replacement's work
 * filed under someone who had gone; looking backward from the replacement you see the leaver's whole
 * history filed under someone who had not yet joined.
 *
 * THE TWO ENDS NEED DIFFERENT TESTS, AND THIS IS THE IMPORTANT PART. Post-exit is decided by the
 * CRM LABEL (see below) because the date alone cannot tell a handed-over slot from someone's own
 * final days logged late. Pre-hire CANNOT use that test, because the CRM REWRITES the label on
 * historic rows when an account changes hands — the old occupant's visits come back carrying the new
 * occupant's name. Measured on production 2026-08-28 across all 1,619 pre-hire rows:
 *
 *   1,248 of 1,619 (77%) carried the CURRENT holder's own label      -> a label test would ALLOW them
 *       0 of 1,619 carried no label at all                            -> not a missing-data artifact
 *
 * So the label is actively misleading here rather than merely unavailable, and the pre-hire half is
 * DATE-ONLY. A grace window was measured and rejected for the same reason it was at the other end —
 * the gap distribution has no safe cut:
 *
 *   1-3 days before hire     13 rows,   0 real calls   (admin broadcasts to the whole roster)
 *   4-7 days before hire     36 rows,   0 real calls   (same)
 *   8-30 days before hire    91 rows,  46 real calls
 *   31-90 days before hire  725 rows, 604 real calls
 *   91+ days before hire    754 rows, 464 real calls   (worst: 207 days, one rep, 931 real calls)
 *
 * Zero real calls anywhere in the first week is what makes a hard date rule safe: nobody in this
 * data legitimately logged a doctor call before their recorded start, so there is no true positive
 * for a window to protect. The 49 rows in that first week are all admin broadcasts (a public holiday
 * published to the entire CRM roster, which already includes next week's joiner) — those carry no
 * activity credit, and refusing to file them under someone who had not started is correct too.
 *
 * POST-EXIT ATTRIBUTION GUARD. Work dated after someone's last working day cannot be theirs.
 *
 * This is the recurrence prevention for a whole bug class. Whoever administers iReports360 reuses a
 * departing employee's CRM account for their replacement rather than creating a new one, but the
 * Phoenix roster keeps `employees.crm_id` pointing at the person who left. Tier 2 of the waterfall
 * therefore keeps stamping the REPLACEMENT's work with the LEAVER's hr id — and because the
 * departed-agent exclusion then hides anything belonging to a leaver, the new rep's work goes
 * invisible platform-wide. Nobody notices until an audit, or until the missing activity manufactures
 * a wrongful payroll deduction.
 *
 * Returning null is the honest answer and a strictly better failure: an unattributed visit surfaces
 * in the Unmapped Agents tab as an explicit decision to make, instead of being silently filed under
 * someone who had already left.
 *
 * THE DATE ALONE IS NOT THE SIGNAL. A post-exit date has two very different causes, and only one is
 * a misattribution:
 *
 *   handed-over slot  — the CRM label names a DIFFERENT person than the roster row it resolves to.
 *                       This is the bug: the replacement's work filed under the leaver.
 *   own trailing work — the label still names the SAME person. Their final days were simply logged
 *                       a day or two after the recorded last working date.
 *
 * Verified against every post-exit case in production on 2026-08-01. The label test separates them
 * perfectly, and a date-only rule does not:
 *
 *   B-162  roster "veronica.ashraf ( alex center / a )" == record  -> own work,   allow  (10 rows)
 *   B-111  roster "amany.wasiem ( assuit 1 / f )"       == record  -> own work,   allow  ( 2 rows)
 *   B-176  roster "eman.essam ( behera 1 / a )"         == record  -> own work,   allow  ( 1 row )
 *   PD-0003 roster "mayar.tarek ( dokki / p )"  vs "essam.youssef ( dokki / p )"  -> BLOCK (163)
 *   B-85    roster "tayseer.khaled ( cairo east 1 / e )" vs "soad.atef ( … / a )" -> BLOCK ( 27)
 *
 * A grace window was considered and rejected: the slot-1536 misattribution began ONE day after the
 * leaver's exit, so any window wide enough to protect the three trailing-work cases would have let
 * roughly 35 of the replacement's visits stay filed under the wrong person.
 *
 * Both labels go through `normalizeCrmName` — the vendor emits the same person's label with
 * inconsistent internal spacing ("( Assuit 1 / F  )" vs "( Assuit 1 / F )"), which is exactly the
 * case B-111 hits, so raw string equality reports a false mismatch there.
 *
 * Dates compare as ISO `YYYY-MM-DD` strings — both sides are plain dates, so lexicographic order is
 * exact, and it deliberately avoids Date parsing (which would drag the vendor timezone convention
 * into a comparison that has nothing to do with clocks).
 */
export function isAttributableOn(
  hrId: string,
  visitDate: string | null | undefined,
  maps: CrmIdentityMaps,
  crmName?: string | null,
): boolean {
  // No date to judge against (ad-hoc callers): fall back to the previous behaviour rather than
  // blocking on a value we don't have.
  if (!visitDate) return true;
  const visitDay = visitDate.slice(0, 10);

  // PRE-HIRE. Date-only and with no grace window — see the doc comment for why the label test that
  // makes the post-exit half safe cannot be used here, and why the measured gap distribution leaves
  // nothing for a window to protect. An employee with no recorded hire date is never blocked: an
  // unknown start is not evidence of anything, and blocking on it would unmap real work.
  const hireDate = maps.hireDateByHrId.get(hrId);
  if (hireDate && visitDay < hireDate) return false;

  const lastWorkingDate = maps.lastWorkingDateByHrId.get(hrId);
  if (!lastWorkingDate) return true;
  if (visitDay <= lastWorkingDate) return true;

  // Post-exit. Attribute it only if the record still carries THIS employee's own CRM label.
  const ownLabel = maps.crmUsernameByHrId.get(hrId);
  const recordLabel = normalizeCrmName(crmName);
  // No label to compare (check-ins carry a crm_id only, never a display name): keep the stricter
  // date-only answer. Unattributed is recoverable — an admin sees it in Unmapped Agents — whereas
  // silently crediting a leaver is the failure this guard exists to prevent.
  if (!ownLabel || !recordLabel) return false;
  return ownLabel === recordLabel;
}

/** The outcome of one attribution attempt. `blockedHrId` is set when a tier DID match but the
 * employment-span guard rejected it — the caller can count and report those instead of seeing a bare
 * null that looks identical to "this agent is simply unknown". */
export type CrmAttribution = { blockedHrId: string | null; hrId: string | null };

/** Which end of the employment span refused an attribution. */
export type CrmBlockReason = "pre_hire" | "post_exit";

/**
 * Why `isAttributableOn` refused — for a caller that already has a `blockedHrId` and needs to report
 * the two causes separately.
 *
 * They are NOT interchangeable operationally, which is the whole reason they are counted apart. A
 * post-exit block means a CRM account has just been handed to a replacement and somebody's CURRENT
 * work is going unattributed today — act now. A pre-hire block is the same handover seen from the
 * other side: it is the PREVIOUS occupant's history detaching from the new joiner, which is a
 * backfill to reconcile, not an emergency. Folding them into one counter would let a burst of old
 * rows drown out a live problem, and vice versa.
 *
 * Pre-hire is tested first because it is the unambiguous one: a date before the hire date cannot be
 * that person's work under any reading. A rehire whose `hire_date` moved forward past their own
 * earlier service is the one shape that reads pre-hire without being a handover — it is still
 * correctly refused (the roster says they had not started), and it still wants a human decision.
 */
export function blockReasonFor(
  hrId: string,
  visitDate: string | null | undefined,
  maps: CrmIdentityMaps,
): CrmBlockReason {
  const hireDate = maps.hireDateByHrId.get(hrId);
  if (visitDate && hireDate && visitDate.slice(0, 10) < hireDate) return "pre_hire";
  return "post_exit";
}

/**
 * Manual override first (an admin's explicit "map to this HR ID" decision from the Unmapped
 * Agents tab always wins); then crm_id; then falls back to matching the CRM's display name
 * (which IS the crm_username, e.g. "Rasha.Sabry ( P.M / F )" — confirmed from real captured
 * iReports360 data) against a unique crm_username on the roster.
 *
 * `visitDate` (the record's own date, YYYY-MM-DD) enables the post-exit guard on the two AUTOMATIC
 * tiers. The manual override is deliberately EXEMPT: it is an admin's explicit, hand-verified
 * decision about who owns a CRM slot, and it is the intended way to record "this slot belongs to
 * someone the roster doesn't link" — including for historical rows. Guarding it would let a stale
 * roster date silently veto a human decision, which inverts the waterfall's whole authority order.
 */
export function resolveEmployeeAttribution(
  crmId: number | string | null | undefined,
  name: string | null | undefined,
  maps: CrmIdentityMaps,
  visitDate?: string | null,
): CrmAttribution {
  if (crmId != null) {
    // Tier 1 — explicit admin decision. Not guarded by the post-exit date (see the doc comment
    // above), but LABEL-SCOPED when the resolution stored the CRM label it was decided against:
    // production slots 1102/1395/1399 each carry TWO different people's names in their history
    // (a leaver's rows, then the replacement's after the account was handed over), so an
    // unconditional override would let a wide reconcile re-stamp the OLD occupant's rows with
    // the NEW occupant's hr id. A mismatched label therefore falls through to the automatic
    // tiers, which resolve the old occupant correctly and carry the post-exit guard. A record
    // with NO label (check-ins carry a crm_id only) keeps the unconditional behavior — the
    // handover-accuracy risk lives in visit attribution, and blocking check-ins would strip the
    // GPS overlay from every correctly-mapped slot.
    const overridden = maps.hrIdByManualOverride.get(String(crmId));
    if (overridden) {
      const recordLabel = normalizeCrmName(name);
      if (!overridden.label || !recordLabel || overridden.label === recordLabel) {
        return { blockedHrId: null, hrId: overridden.hrId };
      }
    }
    // Tier 2 — employees.crm_id. This is the tier that misattributes a reused CRM slot.
    const byId = maps.hrIdByCrmId.get(String(crmId));
    if (byId) {
      // `name` is the record's raw CRM label — the signal that tells a handed-over slot apart from
      // this employee's own trailing work. See isAttributableOn.
      if (!isAttributableOn(byId, visitDate, maps, name)) return { blockedHrId: byId, hrId: null };
      return { blockedHrId: null, hrId: byId };
    }
  }
  const key = normalizeCrmName(name);
  if (!key) return { blockedHrId: null, hrId: null };
  // Tier 3 — unique crm_username. The POST-EXIT half can only ever allow here: this tier resolved
  // BECAUSE the record's label is that employee's own label, which is exactly the condition the
  // post-exit check tests. That is the right answer rather than a loophole — a label matching a
  // departed person means their own trailing work, and a handed-over slot carries the REPLACEMENT's
  // label, so it never resolves to the leaver here in the first place.
  //
  // The PRE-HIRE half is the opposite, and this tier is where it does its most important work. When
  // an account changes hands the CRM rewrites the label on the previous occupant's historic rows to
  // the NEW occupant's name, so those old rows resolve here — correctly by label, wrongly by person.
  // 1,248 of the 1,619 pre-hire rows found in production on 2026-08-28 have exactly this shape, the
  // largest being 931 real doctor calls dated up to 207 days before that employee joined. Only the
  // date can refuse them.
  const byName = maps.hrIdByCrmUsername.get(key);
  if (!byName) return { blockedHrId: null, hrId: null };
  if (!isAttributableOn(byName, visitDate, maps, name)) return { blockedHrId: byName, hrId: null };
  return { blockedHrId: null, hrId: byName };
}

/** The waterfall's hr-id answer alone — the shape every existing caller expects. */
export function resolveEmployeeHrId(
  crmId: number | string | null | undefined,
  name: string | null | undefined,
  maps: CrmIdentityMaps,
  visitDate?: string | null,
): string | null {
  return resolveEmployeeAttribution(crmId, name, maps, visitDate).hrId;
}

/** Every stored admin resolution decision — small table (bounded by distinct crm_id count),
 * no pagination needed. Returns [] before the migration ships so callers degrade gracefully. */
export async function getCrmIdentityResolutions(): Promise<CrmResolutionRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_IDENTITY_RESOLUTIONS_TABLE)
    .select("crm_id, status, mapped_hr_id, crm_name");
  if (error) {
    if (isCrmSchemaMissingError(error)) return [];
    throw new Error(error.message);
  }
  return (
    (data ?? []) as Array<{ crm_id: number; crm_name: string | null; mapped_hr_id: string | null; status: string }>
  ).map((row) => ({
    crmId: row.crm_id,
    crmName: row.crm_name,
    mappedHrId: row.mapped_hr_id,
    status: row.status as CrmResolutionAction,
  }));
}

/** Convenience: build the identity maps from live roster + stored resolutions in one call. */
export async function loadCrmIdentityMaps(): Promise<CrmIdentityMaps> {
  const [employees, resolutions] = await Promise.all([
    getEmployeeDirectoryRows({ includeInactive: true }),
    getCrmIdentityResolutions(),
  ]);
  return buildCrmIdentityMaps(employees, resolutions);
}
