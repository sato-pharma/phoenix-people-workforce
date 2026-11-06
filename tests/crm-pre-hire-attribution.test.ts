import assert from "node:assert/strict";

import {
  blockReasonFor,
  buildCrmIdentityMaps,
  isAttributableOn,
  resolveEmployeeAttribution,
  resolveEmployeeHrId,
} from "../src/lib/crm/identity.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { CrmResolutionRow } from "../src/lib/crm/types.ts";

/** Minimal directory row — only the fields the identity waterfall reads. */
function employee(overrides: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return {
    crmId: null,
    crmUsername: null,
    hireDate: null,
    lastWorkingDate: null,
    ...overrides,
  } as EmployeeDirectoryRow;
}

/**
 * PRE-HIRE ATTRIBUTION GUARD — nobody is credited with work dated before they joined.
 *
 * THE INCIDENT THIS PINS (production, measured 2026-08-28). 1,619 mirror rows — 1,114 of them real
 * doctor calls, across 34 employees — were attributed to somebody dated before their hire date. The
 * largest single case: one rep credited with 931 real calls reaching 207 days before she joined,
 * because she inherited the CRM account of the person who held that territory before her.
 *
 * WHY IT NEEDS ITS OWN GUARD RATHER THAN REUSING THE POST-EXIT ONE. The post-exit half decides by
 * comparing the record's CRM label against the employee's own, which cleanly separates a handed-over
 * account from someone's final days logged late. That test is not merely unavailable here, it is
 * actively WRONG: when an account changes hands the vendor REWRITES the label on the previous
 * occupant's historic rows to the new occupant's name. 1,248 of those 1,619 rows (77%) therefore
 * carry the current holder's own label, and a label test would wave every one of them through.
 * Section (C) below is the assertion that pins this, and it is the headline of the whole file.
 *
 * WHY THERE IS NO GRACE WINDOW. The measured gap distribution leaves nothing for one to protect —
 * 49 rows land 1-7 days before a hire date and NONE of them is a real call (they are admin
 * broadcasts, a public holiday published to the whole CRM roster which already lists next week's
 * joiner). Every real call sits 9 days or more before the hire date. See isAttributableOn.
 */
