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

  // Ten for every seat except the HR Operations Specialist (HR Administration, 2026-10-20), whose
  // deliberately narrow rail read nine rows on that day.
  const floor = seat === "HR Administration" ? 8 : 10;
  assert.ok(
    rows.length >= floor,
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
    ["HR Operations", "HR Resourcing", "HR Administration"],
    "this file reasons about exactly three HR seats (the owner retired the HR Business Partner seat on " +
      "2026-10-08 and opened the HR Operations Specialist seat on 2026-10-20); a new bundle needs its " +
      "own verdict here rather than being silently unchecked",
  );

  const operations = offeredHrefs("HR Operations");
  const resourcing = offeredHrefs("HR Resourcing");
  const specialist = offeredHrefs("HR Administration");

  // The headline used to be the HR Business Partner's: offered "Other Approvals" (excluded
  // 2026-09-01) and the Leave Management hub (excluded 2026-08-29), both empty for her. Her seat was
  // retired on 2026-10-08 and holds no HR rail at all (tests/hr-advisory-module-access.test.ts pins
  // that), so the two verdicts below are the live seats'. LEAVE_MANAGEMENT_HREF was a hub until
  // 2026-09-05, when the owner ruled no rail row may open a page of modules; its children became rows
  // under a band of the same name, so leave ADMINISTRATION is asked of the children.
  const leaveAdminRows = (rail: Set<string>) =>
    [...rail].filter((href) => href.startsWith(`${LEAVE_MANAGEMENT_HREF}/`)).sort();

  // ── The other seat keeps leave administration ───────────────────────────────
  // Excluding one seat from a shared row is one edit away from deleting the row. HR Operations
  // owns leave administration, so this must survive every narrowing aimed at another seat — and,
  // since 2026-09-05, every promotion that dissolves the row it used to be reached through.
  assert.ok(
    leaveAdminRows(operations).length >= 2,
    `the HR Generalist (HR Operations) is offered ${leaveAdminRows(operations).length} ` +
      "leave-administration rows. Excluding another seat from a shared row must narrow it for that " +
      "seat only, and retiring the hub must move its children onto this seat's rail rather than take " +
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
  // reason it is spelled out rather than folded into the loop above. The HR Business Partner was
  // excluded because the inbox could never hold a row for her. HR Operations is excluded because the owner
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
    'the HR Generalist (HR Operations) is offered "Other Approvals" again. The owner removed it from '
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
    'the HR Generalist (HR Operations) is offered "Workforce Compliance" again. The owner removed it '
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
  // does not catch.
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

  // ── The HR Operations Specialist seat's verdict (2026-10-20) ────────────────
  //
  // HR Administration DOES hold actionable grants on two of the three Other Approvals modules —
  // contracts:update (HR review and the signed upload) and resignations:update (following one through
  // to the completed cycle) — and works both from their own rows, Contract Renewal and Resignations.
  // Other Approvals is on no HR rail since 2026-09-01, so it is not offered to her either; that is
  // asserted rather than assumed. She administers no leave: leave:read and leave:create are her own
  // vacation, and the company leave pages stay with HR Operations.
  assert.equal(
    specialist.has(OTHER_APPROVALS_HREF),
    false,
    'the HR Operations Specialist is offered "Other Approvals". It is on no HR rail since the owner ' +
      "removed it on 2026-09-01; her contracts and resignations work is on their own rows",
  );
  assert.deepEqual(
    leaveAdminRows(specialist),
    [],
    "the HR Operations Specialist is offered a leave-administration row. leave:read is her own " +
      "vacation; the company leave pages are not hers",
  );
  assert.equal(specialist.has(LEAVE_MANAGEMENT_HREF), false, 'the HR Operations Specialist is offered the "Leave Management" hub');
  for (const href of ["/hr/contracts", "/hr/resignations"]) {
    assert.ok(specialist.has(href), `the HR Operations Specialist works ${href} from its own row, so the row must be on her rail`);
  }
  const specialistGrants = permissionMatrix["HR Administration" as PhoenixRole];
  assert.deepEqual(
    (specialistGrants?.outstation ?? []).filter((action) => action === "update" || action === "approve"),
    [],
    "the HR Operations Specialist holds an actionable outstation grant — the third Other Approvals module is not hers",
  );

  // The block that tied the Business Partner's exclusion to her holding no ACTIONABLE grant on
  // resignations, contracts or outstation left with her seat: the owner retired the HR Business Partner seat on 2026-10-08.
  // The Talent Acquisition seat's same check is above.
}
