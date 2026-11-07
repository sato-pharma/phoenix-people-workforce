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
import { CASUAL_LEAVE_TYPE, HOLIDAY_TYPE } from "@/lib/crm/visit-types";
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
export type CrmAttribution = {
  blockedHrId: string | null;
  hrId: string | null;
  /** True when the block came from a refused MANUAL OVERRIDE rather than an automatic tier.
   *
   * Both kinds of block mean the same thing to the sync's writer — do not credit, and do not treat
   * the null as an absence of information — but they mean opposite things to a human. An automatic
   * block is ACTIONABLE: a CRM slot was handed over and somebody needs to record who owns it. An
   * override block is SETTLED: somebody already recorded it, and the answer is that this particular
   * date is not theirs. Reporting the settled kind through the "needs an identity override" counters
   * would raise a warning on every sync that no action could ever clear. See sync.ts's counting loop. */
  blockedByOverride?: boolean;
};

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
 * True when a row records the ABSENCE of work — a public holiday or a casual leave day — and so
 * cannot be anybody's unattributed work no matter who the CRM slot resolves to.
 *
 * WHY THE BLOCK COUNTERS NEED THIS. Both counters mean "these rows need an identity override
 * recorded", and a non-zero count marks the sync degraded. iReports360 sprays a holiday marker
 * across EVERY account on a public holiday, deactivated ones included — measured on production
 * 2026-08-27, a public holiday: 168 markers, one per slot, and zero real calls company-wide. Five
 * of those landed on accounts whose holder had left, so the post-exit guard refused them and the
 * sync reported "with warnings" on all 48 runs that day and every run since. Nothing could ever
 * clear it: each of those five slots stopped producing real work on the exact day its holder left
 * (`( Behira 2 / C )` last real call 2026-07-11, holder left 2026-07-11; `( Cairo West / C )`
 * 2026-06-10 against 2026-06-11; `( Bani Sweif / E )` 2026-06-10 against 2026-06-10), and the CRM
 * admin strips the name at resignation, so no override is even recordable.
 *
 * Whole-table scan, 126,410 rows on 2026-08-28: of 266 counted blocks this silences 91 — the 5
 * post-exit ones and 86 of the 261 pre-hire ones — and leaves 175 standing, every one of them on a
 * row that records real activity (155 campaign, 11 regular, 5 meeting, 3 training, 1 annual
 * vacation). 31 dormant slots stop alarming; the 6 that carry real work keep alarming. A slot
 * genuinely reused for a new hire cannot hide here: it produces real calls too, and those still
 * count.
 *
 * NOT PAYROLL SEMANTICS, and never to be reused as such. Whether a code costs an employee money is
 * decided by the one visit-type table in crm/visit-type-meaning.ts, which is
 * owner-confirmed and deliberately separate. This answers one narrower question: can an identity
 * override change anything about this row? Only the two codes are listed — a meeting, a campaign or
 * an admin-work row IS activity somebody performed, and a block on one still wants acting on.
 */
export function recordsNoWorkToAttribute(visitType: number | null | undefined): boolean {
  return visitType === HOLIDAY_TYPE || visitType === CASUAL_LEAVE_TYPE;
}

/**
 * Manual override first (an admin's explicit "map to this HR ID" decision from the Unmapped
 * Agents tab always wins); then crm_id; then falls back to matching the CRM's display name
 * (which IS the crm_username, e.g. "Rasha.Sabry ( P.M / F )" — confirmed from real captured
 * iReports360 data) against a unique crm_username on the roster.
 *
 * `visitDate` (the record's own date, YYYY-MM-DD) enables the employment guard on ALL THREE tiers,
 * the manual override included. The owner's rule, given 2026-08-28: "you will see when he is hired
 * and when he is resigned, and his area and his line. If matches, then credit him. If not matches,
 * leave him." A mapping therefore says WHO a CRM slot belongs to; it never says that person was
 * employed on the day a given row is dated, and it cannot credit them outside their own tenure.
 *
 * An override refused that way is still REPORTED (as a block, see overrideRefusal) rather than
 * discarded, which is what keeps the authority order intact — the admin's decision does not vanish,
 * it surfaces as a row nobody eligible owns.
 */