export function runCrmPreHireAttributionTests() {
  // The real shape: a rep inherits the CRM account of the person who held her territory before her.
  // Her roster row carries the account's crm_id and, after the vendor's relabel, its label too.
  const joiner = employee({
    hrId: "AI-0003",
    crmId: "1602",
    crmUsername: "Soad.Atef ( Cairo East 1 / A )",
    hireDate: "2026-06-20",
  });
  const maps = buildCrmIdentityMaps([joiner]);

  // ── (A) Work on or after the hire date is hers ───────────────────────────────────────────
  assert.equal(
    resolveEmployeeHrId(1602, "Soad.Atef ( Cairo East 1 / A )", maps, "2026-07-15"),
    "AI-0003",
    "work well inside employment must stay attributed",
  );
  assert.equal(
    resolveEmployeeHrId(1602, "Soad.Atef ( Cairo East 1 / A )", maps, "2026-06-20"),
    "AI-0003",
    "the hire date itself is INCLUSIVE — that day was worked",
  );

  // ── (B) Work dated before the hire date is refused, and the refusal is REPORTED ───────────
  assert.equal(
    resolveEmployeeHrId(1602, "Soad.Atef ( Cairo East 1 / A )", maps, "2026-06-19"),
    null,
    "a visit one day before the hire date must not be attributed",
  );
  const blocked = resolveEmployeeAttribution(1602, "Soad.Atef ( Cairo East 1 / A )", maps, "2026-01-01");
  assert.equal(blocked.hrId, null, "pre-hire work resolves to nobody");
  assert.equal(
    blocked.blockedHrId,
    "AI-0003",
    "the blocked hr id is reported so the sync can COUNT and alert, not just see a bare null",
  );

  // ── (C) THE HEADLINE. The employee's OWN label must NOT rescue a pre-hire row ─────────────
  //
  // This is the single assertion that separates this guard from the post-exit one. Every call above
  // already passes the employee's own label, which is exactly what the post-exit rule treats as
  // proof of ownership. If someone "unifies" the two ends by applying the label test here, this
  // fails — and 1,248 of the 1,619 real production rows go straight back to being miscredited.
  assert.equal(
    isAttributableOn("AI-0003", "2026-05-07", maps, "Soad.Atef ( Cairo East 1 / A )"),
    false,
    "a pre-hire row carrying the employee's OWN CRM label is STILL refused — the vendor rewrites " +
      "labels on historic rows when an account changes hands, so the label proves nothing here",
  );

  // ── (D) The username tier is where this does its most important work ─────────────────────
  //
  // The relabelled historic rows resolve by NAME, correctly by label and wrongly by person. Tier 3
  // has to block them too, or the guard only covers accounts whose crm_id is on the roster.
  const byNameOnly = buildCrmIdentityMaps([
    employee({ hrId: "AI-0003", crmUsername: "Soad.Atef ( Cairo East 1 / A )", hireDate: "2026-06-20" }),
  ]);
  assert.equal(
    resolveEmployeeHrId(null, "Soad.Atef ( Cairo East 1 / A )", byNameOnly, "2026-06-25"),
    "AI-0003",
    "the username tier still resolves during employment",
  );
  assert.equal(
    resolveEmployeeHrId(null, "Soad.Atef ( Cairo East 1 / A )", byNameOnly, "2026-05-07"),
    null,
    "the username tier must refuse a pre-hire date too, not just the crm_id tier",
  );
  assert.equal(
    resolveEmployeeAttribution(null, "Soad.Atef ( Cairo East 1 / A )", byNameOnly, "2026-05-07").blockedHrId,
    "AI-0003",
    "a username-tier block is reported the same way, so it is counted and alerted on",
  );

  // ── (F) An employee with no recorded hire date is never blocked ──────────────────────────
  const noHireDate = buildCrmIdentityMaps([
    employee({ hrId: "B-500", crmId: "1700", crmUsername: "Nobody.Known ( Giza / P )" }),
  ]);
  assert.ok(
    isAttributableOn("B-500", "2020-01-01", noHireDate),
    "an unknown start date is not evidence of anything — never block on a missing hire date",
  );
  assert.ok(isAttributableOn("UNKNOWN-HR", "2020-01-01", maps), "an hr id absent from the map is not blocked");
  assert.ok(isAttributableOn("AI-0003", null, maps), "a null date cannot block anything");
  assert.equal(
    resolveEmployeeHrId(1700, "Nobody.Known ( Giza / P )", noHireDate, "2020-01-01"),
    "B-500",
    "resolution is unchanged for an employee whose hire date was never recorded",
  );

  // ── (G) A timestamp compares by its DATE part ────────────────────────────────────────────
  assert.equal(
    isAttributableOn("AI-0003", "2026-06-19T23:59:00", maps),
    false,
    "a timestamp on the day before the hire date is blocked",
  );
  assert.ok(
    isAttributableOn("AI-0003", "2026-06-20T00:05:00", maps),
    "a timestamp on the hire date itself is attributable",
  );

  // ── (H) Both ends together: the attributable span is hire date .. last working day ────────
  const spanned = buildCrmIdentityMaps([
    employee({
      hrId: "B-300",
      crmId: "1800",
      crmUsername: "Mid.Tenure ( Tanta / F )",
      hireDate: "2026-03-01",
      lastWorkingDate: "2026-05-31",
    }),
  ]);
  assert.equal(isAttributableOn("B-300", "2026-02-28", spanned, "Mid.Tenure ( Tanta / F )"), false, "before the span");
  assert.ok(isAttributableOn("B-300", "2026-03-01", spanned, "Mid.Tenure ( Tanta / F )"), "first day of the span");
  assert.ok(isAttributableOn("B-300", "2026-04-15", spanned, "Mid.Tenure ( Tanta / F )"), "inside the span");
  assert.ok(isAttributableOn("B-300", "2026-05-31", spanned, "Mid.Tenure ( Tanta / F )"), "last day of the span");
  // Past the exit the label test still applies — this is the person's own label, so it is their own
  // trailing work and stays attributable. The two ends keep their different rules.
  assert.ok(
    isAttributableOn("B-300", "2026-06-01", spanned, "Mid.Tenure ( Tanta / F )"),
    "post-exit still allows the person's OWN trailing work — adding the pre-hire half must not " +
      "change how the other end behaves",
  );
  assert.equal(
    isAttributableOn("B-300", "2026-06-01", spanned, "Someone.Else ( Tanta / F )"),
    false,
    "post-exit still blocks a handed-over slot",
  );

  // ── (I) The two blocks are reported apart, because they mean different things ─────────────
  assert.equal(
    blockReasonFor("B-300", "2026-02-28", spanned),
    "pre_hire",
    "a date before the hire date classifies as pre-hire",
  );
  assert.equal(
    blockReasonFor("B-300", "2026-06-01", spanned),
    "post_exit",
    "a date after the last working day classifies as post-exit",
  );
  assert.equal(
    blockReasonFor("B-500", "2020-01-01", noHireDate),
    "post_exit",
    "with no hire date recorded there is nothing to call pre-hire",
  );

  // ── (J) An explicit admin override still WINS, including for pre-hire dates ───────────────
  //
  // Same authority order the post-exit guard already documents: tier 1 is a human's hand-verified
  // decision about who owns a CRM slot, and it is the intended way to record "this slot's history
  // belongs to this person". Guarding it would let a roster date veto the very correction an admin
  // makes in response to this guard's own alert, which would leave the rows permanently unfixable.
  const resolutions: CrmResolutionRow[] = [{ crmId: 1602, mappedHrId: "B-999", status: "mapped" }];
  const overridden = buildCrmIdentityMaps([joiner], resolutions);
  assert.equal(
    resolveEmployeeHrId(1602, null, overridden, "2026-01-01"),
    "B-999",
    "an explicit identity override resolves the slot's history to the real owner",
  );
  assert.equal(
    resolveEmployeeAttribution(1602, null, overridden, "2026-01-01").blockedHrId,
    null,
    "an override is not a blocked attribution — nothing needs alerting once a human has decided",
  );

  // ── (K) No date supplied → previous behaviour, so no caller silently starts failing ───────
  assert.equal(
    resolveEmployeeHrId(1602, "Soad.Atef ( Cairo East 1 / A )", maps),
    "AI-0003",
    "with no visit date to judge against, resolution is unchanged",
  );
}
