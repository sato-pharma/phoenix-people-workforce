import assert from "node:assert/strict";

import { buildCrmIdentityMaps, resolveEmployeeAttribution, resolveEmployeeHrId } from "../src/lib/crm/identity.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { CrmResolutionRow } from "../src/lib/crm/types.ts";

function employee(overrides: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return { crmId: null, crmUsername: null, hireDate: null, lastWorkingDate: null, ...overrides } as EmployeeDirectoryRow;
}

/**
 * A MANUAL OVERRIDE IS SCOPED TO THE MAPPED PERSON'S OWN EMPLOYMENT, AND FALLS THROUGH OUTSIDE IT.
 *
 * THE SHAPE THIS EXISTS FOR (production slot 1391, resolved with the owner 2026-08-28). One CRM
 * account, two holders in sequence:
 *
 *   Tayseer Khaled  hired 2025-10-11, last working day 2026-06-02  -> 1,136 calls  2026-01-01..06-01
 *   Soad Atef       hired 2026-06-20                               ->    28 calls  2026-07-20..08-27
 *
 * Every one of those 1,164 rows carries the SAME label, "Soad.Atef ( Cairo East 1 / A )", because
 * iReports360 rewrites the whole history with the current holder's name when an account changes
 * hands. A mapping carries no time dimension, so mapping that slot to either person unconditionally
 * miscredits the other's work — to Soad it hands 1,136 calls she could not have made, and to
 * Tayseer it hands 28 dated after she had already left.
 *
 * Scoping the override to the mapped person's employment resolves BOTH halves from a single
 * mapping. The dates inside their tenure are theirs; the dates outside stand aside and let the
 * automatic tiers find the other occupant by name.
 *
 * AND WHERE NO AUTOMATIC TIER CAN ANSWER EITHER, THE ROW IS REFUSED — not credited to the mapped
 * person anyway. Section (C) is that assertion. This shipped the other way on the morning of
 * 2026-08-28, as a fallback: the reasoning was that a human's hand-verified decision must never be
 * vetoed into nothing by a roster date. The production data answered it the same day. At 09:34:57
 * Cairo the hourly sync re-credited 40 rows to people who had already left — 27 August
 * public-holiday markers landing on four leavers whose retired accounts no automatic tier could
 * resolve — every one of them cleared by hand an hour earlier, and every one straight back.
 *
 * The owner's rule, given that afternoon: "you will see when he is hired and when he is resigned,
 * and his area and his line. If matches, then credit him. If not matches, leave him." A mapping
 * names a PERSON, never a period. It cannot answer for a day they were not employed, and "nothing
 * else can answer either" is not a reason to let it.
 *
 * WHAT KEEPS THAT SAFE IS THAT A REFUSAL IS REPORTED, NOT DISCARDED. The decision does not vanish:
 * the row comes back as a block naming the mapped person, so it is never silent, and
 * preserveResolvedIdentities cannot quietly restore the stale hr id the mapping was correcting. The
 * pre-hire end of the same risk is covered where it belongs — setUnmappedCrmIdentityResolution
 * REFUSES such a mapping at save time, loudly, before anything is written. Between them an admin
 * cannot save a mapping that silently does nothing, which was the real fear behind the fallback.
 *
 * ONE CASE IS SEPARATE: a tier that matched and was REFUSED (section B). It blocks on its OWN
 * person — the more specific answer — rather than on the override's.
 *
 * Measured across every mapped override in production on 2026-08-28, agent and double side: this
 * change moves 9 rows across 7 retired slots, every one a public-holiday or meeting marker on a
 * name-stripped account, and 0 real doctor visits. The two large groups are untouched because an
 * automatic tier already answers them — slot 1391's 28 rows resolve to Soad Atef by her own label,
 * and slot 1399's 24 (19 of them real calls) to Mohamed Yasser by his.
 */
