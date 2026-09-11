import assert from "node:assert/strict";

import {
  buildManagerSummariesDetailed,
  resolveDoubleVisitAccessScope,
  type DoubleVisitDbRow,
} from "../src/lib/double-visit-analytics/service.ts";
import { indexByCanonicalHrId, isAboveViewer, managementChainOf } from "../src/lib/workforce/downward-scope.ts";
import { canonicalHrIdKey, normalizeHrIdForAccess } from "../src/lib/hr-id.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/**
 * THE DOWNWARD RULE REACHES DOUBLE-VISIT ANALYTICS.
 *
 * Owner 2026-09-04: *"Never an employee sees his direct manager. You see yourself and your scope
 * down."* Implemented that day in crm/doctor-coverage-scope.ts and applied there alone. Measured on
 * production 2026-09-11, Product Manager B-155 had his own manager A-8 on the DV manager board
 * while she was correctly hidden from him on every CRM board.
 *
 * 🔴 THE TRAP THAT BEAT TWO EARLIER ATTEMPTS — AND WHY A ROW FILTER CANNOT BE THE TEST.
 *
 * A double visit is manager -> Medical Rep. Her reps are LEGITIMATELY in his scope, so her rows are
 * admitted ON THE REP, and buildManagerSummariesDetailed builds the table from row VISITORS. So
 * cutting her from `allowedHrIds` never removes her name. The only rows a row filter catches are
 * manager-to-manager ones, and three other filters already drop those — a test written on that
 * shape passes against completely broken code.
 *
 * Every fixture below therefore uses the REP-VISIT shape. The first assertion is pinned against
 * that specific false positive.
 *
 * 🔴 THE SECOND TRAP: TWO KEY DOMAINS. This service normalises HR ids two incompatible ways
 * (`canonicalHrIdKey` and `normalizeHrIdForAccess`). The visitor map uses the canonical one, so an
 * exclusion set built with the other silently matches nobody and the board looks fixed while
 * showing everyone. That is asserted directly.
 *
 * Owner 2026-09-11, shown that the full rule drops a PM's board from 11 rows to 1: take the CHAIN
 * cut only here for now. The seat-rank ladder stays in the locked doctor-coverage module and is
 * deliberately NOT duplicated — see src/lib/workforce/downward-scope.ts.
 */

