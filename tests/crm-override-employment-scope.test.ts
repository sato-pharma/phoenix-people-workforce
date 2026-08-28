import assert from "node:assert/strict";

import { buildCrmIdentityMaps, resolveEmployeeAttribution, resolveEmployeeHrId } from "../src/lib/crm/identity.ts";
import { isSilentAttribution } from "../src/lib/crm/sync.ts";
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
 * IT YIELDS, IT DOES NOT LOSE. Where no automatic tier can answer either, the override applies
 * after all — section (C) is that assertion and it is the one that keeps this safe. An override is
 * a human's hand-verified decision, so a roster date must be able to SUPERSEDE it with better
 * evidence but never to veto it into nothing: a mapping that saved successfully and then silently
 * did nothing would be a worse failure than the miscredit being fixed here, because it leaves the
 * admin no way to tell and no way to fix it. crm-post-exit-attribution (F) and
 * crm-pre-hire-attribution (J) pin that authority from the other side and both still pass unchanged.
 *
 * ONE CASE IS NEITHER: a tier that matched and was REFUSED (section B). That is positive evidence
 * that nobody eligible owns the row, so it stays a block rather than falling back on the override.
 *
 * Measured across every mapped override in production on 2026-08-28, agent and double side, exactly
 * one row sits outside its mapped person's span: slot 1536 -> B-164, one visit dated 2026-08-27, ten
 * days past that employee's last working day. Neither automatic tier resolves it, so it keeps the
 * override. NO existing attribution moves — this path exists for slot 1391 and the handovers after it.
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
  assert.equal(isSilentAttribution(gap), false, "a gap date is a decision, not an absence of information");

  // ── (C) With NOTHING to yield to, the override still applies ────────────────────────────────
  //
  // Same slot, but no second occupant on the roster at all. The date sits outside the mapped
  // person's span and no automatic tier has anything to say, so the human's decision is the only
  // evidence in existence and it stands. This is the assertion that stops the employment scope
  // above from turning into a veto: without it an admin could save a mapping from the Unmapped
  // Agents screen, see no error, and have it do nothing at all — the same authority that
  // crm-post-exit-attribution (F) and crm-pre-hire-attribution (J) pin from the other side.
  const leaverOnly = buildCrmIdentityMaps([leaver], mappedToLeaver);
  const orphaned = resolveEmployeeAttribution(1391, LABEL, leaverOnly, "2026-07-20");
  assert.equal(
    orphaned.hrId,
    "B-85",
    "no automatic tier can answer, so the admin's decision is not discarded — a mapping is " +
      "superseded by better evidence, never defeated by the absence of any",
  );
  assert.equal(
    orphaned.blockedHrId,
    null,
    "and it is not a block: a block means somebody must decide this, and somebody already has",
  );
  assert.equal(isSilentAttribution(orphaned), false, "an attributed row is never silent");

  // And with no label on the record at all (check-ins carry a crm_id only), the same holds.
  assert.equal(
    resolveEmployeeHrId(1391, null, leaverOnly, "2026-07-20"),
    "B-85",
    "a label-less record falls back on the override too — check-ins must keep their GPS overlay",
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
