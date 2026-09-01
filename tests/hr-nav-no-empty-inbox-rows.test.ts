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

  // ── The other seat keeps Leave Management ───────────────────────────────────
  // Excluding one seat from a shared row is one edit away from deleting the row. HR Operations
  // owns leave administration, so this one must survive every narrowing aimed at HR Advisory.
  assert.equal(
    operations.has(LEAVE_MANAGEMENT_HREF),
    true,
    `the HR Operations Coordinator lost "${LEAVE_MANAGEMENT_HREF}". Excluding HR Advisory from a ` +
      "shared row must narrow it for HER only — removing the row outright takes it from the seat " +
      "whose job it is",
  );

  // ── Other Approvals is off HER rail too, for a DIFFERENT reason ─────────────
  //
  // This is the one assertion in the file that is not about emptiness, and the distinction is the
  // reason it is spelled out rather than folded into the loop above. HR Advisory is excluded
  // because the inbox can never hold a row for her. HR Operations is excluded because the owner
  // asked for it off her rail on 2026-09-01 while tidying the seat — "Remove other approvals from
  // the sidebar" — and her queue is NOT empty: she holds resignations and contracts at
  // read/create/update/export, which the block at the end of this file still proves.
  //
  // So a future session that re-derives this from grants will conclude the row belongs to her and
  // be wrong. It is an instruction, not a defect, and the page stays reachable from the admin rail
  // and by URL.
  assert.equal(
    operations.has(OTHER_APPROVALS_HREF),
    false,
    'the HR Operations Coordinator is offered "Other Approvals" again. The owner removed it from '
      + "her rail on 2026-09-01. Her grants DO populate that queue, so do not restore the row on "
      + "the grounds that she can use it — that reverses an instruction rather than fixing a bug.",
  );

  // ── Workforce Compliance, same instruction, same day ────────────────────────
  //
  // Gated on `hr_calendar`, which she holds, and the page is headed "Operational HR Governance" —
  // so the row looked correct and was argued for on exactly those grounds before the owner
  // overruled it: it is a field-force board and her seat is people operations. The page's own
  // title is therefore NOT evidence the row belongs back.
  assert.equal(
    operations.has("/hr/admin/field-workforce-compliance"),
    false,
    'the HR Operations Coordinator is offered "Workforce Compliance" again. The owner removed it '
      + "on 2026-09-01, overruling the argument that the page calls itself Operational HR "
      + "Governance. Do not re-add it on that argument.",
  );

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