export function runCrmOverrideEmploymentScopeTests() {
  const LABEL = "Soad.Atef ( Cairo East 1 / A )";

  // The real roster: the leaver carries no CRM identity of her own (hers was handed over), the
  // joiner is findable only by the label the vendor stamped across the whole account.
  const leaver = employee({
    hrId: "B-85",
    hireDate: "2025-10-11",
    lastWorkingDate: "2026-06-02",
  });
  const joiner = employee({
    hrId: "AI-0003",
    crmUsername: LABEL,
    hireDate: "2026-06-20",
  });
  // The admin's decision: slot 1391's history belongs to the rep who actually held it.
  const mappedToLeaver: CrmResolutionRow[] = [{ crmId: 1391, mappedHrId: "B-85", status: "mapped" }];
  const maps = buildCrmIdentityMaps([leaver, joiner], mappedToLeaver);

  // ── (A) THE HEADLINE. One mapping, and BOTH people end up with their own work ───────────────
  assert.equal(
    resolveEmployeeHrId(1391, LABEL, maps, "2026-01-01"),
    "B-85",
    "a date inside the mapped person's tenure is hers — this is the 1,136-call half being recovered",
  );
  assert.equal(
    resolveEmployeeHrId(1391, LABEL, maps, "2026-06-01"),
    "B-85",
    "her last working day is 06-02, so 06-01 is still hers",
  );
  assert.equal(
    resolveEmployeeHrId(1391, LABEL, maps, "2026-07-20"),
    "AI-0003",
    "a date AFTER she left falls through to the label tier and stays with the rep who really made " +
      "it — without the fall-through this mapping would steal the new rep's own 28 visits",
  );
  assert.equal(
    resolveEmployeeHrId(1391, LABEL, maps, "2026-08-27"),
    "AI-0003",
    "the whole post-handover range belongs to the joiner",
  );

  // ── (B) The gap between the two tenures belongs to NOBODY, and says so ──────────────────────
  //
  // 06-03 to 06-19: the leaver has gone and the joiner has not started. The override cannot claim
  // it (outside her span) and the label tier matches the joiner but refuses him (before his hire
  // date). A refused match is positive evidence that nobody eligible owns the row, so this must be
  // a BLOCK — not the override falling back, which would invent work eight days after she left,
  // and not a silent null, which lets preserveResolvedIdentities restore the very stale hr id the
  // override was correcting.
  const gap = resolveEmployeeAttribution(1391, LABEL, maps, "2026-06-10");
  assert.equal(gap.hrId, null, "nobody was employed on that date — the override must NOT rescue it");
  assert.equal(gap.blockedHrId, "AI-0003", "the refusal is reported, so the sync counts and alerts on it");

  // ── (C) With NOTHING to yield to, the override is REFUSED — it does not credit anyway ───────
  //
  // Same slot, but no second occupant on the roster at all. The date sits outside the mapped
  // person's span and no automatic tier has anything to say. The row is still not hers: a mapping
  // names a person, not a period, and 07-20 is seven weeks after she left. THIS IS THE ASSERTION
  // THAT WAS INVERTED — it read "B-85" for one morning, and the hourly sync used it to re-credit 40
  // rows to leavers before the day was out.
  const leaverOnly = buildCrmIdentityMaps([leaver], mappedToLeaver);
  const orphaned = resolveEmployeeAttribution(1391, LABEL, leaverOnly, "2026-07-20");
  assert.equal(
    orphaned.hrId,
    null,
    "outside her employment the mapping cannot credit her, even with nothing else to answer",
  );
  // Reported, not discarded — the difference between refusing a decision and losing it. A silent
  // null lets preserveResolvedIdentities restore the stale hr id this mapping exists to correct.
  assert.equal(orphaned.blockedHrId, "B-85", "the refusal names the person it refused");
  assert.equal(
    orphaned.blockedByOverride,
    true,
    "and it is flagged as the SETTLED kind of block — somebody already recorded who owns this slot, " +
      "so it must not be counted as a row still needing an identity override",
  );

  // And with no label on the record at all (check-ins carry a crm_id only), the same holds.
  assert.equal(
    resolveEmployeeHrId(1391, null, leaverOnly, "2026-07-20"),
    null,
    "a label-less record is refused too — a check-in seven weeks past her exit is not her check-in",
  );

  // ── (D) An override with no employment dates behaves exactly as before ──────────────────────
  //
  // This is crm-pre-hire-attribution section (J)'s shape: the mapped target is not on the roster at
  // all, so there is no span to scope against and the override wins unconditionally, including for
  // dates before the SLOT's other occupant joined. Nothing about that may change.
  const unknownTarget = buildCrmIdentityMaps([joiner], [{ crmId: 1391, mappedHrId: "B-999", status: "mapped" }]);
  assert.equal(
    resolveEmployeeHrId(1391, null, unknownTarget, "2026-01-01"),
    "B-999",
    "an override onto someone with no recorded employment span still wins outright",
  );
  assert.equal(
    resolveEmployeeAttribution(1391, null, unknownTarget, "2026-01-01").blockedHrId,
    null,
    "and it is not a block — nothing needs alerting once a human has decided",
  );

  // ── (E) An override still overrules the ROSTER DATE inside the person's own tenure ──────────
  //
  // The authority order that made tier 1 exempt is intact where it matters: the mapped person's own
  // hire date is what scopes the override, NOT the other occupant's. A date that the label tier
  // would refuse as pre-hire is still attributed, because the mapped person was employed then.
  assert.equal(
    resolveEmployeeHrId(1391, LABEL, maps, "2026-02-14"),
    "B-85",
    "the joiner's hire date does not constrain a mapping made to somebody else",
  );

  // ── (F) Label scoping is unchanged ──────────────────────────────────────────────────────────
  //
  // A record carrying a DIFFERENT label was never claimed by this decision and still is not, even
  // for a date squarely inside the mapped person's tenure.
  const shared = buildCrmIdentityMaps(
    [leaver, employee({ hrId: "B-200", crmUsername: "Nada.Mohammed ( Tanta / E )", hireDate: "2025-01-01" })],
    [{ crmId: 1391, crmName: LABEL, mappedHrId: "B-85", status: "mapped" }],
  );
  assert.equal(
    resolveEmployeeHrId(1391, "Nada.Mohammed ( Tanta / E )", shared, "2026-03-01"),
    "B-200",
    "another person's label on a shared slot still falls through to their own resolution",
  );
  assert.equal(
    resolveEmployeeHrId(1391, LABEL, shared, "2026-03-01"),
    "B-85",
    "and the decision's own label still resolves to the mapped person",
  );

  // ── (G) The post-exit label rule is not re-litigated by this change ─────────────────────────
  //
  // Someone whose OWN label is on a record past their exit is logging their own trailing work, and
  // isAttributableOn allows it. An override onto such a person must therefore still apply there —
  // the scoping delegates to that same rule rather than inventing a stricter one.
  const trailing = buildCrmIdentityMaps(
    [employee({ hrId: "B-162", crmUsername: "Veronica.Ashraf ( Alex Center / A )", lastWorkingDate: "2026-05-31" })],
    [{ crmId: 1500, mappedHrId: "B-162", status: "mapped" }],
  );
  assert.equal(
    resolveEmployeeHrId(1500, "Veronica.Ashraf ( Alex Center / A )", trailing, "2026-06-05"),
    "B-162",
    "trailing work under the person's OWN label stays theirs, mapped or not",
  );
}