const employee = (over: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow =>
  ({
    areaName: null,
    employmentStatus: "Active",
    fullName: over.hrId,
    jobTitle: null,
    lineId: 2,
    lineName: "Pedia",
    managerHrId: null,
    pendingManagerReplacementForHrId: null,
    positionTitle: null,
    regionName: null,
    ...over,
  }) as unknown as EmployeeDirectoryRow;

const row = (visitor: string, visited: string, count = 3): DoubleVisitDbRow =>
  ({
    activity_date: "2026-09-01",
    area_name: "Cairo",
    double_visitor_hr_id: visitor,
    double_visitor_name: visitor,
    id: `${visitor}->${visited}`,
    line_name: "Pedia",
    period: "AM",
    source_record_id: null,
    source_type: "crm",
    visit_count: count,
    visit_type: 0,
    visit_type_description: null,
    visited_employee_hr_id: visited,
    visited_employee_name: visited,
    visited_employee_status: "Active",
  }) as unknown as DoubleVisitDbRow;

const access = (role: string, hrId: string): AccessContext =>
  ({ hrId, loginId: hrId, role, scope: "company", source: "session" }) as unknown as AccessContext;

// A PM, his own manager (a GPM), a peer DSM, and two reps — all on one line, which is what the
// PM/GPM branch of resolveDoubleVisitAccessScope expands.
const VIEWER = "B-155";
const OWN_MANAGER = "A-8";
const GRANDPARENT = "A-9";
const PEER_DSM = "B-154";
const REP_ONE = "PD-0004";
const REP_TWO = "PD-0008";

const DIRECTORY: EmployeeDirectoryRow[] = [
  employee({ hrId: VIEWER, jobTitle: "Product Manager", managerHrId: OWN_MANAGER }),
  employee({ hrId: OWN_MANAGER, jobTitle: "Group Product Manager", managerHrId: GRANDPARENT }),
  employee({ hrId: GRANDPARENT, jobTitle: "National Sales Manager", managerHrId: null }),
  employee({ hrId: PEER_DSM, jobTitle: "District Sales Manager", managerHrId: OWN_MANAGER }),
  employee({ hrId: REP_ONE, jobTitle: "Medical Representative", managerHrId: PEER_DSM }),
  employee({ hrId: REP_TWO, jobTitle: "Medical Representative", managerHrId: PEER_DSM }),
];

/**
 * The exclusion set exactly as the service builds it.
 *
 * 🔴 TWO DOMAINS, AND THIS HELPER IS WHERE THEY MEET. The chain is climbed in the ACCESS domain
 * (`normalizeHrIdForAccess`, which is what indexByCanonicalHrId keys on despite its name), then
 * each member is translated to the CANONICAL domain the visitor map uses. Written the other way
 * round first, this returned an empty set and every assertion below failed against a fix that was
 * already working in production — the same class of silent mismatch the test pins further down.
 */
function chainKeysFor(viewerHrId: string): Set<string> {
  const viewerAccessKey = normalizeHrIdForAccess(viewerHrId) ?? "";
  const chain = managementChainOf(viewerAccessKey, indexByCanonicalHrId(DIRECTORY));
  const keys = new Set<string>();
  for (const person of DIRECTORY) {
    if (!isAboveViewer(person, viewerAccessKey, chain)) continue;
    const canonical = canonicalHrIdKey(person.hrId);
    if (canonical) keys.add(canonical);
  }
  return keys;
}

export function runDoubleVisitDownwardScopeTests() {
  // ── 🔴 THE REP-VISIT SHAPE: the manager's name must go, though every row is admitted on a rep ──
  const repVisitRows = [
    row(OWN_MANAGER, REP_ONE, 5),
    row(OWN_MANAGER, REP_TWO, 4),
    row(PEER_DSM, REP_ONE, 7),
    row(VIEWER, REP_TWO, 2),
  ];
  // Control: with no exclusion this is the broken board, and it names the viewer's own manager.
  const before = buildManagerSummariesDetailed(repVisitRows, DIRECTORY, "2026-09-30").summaries;
  const beforeIds = before.map((summary) => canonicalHrIdKey(summary.managerHrId ?? ""));
  assert.ok(
    beforeIds.includes(canonicalHrIdKey(OWN_MANAGER)),
    "control: without the cut the viewer's own manager IS on the board — if this fails the fixture no longer reproduces the bug and nothing below proves anything",
  );

  const after = buildManagerSummariesDetailed(repVisitRows, DIRECTORY, "2026-09-30", chainKeysFor(VIEWER)).summaries;
  const afterIds = after.map((summary) => canonicalHrIdKey(summary.managerHrId ?? ""));
  assert.ok(
    !afterIds.includes(canonicalHrIdKey(OWN_MANAGER)),
    "🔴 the viewer's own manager must NOT be a row on his board — and note every row here was admitted on a REP, the shape a row filter can never catch",
  );

  // 🔴 HER VISITS STILL COUNT. The cut withholds a NAME, never the data: her visits to his reps
  // remain part of those reps' coverage. An exclusion that also removed the visits would quietly
  // restate every number on the page.
  const visitedAfter = buildManagerSummariesDetailed(repVisitRows, DIRECTORY, "2026-09-30", chainKeysFor(VIEWER))
    .visitedKeysByManager;
  assert.ok(
    !visitedAfter.has(canonicalHrIdKey(OWN_MANAGER) ?? ""),
    "her summary is gone from the manager tally",
  );
  const peer = after.find((summary) => canonicalHrIdKey(summary.managerHrId ?? "") === canonicalHrIdKey(PEER_DSM));
  const peerBefore = before.find((summary) => canonicalHrIdKey(summary.managerHrId ?? "") === canonicalHrIdKey(PEER_DSM));
  // 🔴 REAL FIELD NAMES, and that is not a detail. This first read `totalDoubleVisits` and
  // `distinctMrsVisited`, which exist on no type here — so both sides were `undefined`, deepEqual
  // compared nothing to nothing, and the assertion passed while measuring absolutely nothing. The
  // runtime never caught it because the test runner strips types; only a typecheck did.
  assert.ok(peer && peerBefore, "the peer is on both boards, so there is something to compare");
  assert.deepEqual(
    { amVisits: peer?.amVisits, distinctMrs: peer?.distinctMrs, pmVisits: peer?.pmVisits, totalDvs: peer?.totalDvs },
    {
      amVisits: peerBefore?.amVisits,
      distinctMrs: peerBefore?.distinctMrs,
      pmVisits: peerBefore?.pmVisits,
      totalDvs: peerBefore?.totalDvs,
    },
    "🔴 everybody else's numbers are identical — cutting one visitor must not restate another's totals",
  );
  assert.ok((peer?.totalDvs ?? 0) > 0, "and they are real numbers, not two matching zeroes");

  // ── The viewer is never cut from his own board ───────────────────────────────────────────────
  assert.ok(
    afterIds.includes(canonicalHrIdKey(VIEWER)),
    "you always see yourself — a viewer erased from his own board reads as a data fault, not a rule",
  );

  // ── A peer is NOT cut. Owner 2026-09-11 chose the chain cut only for this screen ─────────────
  assert.ok(
    afterIds.includes(canonicalHrIdKey(PEER_DSM)),
    "a peer District Sales Manager STAYS on a PM's board — the seat-rank ladder was deliberately not applied here",
  );

  // ── 🔴 A VISITOR WITH NO EMPLOYEE RECORD SURVIVES ────────────────────────────────────────────
  // Production carries `crm:1426`-style visitors that match nobody in the directory. Cutting on
  // "not in the scoped list" instead of "in the viewer's chain" would silently delete them.
  const withUnknown = buildManagerSummariesDetailed(
    [...repVisitRows, row("crm:1426", REP_ONE, 6)],
    DIRECTORY,
    "2026-09-30",
    chainKeysFor(VIEWER),
  ).summaries;
  assert.ok(
    withUnknown.some((summary) => String(summary.managerHrId ?? "").toLowerCase().includes("crm:1426")),
    "🔴 a visitor absent from the directory is NOT the viewer's manager and must survive the cut",
  );

  // ── 🔴 THE WRONG KEY DOMAIN MUST NOT SILENTLY PASS ───────────────────────────────────────────
  // A set built in the other normalisation domain matches nothing, and the board then looks fixed
  // while showing everybody. Pinned so a future refactor that swaps the helper is caught here.
  const wrongDomain = new Set([OWN_MANAGER.toLowerCase()]);
  const wrong = buildManagerSummariesDetailed(repVisitRows, DIRECTORY, "2026-09-30", wrongDomain).summaries;
  const canonicalManager = canonicalHrIdKey(OWN_MANAGER);
  if (canonicalManager !== OWN_MANAGER.toLowerCase()) {
    assert.ok(
      wrong.map((s) => canonicalHrIdKey(s.managerHrId ?? "")).includes(canonicalManager),
      "a lower-cased key is NOT the canonical key — this asserts the domains really are distinct, so the canonical set above is doing the work",
    );
  }

  // ── The SCOPE must not carry the chain either ────────────────────────────────────────────────
  const scope = resolveDoubleVisitAccessScope(access("Product Manager", VIEWER), DIRECTORY);
  assert.equal(scope.all, false, "a Product Manager is scoped, never company-wide");
  if (scope.all) return;
  // Normalise BOTH sides with the same helper the scope builder uses. Comparing against a
  // hand-lowercased id silently matched nothing and failed the viewer's own-scope assertion
  // against a correct implementation.
  const inScope = (hrId: string) => scope.allowedHrIds.has(normalizeHrIdForAccess(hrId) ?? "");
  assert.ok(!inScope(OWN_MANAGER), "his own manager is out of scope");
  assert.ok(!inScope(GRANDPARENT), "and so is his manager's manager — the cut walks the whole chain, not one step");
  assert.ok(inScope(VIEWER), "he is in his own scope");
  assert.ok(inScope(REP_ONE) && inScope(PEER_DSM), "his line is otherwise intact");

  // ── 🔴 A CYCLIC MANAGER LINK: terminates, AND does not erase the viewer from his own board ──
  // This fixture is what makes the self-guard testable at all. In a normal tree the viewer is
  // never in his own chain, so deleting the guard changes nothing and an assertion about it passes
  // against broken code — measured: the "you always see yourself" check above stayed GREEN with
  // the guard removed. A mutual manager pair puts the viewer INTO his own chain, which is the only
  // shape where the guard does any work, and this directory really does carry such pairs.
  const looped = [
    employee({ hrId: "L-1", jobTitle: "Product Manager", managerHrId: "L-2" }),
    employee({ hrId: "L-2", jobTitle: "Group Product Manager", managerHrId: "L-1" }),
  ];
  const loopViewerKey = normalizeHrIdForAccess("L-1") ?? "";
  const loopChain = managementChainOf(loopViewerKey, indexByCanonicalHrId(looped));
  assert.ok(loopChain.size > 0 && loopChain.size <= 2, "a mutually-referencing manager pair terminates");
  assert.ok(
    loopChain.has(loopViewerKey),
    "control: the cycle really does put the viewer inside his own chain — without this the assertion below cannot fire",
  );
  assert.equal(
    isAboveViewer({ hrId: "L-1" }, loopViewerKey, loopChain),
    false,
    "🔴 the viewer is NEVER cut from his own scope, even when the directory records him as his own ancestor — erasing a man from his own board reads as a data fault, not as a rule",
  );
  assert.equal(
    isAboveViewer({ hrId: "L-2" }, loopViewerKey, loopChain),
    true,
    "while his manager in that same cycle is still cut",
  );
}
