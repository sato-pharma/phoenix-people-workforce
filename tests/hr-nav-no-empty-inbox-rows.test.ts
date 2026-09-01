import assert from "node:assert/strict";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import { HR_ROLE_BUNDLES, type HrBundleName } from "../src/lib/auth/hr-functions.ts";
import {
  buildPermissionLookup,
  permissionMatrix,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { getSections } from "../src/lib/navigation/active-path.ts";

/**
 * An HR sidebar row must never open an inbox the seat can hold nothing in.
 *
 * Two rows have now had exactly this defect, seven weeks apart and for the same reason each time:
 * both are offered on `leave:read`, which HR Advisory holds ONLY for her own vacation requests,
 * and both open a page whose contents come from grants she does not have.
 *
 *   Leave Management  excluded 2026-08-29 — listed 0 of 3 children for her
 *   Other Approvals   excluded 2026-09-01 — shows resignation / contract renewal / outstation,
 *                     and her composed matrix holds NO grant for any of the three
 *
 * The failure mode is why this is pinned rather than left to review: an always-empty inbox does not
 * read as "not for you", it reads as a broken page — and Other Approvals additionally carries a
 * pending-count badge, so it advertises a queue that can never become hers.
 *
 * `leave:read` is the trap. It is the grant that lets someone request their OWN vacation, so every
 * seat has it, and any row gated on it is offered to everybody — while the page behind it answers
 * to entirely different resources. A future row gated the same way will repeat this a third time.
 */

/** The resources whose rows populate the "Other Approvals" inbox. */
const OTHER_APPROVALS_MODULES = ["resignations", "contracts", "outstation"] as const;

const OTHER_APPROVALS_HREF = "/hr/admin/approvals-hub";
const LEAVE_MANAGEMENT_HREF = "/hr/leave-management";

/**
 * Every HR nav row actually offered to `seat`, resolved through the real navigation resolver and
 * the real lookup builder.
 *
 * `buildPermissionLookup` rather than a hand-rolled loop deliberately: a locally-built lookup can
 * silently disagree with the one the shells actually pass — an absent grant must read `false`, not
 * `undefined`, or a row gated on it flips open. `tests/navigation-permission-lookup-total.test.ts`
 * ratchets on exactly this and caught the first draft of this file.
 */
function offeredHrefs(seat: HrBundleName): Set<string> {
  const role = seat as unknown as PhoenixRole;
  const rows = getSections(
    getNavigationSections("hr"),
    "hr",
    buildPermissionLookup(permissionMatrix, role),
    role,
  ).flatMap((section) => section.items);

  assert.ok(
    rows.length >= 10,
    `"${seat}" is offered only ${rows.length} HR nav rows — the shell did not build, so every ` +
      "assertion below would pass vacuously",
  );
  return new Set(rows.map((row) => row.href));
}

export function runHrNavNoEmptyInboxRowsTests() {
  const seats = Object.keys(HR_ROLE_BUNDLES) as HrBundleName[];
  assert.deepEqual(
    seats,
    ["HR Advisory", "HR Operations"],
    "this file reasons about exactly two HR seats; a third bundle needs its own verdict here " +
      "rather than being silently unchecked",
  );

  const advisory = offeredHrefs("HR Advisory");
  const operations = offeredHrefs("HR Operations");

  // ── The headline ────────────────────────────────────────────────────────────
  assert.equal(
    advisory.has(OTHER_APPROVALS_HREF),
    false,
    'the HR Business Partner is offered "Other Approvals", an inbox that shows only resignation, ' +
      "contract-renewal and outstation rows — she holds no grant for any of the three, so it can " +
      "never contain one row for her, and it carries a pending badge while being empty",
  );

  // The 2026-08-29 precedent, pinned in the same place so the pair cannot drift apart.
  assert.equal(
    advisory.has(LEAVE_MANAGEMENT_HREF),
    false,
    'the HR Business Partner is offered "Leave Management", which listed 0 of 3 children for her ' +
      "when it was excluded on 2026-08-29",
  );

  // ── The other seat must keep both ───────────────────────────────────────────
  // Excluding one seat from a shared row is one edit away from deleting the row. HR Operations
  // holds resignations and contracts at read/create/update/export and owns leave administration.
  for (const href of [OTHER_APPROVALS_HREF, LEAVE_MANAGEMENT_HREF]) {
    assert.equal(
      operations.has(href),
      true,
      `the HR Operations Coordinator lost "${href}". Excluding HR Advisory from a shared row must ` +
        "narrow it for HER only — removing the row outright takes it from the seat whose job it is",
    );
  }

  // ── Why the exclusion is correct, not merely current ────────────────────────
  // Tie the verdict to its cause, and RE-DECIDED on 2026-09-01 when she was granted contracts.
  //
  // The original reason was "she holds none of resignations/contracts/outstation". That stopped
  // being true the day the owner asked for Contract Renewal in her sidebar, and this assertion
  // fired — which is what it is for. The verdict did not change, but the reason had to:
  //
  //   the hub is getAwaitingMyActionItems(access, "admin") — an inbox of things awaiting MY
  //   ACTION. Her contracts grant is READ. She advises on a renewal and cannot decide one, so no
  //   row in that inbox can ever be hers to act on and the page is still structurally empty for
  //   her, exactly as before. An empty inbox reads as a broken page, and this one also carries a
  //   pending-count badge, so it would advertise work that can never become hers.
  //
  // So the test now asks the sharper question: not "does she hold the resource at all" but "can
  // she ACT on it". The day she is granted update or approve on any of the three, the exclusion is
  // genuinely wrong and this fires again.
  const advisoryGrants = permissionMatrix["HR Advisory" as PhoenixRole];
  const actionableActions = ["update", "approve"] as const;
  for (const resource of OTHER_APPROVALS_MODULES) {
    const actions = advisoryGrants?.[resource] ?? [];
    const actionable = actions.filter((action) =>
      (actionableActions as readonly string[]).includes(action),
    );
    assert.equal(
      actionable.length,
      0,
      `HR Advisory now holds ${resource}: ${JSON.stringify(actions)} — including an ACTIONABLE ` +
        'action. "Other Approvals" is excluded for her because she can decide nothing in it; that ' +
        "reason no longer holds, so re-decide the row rather than leaving a stale exclusion",
    );
  }
}