export function resolveEmployeeAttribution(
  crmId: number | string | null | undefined,
  name: string | null | undefined,
  maps: CrmIdentityMaps,
  visitDate?: string | null,
): CrmAttribution {
  // Set when tier 1 matched a slot but the mapped person's own employment does not cover this date.
  // Carried to the end so the refusal can be REPORTED if no automatic tier answers either — the row
  // is never credited to them. See the tier 1 comment below and overrideRefusal.
  let overrideRefusedHrId: string | null = null;

  if (crmId != null) {
    // Tier 1 — explicit admin decision. LABEL-SCOPED when the resolution stored the CRM label it
    // was decided against: production slots 1102/1395/1399 each carry TWO different people's names
    // in their history (a leaver's rows, then the replacement's after the account was handed over),
    // so an unconditional override would let a wide reconcile re-stamp the OLD occupant's rows with
    // the NEW occupant's hr id. A mismatched label therefore falls through to the automatic tiers,
    // which resolve the old occupant correctly. A record with NO label (check-ins carry a crm_id
    // only) keeps the unconditional behavior — the handover-accuracy risk lives in visit
    // attribution, and blocking check-ins would strip the GPS overlay from every mapped slot.
    //
    // EMPLOYMENT-SCOPED SINCE 2026-08-28 — BUT AS A YIELD, NOT A VETO. A mapping says "this CRM
    // account belongs to X" and carries no time dimension, while a handed-over account belongs to
    // two people in sequence; the vendor then relabels the whole history to the CURRENT holder, so
    // both people's rows look identical. Slot 1391 is the worked example: 1,136 calls dated
    // 2026-01-01..06-01 by the rep who left on 06-02, and 28 dated 07-20..08-27 by the rep who
    // joined on 06-20, every one of them carrying the second rep's name. Mapping that slot to
    // either person unconditionally miscredits the other's work.
    //
    // So when the record's date falls outside the mapped person's own employment, the override
    // stands ASIDE and lets the automatic tiers try. If one of them resolves — meaning somebody
    // whose crm_id or own label matches AND whose employment covers the date — that answer wins,
    // and slot 1391's two halves land on their two owners from a single mapping.
    //
    // AND IF NONE OF THEM RESOLVES, THE ROW IS STILL NOT CREDITED TO THE MAPPED PERSON. It is
    // reported as a block instead. This shipped the other way that morning — the override applied
    // after all, on the reasoning that a human decision must never be vetoed into nothing by a
    // roster date. That reasoning was answering a real risk with the wrong instrument, and the data
    // said so within hours: at 09:34:57 Cairo on 2026-08-28 the hourly sync re-credited 40 rows to
    // people who had already left, the largest group being 27 August public-holiday markers landing
    // on four leavers whose accounts no automatic tier could resolve. Each one had been cleared by
    // hand an hour earlier and came straight back.
    //
    // The owner's rule settles it: "If matches, then credit him. If not matches, leave him." A
    // mapping identifies a PERSON, never a period, so it cannot answer for a day they were not
    // employed — no matter that nothing else can answer either.
    //
    // The risk the old fallback was protecting against is real and is still covered, in the two
    // places that actually address it. A mapping that leaves pre-hire rows unassigned says so at save
    // time, naming the count and dates (setUnmappedCrmIdentityResolution) — so an admin is never
    // left believing it credited them. And a refusal here is a block rather
    // than a silent null, so the row stays honestly unattributed instead of quietly reverting to
    // whatever stale hr id it carried before, which is what "silently did nothing" would really
    // have looked like. (The block is flagged blockedByOverride and deliberately kept OUT of the
    // sync's two "needs an identity override" counters — it is settled, not actionable.)
    const overridden = maps.hrIdByManualOverride.get(String(crmId));
    if (overridden) {
      const recordLabel = normalizeCrmName(name);
      if (!overridden.label || !recordLabel || overridden.label === recordLabel) {
        if (isAttributableOn(overridden.hrId, visitDate, maps, name)) {
          return { blockedHrId: null, hrId: overridden.hrId };
        }
        overrideRefusedHrId = overridden.hrId;
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
  if (!key) return overrideRefusal(overrideRefusedHrId);
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
  if (!byName) return overrideRefusal(overrideRefusedHrId);
  // A tier that matched and was REFUSED ends the waterfall on its OWN block, which is the more
  // specific answer: this tier names the person the record's own crm_id or label points at, where an
  // override refusal names whoever the slot was mapped to. Neither credits the row. Slot 1391's
  // 06-03..06-19 gap is the case — the leaver had gone and the joiner had not started — and
  // crediting it to either of them would invent work nobody did.
  if (!isAttributableOn(byName, visitDate, maps, name)) return { blockedHrId: byName, hrId: null };
  return { blockedHrId: null, hrId: byName };
}

/** No automatic tier answered. If tier 1 matched a slot but the mapped person's employment does not
 * cover this date, the row is refused and REPORTED — never credited to them.
 *
 * Reported rather than silent, because those are two different absences. A silent attribution means
 * "no information", and preserveResolvedIdentities restores whatever hr id the row already carried —
 * which would quietly reinstate the stale attribution the mapping exists to correct. A block says a
 * specific person was considered and was not employed that day, so the row stays honestly
 * unattributed. It carries blockedByOverride so the sync can tell this settled refusal apart from an
 * automatic block, which is a live handover somebody still has to answer.
 *
 * With no override in play at all, null/null is still right: nothing was considered. */
function overrideRefusal(overrideRefusedHrId: string | null): CrmAttribution {
  if (!overrideRefusedHrId) return { blockedHrId: null, hrId: null };
  return { blockedByOverride: true, blockedHrId: overrideRefusedHrId, hrId: null };
}

/** One unattributed visit slot (agent or double) as the settled-row test reads it. */
export type UnmappedSlotRow = {
  crmId: number | null;
  label: string | null;
  visitDate: string | null;
  visitType: number | null;
};

/**
 * Everyone this row's CRM LABEL names: the person whose own crm_username it is, the account's
 * crm_id holder when the label is theirs, and the person a mapping recorded against this exact
 * label. Empty when the label names nobody we know: a stranger's name, a name-stripped
 * "( Area / X )" label, or no label at all.
 *
 * The label is the only evidence of who DID a row's work. A crm_id says whose account it is, and an
 * account passes from one holder to the next. A mapping saved without a label names the account
 * too, never a person, so it names nobody here.
 */
function peopleNamedByLabel(row: UnmappedSlotRow, maps: CrmIdentityMaps): string[] {
  const label = normalizeCrmName(row.label);
  if (!label) return [];
  const named = new Set<string>();
  const byUsername = maps.hrIdByCrmUsername.get(label);
  if (byUsername) named.add(byUsername);
  if (row.crmId != null) {
    const holder = maps.hrIdByCrmId.get(String(row.crmId));
    if (holder && maps.crmUsernameByHrId.get(holder) === label) named.add(holder);
    const override = maps.hrIdByManualOverride.get(String(row.crmId));
    if (override?.label === label) named.add(override.hrId);
  }
  return [...named];
}

/**
 * Is this unattributed row already ANSWERED, so it needs no decision on the Unmapped Agents list
 * and no alarm from the sync? The owner's rule for that list, 2026-09-21: "always clean — except
 * when there is a real unmapped agent". A row is settled in two shapes:
 *
 *   1. It records NO WORK: a public-holiday or casual-leave marker. iReports360 sprays one across
 *      every account on the day, including accounts nobody held that day. On production
 *      2026-09-21, 21 of the 25 accounts left on the list carried nothing but these markers.
 *   2. Its label names a KNOWN employee, and nobody it names was employed that day. The employee
 *      is known and the date rule answers the row: "GIVE HIM STARTING FROM HIS HIRING DATE" (owner,
 *      2026-09-21, on Ahmed Nabil's account; his rule since 2026-08-28: "If matches, then credit
 *      him. If not matches, leave him."). When an account changes hands, iReports360 relabels the
 *      previous holder's rows with the new holder's name. Those rows are not the new holder's, and
 *      no decision on this screen could make them so. Listing them made every handed-over account
 *      look broken. Ahmed Nabil's 33 rows from 7 to 15 May, before he joined on 16 May, are the case.
 *
 * Three shapes stay listed, because each is work that someone still has to act on:
 *   - the label names NOBODY we know: a stranger, a stripped "( Area / X )" label, or no label at
 *     all. This is the real unmapped agent: somebody did this work and the roster cannot say who.
 *     A reused slot shows up here too: the new holder's calls arrive after the old holder left.
 *   - a person the label names WAS employed that day, but the waterfall reached someone else first,
 *     for example a leaver who still holds the account's crm_id. Mapping the account credits them.
 *   - the resolver credits somebody today but the stored row still says nobody. It is waiting to be
 *     stamped, and the Map button stamps it.
 *
 * Shared by the list (getUnmappedCrmIdentities) and whatever reads the same slots beside it, so the
 * two can never disagree about which rows count. Reconciliation check 9 and the sync's block counters
 * were its other two readers until both were retired with iReports360 (6-7 Nov 2026).
 */
export function isSettledUnmappedRow(row: UnmappedSlotRow, maps: CrmIdentityMaps): boolean {
  if (row.crmId == null) return false;
  if (recordsNoWorkToAttribute(row.visitType)) return true;
  return isHandedOverLabel(row, maps);
}

/**
 * Shape 2 above, on its own: the row has no hr id, its label names known employees, and NONE of them was
 * employed that day — so iReports360 relabelled a PREVIOUS holder's row with the account's later
 * holder's name, and the name printed on it is not the person who made it. Phoenix's own hiring dates
 * are the source of trust (owner, 2026-10-22: "once got data from phoenix crm then phoenix is the source
 * of trust and its data override old crm data"), so a screen that prints this row prints
 * {@link previousHolderLabel}, never the vendor's name.
 */
export function isHandedOverLabel(row: UnmappedSlotRow, maps: CrmIdentityMaps): boolean {
  if (row.crmId == null) return false;
  const day = row.visitDate?.slice(0, 10) || null;
  if (resolveEmployeeAttribution(row.crmId, row.label, maps, day).hrId !== null) return false;
  const named = peopleNamedByLabel(row, maps);
  if (named.length === 0) return false;
  return !named.some((hrId) => isAttributableOn(hrId, day, maps, row.label));
}

/** What a handed-over row ({@link isHandedOverLabel}) prints instead of the later holder's name: the
 * account's territory kept, so a board that reads the territory off the label still finds it. */
export const PREVIOUS_HOLDER_LABEL = "Previous holder";

export function previousHolderLabel(vendorLabel: string | null | undefined): string {
  const territory = /(\([^()]*\))\s*$/.exec(vendorLabel?.trim() ?? "")?.[1];
  return territory ? `${PREVIOUS_HOLDER_LABEL} ${territory}` : PREVIOUS_HOLDER_LABEL;
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
