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
 * Leave Management is no longer a ROW. On 2026-09-05 the owner ruled that no rail row may open a
 * page of modules, so that hub dissolved into its three children under a band of the same name.
 * The exclusion survives the promotion and is asked of the children now — see the repointed
 * assertions below, which is where the reasoning for that lives.
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
function railFor(seat: HrBundleName) {
  const role = seat as unknown as PhoenixRole;
  const sections = getSections(
    getNavigationSections("hr"),
    "hr",
    buildPermissionLookup(permissionMatrix, role),
    role,
  );
  const rows = sections.flatMap((section) => section.items);

  assert.ok(
    rows.length >= 10,
    `"${seat}" is offered only ${rows.length} HR nav rows — the shell did not build, so every ` +
      "assertion below would pass vacuously",
  );
  return { rows, sections };
}

function offeredHrefs(seat: HrBundleName): Set<string> {
  return new Set(railFor(seat).rows.map((row) => row.href));
}

export function runHrNavNoEmptyInboxRowsTests() {
  const seats = Object.keys(HR_ROLE_BUNDLES) as HrBundleName[];
  assert.deepEqual(
    seats,
    ["HR Advisory", "HR Operations", "HR Resourcing"],
    "this file reasons about exactly three HR seats; a fourth bundle needs its own verdict here " +
      "rather than being silently unchecked",
  );

  const advisory = offeredHrefs("HR Advisory");
  const operations = offeredHrefs("HR Operations");
  const resourcing = offeredHrefs("HR Resourcing");

  // ── The headline ────────────────────────────────────────────────────────────
  assert.equal(
    advisory.has(OTHER_APPROVALS_HREF),
    false,
    'the HR Business Partner is offered "Other Approvals", an inbox that shows only resignation, ' +
      "contract-renewal and outstation rows — she holds no grant for any of the three, so it can " +
      "never contain one row for her, and it carries a pending badge while being empty",
  );

  // The 2026-08-29 precedent, pinned in the same place so the pair cannot drift apart.
  //
  // ── REPOINTED 2026-09-05 ──────────────────────────────────────────────────────────────────
  //
  // LEAVE_MANAGEMENT_HREF was a HUB — a page of modules — and the owner ruled that day that no
  // rail row may open one: "I don't want any subtitle to be the one that when I press, it
  // redirects me to a page with big modules. I want a recruitment and its modules under it." So
  // the door went and its children became rows under a band still called Leave Management.
  //
  // Both assertions here were written against that door, and both would now be asking about a
  // href that is on NOBODY's rail. The exclusion would pass because the row does not exist,
  // which is unfailable rather than satisfied; the "she keeps it" check would fail for the same
  // reason, over nothing she lost. Neither is the question. The question is whether leave
  // ADMINISTRATION is still hers and still not the Business Partner's — so that is what is asked,
  // of the children, which is where it now lives.
  //
  // Her own vacation stays out of it by construction: Request Vacation is
  // /hr/workspace/leave-management/vacation-request, a self-service form under /hr/workspace,
  // which is exactly the distinction `leave:read` blurs and this file exists to keep.
  const leaveAdminRows = (rail: Set<string>) =>
    [...rail].filter((href) => href.startsWith(`${LEAVE_MANAGEMENT_HREF}/`)).sort();

  assert.deepEqual(
    leaveAdminRows(advisory),
    [],
    "the HR Business Partner is offered a leave-administration row. The hub she was excluded " +
      "from on 2026-08-29 listed 0 of 3 children for her, so promoting those children to rows of " +
      "their own must not hand her the ones the hub was hiding",
  );
  assert.equal(
    advisory.has(LEAVE_MANAGEMENT_HREF),
    false,
    'the HR Business Partner is offered "Leave Management", which listed 0 of 3 children for her ' +
      "when it was excluded on 2026-08-29. Kept beside the sweep above because the hub is still a " +
      "PAGE — retiring the row is not the same as deleting the route, and re-adding the door " +
      "would restore the original defect in one line",
  );

  // ── The other seat keeps leave administration ───────────────────────────────
  // Excluding one seat from a shared row is one edit away from deleting the row. HR Operations
  // owns leave administration, so this must survive every narrowing aimed at HR Advisory — and,
  // since 2026-09-05, every promotion that dissolves the row it used to be reached through.
  assert.ok(
    leaveAdminRows(operations).length >= 2,
    `the HR Operations Coordinator is offered ${leaveAdminRows(operations).length} ` +
      "leave-administration rows. Excluding HR Advisory from a shared row must narrow it for HER " +
      "only, and retiring the hub must move its children onto this seat's rail rather than take " +
      "leave off it — measured 2026-09-05, she is offered Vacation Report and Vacation Control",
  );

  // …and they still sit under a band carrying the module's name, so it is findable by the word
  // the seat's own job is called. Scattering the children into unrelated sections satisfies the
  // count above and loses the module, which is the failure a promotion actually risks.
  const operationsBands = railFor("HR Operations").sections.map((section) => section.label);
  assert.ok(
    operationsBands.includes("Leave Management"),
    `the HR Operations rail has no "Leave Management" band — its headings are ` +
      `${JSON.stringify(operationsBands)}. The hub row was retired on 2026-09-05 on the ` +
      "understanding that the band replaces it as the thing carrying the name",
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

  // ── The Talent Acquisition seat's verdict (2026-10-08) ──────────────────────
  //
  // HR Resourcing holds leave:read for the same reason every seat does — her own vacation — and the
  // owner built her rail page by page on the access blueprint. He ticked neither Other Approvals nor
  // any leave-administration page, and she holds no update or approve on resignations, contracts or
  // outstation, so either row would be the empty inbox this file exists to keep off a rail. Her own
  // Request Vacation is /hr/workspace/leave-management/vacation-request, which the prefix test below
  // does not catch, exactly as for the Business Partner.
  assert.equal(
    resourcing.has(OTHER_APPROVALS_HREF),
    false,
    'the Talent Acquisition seat is offered "Other Approvals", an inbox of resignation, contract ' +
      "and outstation decisions she can take none of — and the owner did not tick it for her",
  );
  assert.deepEqual(
    leaveAdminRows(resourcing),
    [],
    "the Talent Acquisition seat is offered a leave-administration row. The owner did not tick " +
      "leave administration for her; leave:read is her own vacation, not the company's",
  );
  assert.equal(
    resourcing.has(LEAVE_MANAGEMENT_HREF),
    false,
    'the Talent Acquisition seat is offered the "Leave Management" hub, which would list nothing ' +
      "she can act on",
  );
  const resourcingGrants = permissionMatrix["HR Resourcing" as PhoenixRole];
  for (const resource of OTHER_APPROVALS_MODULES) {
    const actions = resourcingGrants?.[resource] ?? [];
    assert.deepEqual(
      actions.filter((action) => action === "update" || action === "approve"),
      [],
      `HR Resourcing now holds ${resource}: ${JSON.stringify(actions)} — an ACTIONABLE grant. Re-decide ` +
        'whether "Other Approvals" belongs on her rail rather than leaving the exclusion above stale',
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
