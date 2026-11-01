import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applyRepScope,
  applySeatScope,
  DISTRICT_SEAT_TIERS,
  isDistrictSeatTier,
  mayHoldReviewScope,
  resolveReviewPortalScopeFromOrg,
  type OrgSeat,
  type ReviewOrgSnapshot,
  type ReviewPortalScope,
} from "../src/lib/business-review/portal-scope.ts";
import type { AreaSummary, DmSummary, ReviewDataset } from "../src/lib/business-review/types.ts";

/**
 * Business Review — who may see what.
 *
 * The portal shows one page to nine different roles and shows each of them a different slice of
 * it. That decision is `resolveReviewPortalScopeFromOrg`. A browser sweep exercises one viewer at a
 * time and only the ones somebody remembered to try; this runs every viewer shape, every time,
 * including the denial paths — which are the half a sweep never covers, because a page that renders
 * looks like a pass.
 *
 * WHY THIS FILE CHANGED SHAPE (2026-09-12). It used to read the COMMITTED access map,
 * `src/lib/business-review/data/access-map.json`, and walk its viewers. That proved the map and the
 * resolver agreed with each other and could not, even in principle, catch what actually went wrong:
 * the map was generated 2026-07-30 and production had moved on, so SEVEN serving district managers
 * were absent from it and were told "Not available for your role". Every assertion here passed
 * throughout. A test that walks the grant list can only ever find people who are IN it.
 *
 * So the resolver reads the live org tree now, and this file asserts the property that matters:
 * given the organogram, WHOEVER occupies a district seat resolves to that district. The fixture is
 * production's real seat shape on 2026-09-12 — including the Pedia Upper Egypt split (UE-1 / UE-2)
 * and the Anti Infective Delta (3) seat, both of which post-date the retired snapshot.
 */

const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
/** Collapse runs of whitespace so a reformat or a line-wrap does not false-fail a source check. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const seat = (
  // Widened from `"DM" | "RSM"` deliberately: ACTING_DM is a district seat, and while this parameter
  // forbade it the fixture could not express production's real shape at all — which is exactly how
  // the one serving acting district manager stayed locked out with every test green.
  seatTier: OrgSeat["seatTier"],
  seatId: string,
  lineCode: string,
  occupantHrId: string | null,
  ancestors: string[],
): OrgSeat => ({ seatTier, seatId, lineCode, occupantHrId, path: [...ancestors, seatId] });

const PED = ["SEAT-ROOT-CEO", "SEAT-PED-NSM"];
const PED_RSM = [...PED, "SEAT-PED-RSM"];
const CNS = ["SEAT-ROOT-CEO", "SEAT-CNS-NSM"];
const AIF = ["SEAT-ROOT-CEO", "SEAT-AIF-NSM"];

/**
 * Production's seat shape, 2026-09-12. Three lines, 19 occupied district seats, four vacant, and a
 * single RSM node — on Pedia, carrying three of that line's eight district seats while the other five
 * hang off the NSM directly. That asymmetry is deliberate and is why the RM scope reads the PATH.
 */
const ORG: ReviewOrgSnapshot = {
  readAt: "2026-09-12T00:00:00.000Z",
  lineNameByHrId: {
    "A-12": "Pedia",
    "B-122": "CNS",
    "A-10": "Anti Infective",
    "A-99": null,
    // Two medical reps: one whose employee record carries a line, one whose does not.
    "R-500": "Pedia",
    "R-501": null,
  },
  seats: [
    seat("RSM", "SEAT-PED-RSM", "pedia", "PD-0001", PED),
    seat("DM", "SEAT-PED-DM-AB", "pedia", "PD-0012", PED_RSM),
    seat("DM", "SEAT-PED-DM-D1", "pedia", "B-154", PED_RSM),
    seat("DM", "SEAT-PED-DM-D2", "pedia", "PD-0010", PED_RSM),
    seat("DM", "SEAT-PED-DM-GZ", "pedia", "B-94", PED),
    seat("DM", "SEAT-PED-DM-UE-1", "pedia", "PD-0014", PED),
    seat("DM", "SEAT-PED-DM-UE-2", "pedia", "PD-0015", PED),
    seat("DM", "SEAT-PED-DM-CA", "pedia", null, PED),
    seat("DM", "SEAT-PED-OTHERS", "pedia", null, PED),
    seat("DM", "SEAT-CNS-DM-AB", "cns", "B-119", CNS),
    seat("DM", "SEAT-CNS-DM-CA", "cns", "B-116", CNS),
    seat("DM", "SEAT-CNS-DM-D1", "cns", "B-120", CNS),
    seat("DM", "SEAT-CNS-DM-D2", "cns", "B-184", CNS),
    seat("DM", "SEAT-CNS-DM-GZ", "cns", "B-117", CNS),
    seat("DM", "SEAT-CNS-DM-UE", "cns", "B-118", CNS),
    seat("DM", "SEAT-CNS-OTHERS", "cns", null, CNS),
    seat("DM", "SEAT-AIF-DM-AB", "anti_infective", "B-156", AIF),
    seat("DM", "SEAT-AIF-DM-CA", "anti_infective", "AI-0001", AIF),
    seat("DM", "SEAT-AIF-DM-D1", "anti_infective", "B-12", AIF),
    seat("DM", "SEAT-AIF-DM-D2", "anti_infective", "B-76", AIF),
    seat("DM", "SEAT-AIF-DM-D3", "anti_infective", "AI-0014", AIF),
    seat("DM", "SEAT-AIF-DM-GZ", "anti_infective", "AI-0007", AIF),
    seat("DM", "SEAT-AIF-DM-UE-2", "anti_infective", "AI-0013", AIF),
    seat("DM", "SEAT-AIF-OTHERS", "anti_infective", null, AIF),
    // Production's one ACTING_DM seat, verbatim: Upper Egypt 1 on Anti Infective, hanging directly
    // off the NSM (no RSM in its path), occupied by B-1 — a Medical Rep by job title and a District
    // Manager by app role. Three areas, 118,073 EGP of sales against 308,860 EGP of target over
    // Jul–Aug 2026, all of it already attributed to this seat by the canonical engine.
    seat("ACTING_DM", "SEAT-AIF-ADM-UE-1", "anti_infective", "B-1", AIF),
  ],
};

/**
 * A Pedia region with an ACTING_DM district hanging under the RSM node.
 *
 * Production has no such shape today — its one acting district sits under an NSM — which is exactly
 * why it needs a fixture. Under the old `seatTier === "DM"` filter this district would have been
 * dropped from the Regional Manager's scope with NO message at all: his totals would simply have
 * been short, which is worse than the refusal a district manager at least got to read.
 */
const ORG_WITH_ACTING_DM_UNDER_RSM: ReviewOrgSnapshot = {
  readAt: "2026-09-26T00:00:00.000Z",
  lineNameByHrId: {},
  seats: [
    seat("RSM", "SEAT-PED-RSM", "pedia", "PD-0001", PED),
    seat("DM", "SEAT-PED-DM-AB", "pedia", "PD-0012", PED_RSM),
    seat("ACTING_DM", "SEAT-PED-ADM-D1", "pedia", "PD-0099", PED_RSM),
  ],
};

/** Areas and districts, reduced to the one field the scope filter reads. */
function datasetOf(areaSeats: (string | null)[], dmSeats: (string | null)[]): ReviewDataset {
  return {
    areas: areaSeats.map((dmSeatId, i) => ({ areaCode: `A${i}`, dmSeatId })) as unknown as AreaSummary[],
    dms: dmSeats.map((dmSeatId, i) => ({ dmSeatId, label: `D${i}` })) as unknown as DmSummary[],
  } as unknown as ReviewDataset;
}

export async function runBusinessReviewPortalScopeTests(): Promise<void> {
  // `isDistrictSeatTier`, not `=== "DM"` — an acting district seat is a district seat, and the loop
  // below is the one that proves whoever occupies one resolves to it.
  const occupiedDmSeats = ORG.seats.filter((s) => isDistrictSeatTier(s.seatTier) && s.occupantHrId);
  assert.ok(occupiedDmSeats.length >= 20, `the fixture should hold production's district seats, found ${occupiedDmSeats.length}`);
  assert.ok(
    occupiedDmSeats.some((s) => s.seatTier === "ACTING_DM"),
    "and it must include the ACTING_DM seat, or this loop cannot see the tier that was omitted",
  );

  // ────────────────────────── 1. EVERY serving district manager resolves
  //
  // THE REGRESSION. Seven district managers appointed or moved after 2026-07-30 were refused this
  // module for six weeks, because access was decided by a committed file rather than by the
  // organogram. Whoever occupies a district seat must resolve to that district — with no list to be
  // absent from, and no regeneration to be forgotten.
  for (const s of occupiedDmSeats) {
    const scope = resolveReviewPortalScopeFromOrg(
      { hrId: s.occupantHrId, sessionRole: "District Manager" },
      ORG,
    );
    assert.equal(
      scope.kind,
      "seats",
      `${s.occupantHrId} occupies ${s.seatId} but resolves to no access: ` +
        `${scope.kind === "none" ? scope.reason : scope.kind}`,
    );
    assert.deepEqual(
      scope.kind === "seats" ? scope.dmSeatIds : [],
      [s.seatId],
      `${s.occupantHrId} must get their own district and nothing else`,
    );
  }

  // Casing is not identity. HR ids reach the session from three systems in mixed case.
  assert.equal(
    resolveReviewPortalScopeFromOrg({ hrId: "ai-0014", sessionRole: "District Manager" }, ORG).kind,
    "seats",
    "a lower-cased HR id is the same district manager",
  );

  // ────────────────────────── 1b. AN ACTING DISTRICT MANAGER IS A DISTRICT MANAGER
  //
  // Owner rule (AGENTS.md §4): "An acting District Manager (DM app role, Medical Rep title) sees
  // EXACTLY what a District Manager sees." This resolver read `seat_tier IN ('DM','RSM')`, so
  // production's one ACTING_DM seat never entered the snapshot and its occupant was told she holds
  // no district at all — while the admin page listed her district, from the same canonical rows.
  assert.deepEqual([...DISTRICT_SEAT_TIERS], ["DM", "ACTING_DM"], "a district seat is either tier");
  assert.ok(isDistrictSeatTier("ACTING_DM"), "ACTING_DM is a district seat");
  assert.ok(isDistrictSeatTier("DM"), "and so is DM");
  for (const notADistrict of ["RSM", "NSM", "REP", "CEO", "acting_dm", "", null, undefined]) {
    assert.equal(isDistrictSeatTier(notADistrict), false, `"${notADistrict}" is not a district seat`);
  }
  {
    const acting = resolveReviewPortalScopeFromOrg({ hrId: "B-1", sessionRole: "District Manager" }, ORG);
    assert.equal(
      acting.kind,
      "seats",
      `the acting district manager must reach her own district, got: ${acting.kind === "none" ? acting.reason : acting.kind}`,
    );
    assert.deepEqual(
      acting.kind === "seats" ? acting.dmSeatIds : [],
      ["SEAT-AIF-ADM-UE-1"],
      "her own acting district and nothing else",
    );
    assert.equal(acting.kind === "seats" ? acting.line : null, "anti", "on the line her seat sits on");
  }

  // The same omission, one level up and SILENT: an ACTING_DM under an RSM node is one of that
  // region's districts. Dropping it left a Regional Manager's totals short with no message at all.
  {
    const rm = resolveReviewPortalScopeFromOrg(
      { hrId: "PD-0001", sessionRole: "Regional Manager" },
      ORG_WITH_ACTING_DM_UNDER_RSM,
    );
    assert.equal(rm.kind, "seats", "the regional manager resolves");
    assert.deepEqual(
      (rm.kind === "seats" ? rm.dmSeatIds : []).slice().sort(),
      ["SEAT-PED-ADM-D1", "SEAT-PED-DM-AB"],
      "an acting district under the RSM node is inside that region's scope, not missing from it",
    );
  }

  // ────────────────────────── 2. the SESSION role decides, never the seat
  //
  // The fail-closed property. Somebody who still occupies a district seat but whose Phoenix role has
  // been changed gets what their ROLE carries today, not what their seat once did.
  // "Medical Rep" was in this list until 2026-09-26, when the owner gave a rep his own list. It is
  // a real role now, with its own branch and its own tests below — so it belongs nowhere near a list
  // of strings that must resolve to nothing.
  for (const nearMiss of ["District Sales Manager", "district manager", "DM", "Rep", ""]) {
    assert.equal(
      resolveReviewPortalScopeFromOrg({ hrId: "B-154", sessionRole: nearMiss }, ORG).kind,
      "none",
      `"${nearMiss}" is not "District Manager" and must not be treated as it`,
    );
  }

  // ────────────────────────── 2b. a medical rep sees HIS OWN list, and nothing else
  //
  // Owner ruling, 2026-09-26: "yes — his own list only". Until that day this module refused him in
  // so many words. The scope is his HR ID rather than an org seat deliberately: `au_v_org_tree`
  // carries REP seats, but loading them would pull every rep in the company into a snapshot read on
  // every manager's page load, and the seat carries no area anyway.
  {
    const rep = resolveReviewPortalScopeFromOrg(
      { hrId: "R-500", sessionRole: "Medical Rep", viewerName: "A Medical Rep" },
      ORG,
    );
    assert.equal(rep.kind, "rep", "a medical rep with a line on his record gets his own territory");
    if (rep.kind === "rep") {
      assert.equal(rep.line, "pedia", "the line comes from his employee record, the only place it is held");
      assert.equal(rep.hrId, "R-500", "normalised, because HR ids reach this code in three cases");
      assert.match(rep.label, /own territory/);
    }

    // SCOPE RUNS DOWNWARD ONLY and a rep is the bottom. Whatever he is handed, he never resolves to
    // a district, a line or the company — the three shapes that would show him a teammate.
    for (const kind of ["company", "line", "seats"]) {
      assert.notEqual(rep.kind, kind, `a rep must never resolve to a "${kind}" scope`);
    }

    // Case does not decide access.
    assert.equal(
      resolveReviewPortalScopeFromOrg({ hrId: "r-500", sessionRole: "Medical Rep" }, ORG).kind,
      "rep",
      "a lower-cased HR id is the same person — a plain .eq on these has hidden 28% of rows before",
    );

    // No line on the record is a REFUSAL WITH A REASON, never a silent company-wide fallback.
    const noLine = resolveReviewPortalScopeFromOrg({ hrId: "R-501", sessionRole: "Medical Rep" }, ORG);
    assert.equal(noLine.kind, "none", "a rep with no line resolves to nothing rather than to everything");
    assert.match(
      noLine.kind === "none" ? noLine.reason : "",
      /No line is recorded/,
      "and it says why, so it reads as a record gap rather than as a decision about him",
    );

    // An unknown HR id is still refused, rep branch or not.
    assert.equal(
      resolveReviewPortalScopeFromOrg({ hrId: "R-NOBODY", sessionRole: "Medical Rep" }, ORG).kind,
      "none",
    );
  }

  // ────────────────────────── 2c. applyRepScope hands back HIS areas and NO district row
  {
    // A deliberate partial: `applyRepScope` reads nothing but `areaCode` and `repHrIds`, and
    // building four whole AreaSummary objects here would bury the one thing under test. The cast is
    // the honest way to say that — an `AreaSummary` carries some forty fields.
    const area = (code: string, repHrIds: string[]) =>
      ({ area: code, areaCode: code, dmSeatId: "SEAT-X", repHrIds }) as unknown as AreaSummary;
    const ds = {
      areas: [area("CA1", ["R-500"]), area("CA2", ["R-500", "R-777"]), area("CA3", ["R-777"])],
    };

    const mine = applyRepScope(ds, "R-500");
    assert.deepEqual(
      mine.areas.map((a) => a.areaCode),
      ["CA1", "CA2"],
      "his own areas, including one he shares — never a third he has no sales in",
    );
    assert.equal(
      "dms" in mine,
      false,
      "and NO district rows at all: his district total is his manager’s figure, and handing it down is the upward read the scope rule forbids",
    );

    assert.deepEqual(
      applyRepScope(ds, "r-500").areas.map((a) => a.areaCode),
      ["CA1", "CA2"],
      "case does not decide what a rep can see",
    );
    assert.deepEqual(applyRepScope(ds, "R-NOBODY").areas, [], "an unknown id gets nothing, never everything");
    assert.deepEqual(applyRepScope(ds, "   ").areas, [], "and neither does a blank one");
  }

  // ────────────────────────── 3. the denial paths
  {
    const noId = resolveReviewPortalScopeFromOrg({ hrId: null, sessionRole: "CEO" }, ORG);
    assert.equal(noId.kind, "none", "a session with no HR ID gets nothing, whatever role it claims");
    assert.match(noId.kind === "none" ? noId.reason : "", /No HR ID/);

    assert.equal(
      resolveReviewPortalScopeFromOrg({ hrId: "   ", sessionRole: "Super Admin" }, ORG).kind,
      "none",
      "and whitespace is not an HR ID",
    );

    // 🔴 This block used to pin "Medical Representatives have no access to this module by design".
    // That sentence is GONE — the owner opened the module to reps on 2026-09-26, own list only, and
    // the rep cases live in section 2b above. What remains is the role that carries no territory at
    // all: it must read as a gap to REPORT rather than as a verdict on the person, because the
    // opposite reading is what sends somebody to the owner to "fix" a decision.
    const noScope = resolveReviewPortalScopeFromOrg({ hrId: "B-200", sessionRole: "HR Operations" }, ORG);
    assert.equal(noScope.kind, "none");
    assert.match(
      noScope.kind === "none" ? noScope.reason : "",
      /organogram gap rather than a decision about you/,
      "a role with no territory is invited to report it, not told it is excluded",
    );
    assert.doesNotMatch(
      noScope.kind === "none" ? noScope.reason : "",
      /Medical Representatives have no access/,
      "and the retired sentence must not come back with the old denial",
    );

    // A district manager with no seat is the OPPOSITE case and must never be told the same thing.
    // He is entitled to the module; the organogram is what is incomplete, and the message has to
    // send the reader to the organogram rather than to a role change.
    const seatless = resolveReviewPortalScopeFromOrg({ hrId: "B-999", sessionRole: "District Manager" }, ORG);
    assert.equal(seatless.kind, "none");
    assert.match(
      seatless.kind === "none" ? seatless.reason : "",
      /occupy no district seat in the organogram/,
      "a seatless district manager is told the organogram is the gap, not that the module is not his",
    );
    assert.doesNotMatch(
      seatless.kind === "none" ? seatless.reason : "",
      /Medical Representatives/,
      "and is never handed the Medical Rep explanation, which would read as a refusal of his role",
    );

    // A vacant seat belongs to nobody. Four districts sit empty in the fixture; not one of them may
    // fall to another district manager just because it has no occupant to claim it.
    const vacant = ORG.seats.filter((s) => isDistrictSeatTier(s.seatTier) && !s.occupantHrId).map((s) => s.seatId);
    assert.ok(vacant.length >= 4, "the fixture keeps production vacant districts");
    for (const s of occupiedDmSeats) {
      const scope = resolveReviewPortalScopeFromOrg(
        { hrId: s.occupantHrId, sessionRole: "District Manager" },
        ORG,
      );
      const granted = scope.kind === "seats" ? scope.dmSeatIds : [];
      assert.ok(
        vacant.every((v) => !granted.includes(v)),
        `${s.occupantHrId} must not inherit a vacant district`,
      );
    }
  }

  // ────────────────────────── 4. the Regional Manager takes the whole subtree
  //
  // PR #1486: a one-level manager check made an RM see their DSMs but none of the reps beneath
  // them, and a semester rolled up to 0.0% with no error. The RSM node carries THREE of Pedia's
  // eight district seats; the other five hang off the NSM and are not his.
  {
    const rm = resolveReviewPortalScopeFromOrg({ hrId: "PD-0001", sessionRole: "Regional Manager" }, ORG);
    assert.equal(rm.kind, "seats");
    if (rm.kind !== "seats") throw new Error("unreachable");
    assert.deepEqual(
      [...rm.dmSeatIds].sort(),
      ["SEAT-PED-DM-AB", "SEAT-PED-DM-D1", "SEAT-PED-DM-D2"],
      "the RM gets every district under his node — and only those",
    );
    assert.equal(rm.line, "pedia");
    assert.ok(!rm.dmSeatIds.includes("SEAT-PED-RSM"), "an RSM seat is never its own district");
    assert.equal(new Set(rm.dmSeatIds).size, rm.dmSeatIds.length, "and never the same district twice");

    // The depth property, on a HYPOTHETICAL org — not production, which today hangs every district
    // one level under the RSM, so path and parent happen to agree and the fixture above cannot tell
    // the two apart. It will not always: the seat model allows a layer between, and the day one
    // appears a parent check silently drops that district with no error and no empty page. That is
    // exactly how #1486 presented.
    const DEEP: ReviewOrgSnapshot = {
      readAt: ORG.readAt,
      lineNameByHrId: {},
      seats: [
        seat("RSM", "R1", "cns", "RM-1", ["ROOT", "NSM"]),
        seat("DM", "D-NEAR", "cns", "DM-1", ["ROOT", "NSM", "R1"]),
        seat("DM", "D-DEEP", "cns", "DM-2", ["ROOT", "NSM", "R1", "MID"]),
        seat("DM", "D-OTHER", "cns", "DM-3", ["ROOT", "NSM"]),
      ],
    };
    const deep = resolveReviewPortalScopeFromOrg({ hrId: "RM-1", sessionRole: "Regional Manager" }, DEEP);
    assert.deepEqual(
      deep.kind === "seats" ? [...deep.dmSeatIds].sort() : [],
      ["D-DEEP", "D-NEAR"],
      "a district two levels under the regional seat belongs to that region too — read the path, not the parent",
    );
    const seatless = resolveReviewPortalScopeFromOrg({ hrId: "B-999", sessionRole: "Regional Manager" }, ORG);
    assert.equal(seatless.kind, "none");
    assert.match(seatless.kind === "none" ? seatless.reason : "", /occupy no regional seat/);
  }

  // ────────────────────────── 5. company and whole-line scopes
  {
    for (const role of ["Super Admin", "CEO", "SFE Manager", "Marketing Manager"]) {
      const scope = resolveReviewPortalScopeFromOrg({ hrId: "B-10", sessionRole: role }, ORG);
      assert.equal(scope.kind, "company", `${role} sees all three lines`);
      assert.ok(scope.kind === "company" && scope.label.includes(role), "and the badge names the role");
    }

    for (const [hrId, role, line] of [
      ["A-12", "National Sales Manager", "pedia"],
      ["B-122", "National Sales Manager", "cns"],
      ["A-10", "Product Manager", "anti"],
    ] as const) {
      const scope: ReviewPortalScope = resolveReviewPortalScopeFromOrg({ hrId, sessionRole: role }, ORG);
      assert.equal(scope.kind, "line", `${role} ${hrId} must be scoped to a line`);
      assert.equal(scope.kind === "line" ? scope.line : null, line);
      assert.ok(scope.kind === "line" && scope.label.includes(role), "and the badge names the role the scope came from");
    }

    // A whole-line role with no line on their record is denied, never widened to the company. The
    // scope is meaningless without the line, and the wrong direction to guess in is "all of it".
    const noLine = resolveReviewPortalScopeFromOrg({ hrId: "A-99", sessionRole: "Group Product Manager" }, ORG);
    assert.equal(noLine.kind, "none");
    assert.match(noLine.kind === "none" ? noLine.reason : "", /No line is recorded/);
  }

  // ────────────────────────── 6. the filter itself keeps nothing extra
  {
    const ds = datasetOf(["S1", "S2", null, "S1"], ["S1", "S2", "S3", null]);
    const scoped = applySeatScope(ds, ["S1"]);

    // The null-district check comes FIRST so that a leak is reported as a leak. Behind a length
    // assertion it fires as "expected 2, got 3", which sends the next reader to the wrong bug.
    //
    // An area with no district is real value and belongs in the company total — but a DM asking
    // "how did MY areas do" must never be handed one that is nobody's.
    assert.ok(
      scoped.areas.every((a) => a.dmSeatId != null),
      "an unmapped area is not silently attributed to whoever is looking",
    );
    assert.ok(
      scoped.areas.every((a) => a.dmSeatId === "S1"),
      "and nothing belonging to another district comes with them",
    );
    assert.equal(scoped.areas.length, 2, "both S1 areas survive");
    assert.equal(scoped.dms.length, 1);
    assert.equal(scoped.dms[0].dmSeatId, "S1");

    // An empty grant shows an empty page, never the whole company.
    const nothing = applySeatScope(ds, []);
    assert.equal(nothing.areas.length, 0, "no seats means no areas — never a fall-through to everything");
    assert.equal(nothing.dms.length, 0);

    // A seat nobody holds returns nothing rather than throwing, so a stale bookmark degrades.
    assert.equal(applySeatScope(ds, ["S-GONE"]).areas.length, 0);
  }

  // ────────────────────────── 7. the retired snapshot must not creep back into the request path
  //
  // The fix is not "the file was regenerated" — it is that no committed file decides this any more.
  // A future edit re-importing the map would restore the exact failure, and would look like a
  // performance improvement while doing it.
  {
    const resolver = flat(SRC("src/lib/business-review/portal-scope.ts"));
    const page = flat(SRC("app/employee-portals/business-review/page.tsx"));
    // Matched against the IMPORT, not the bare filename: both files still NAME the retired map in
    // their header comments, on purpose — a reader who does not know why it went will put it back.
    for (const [label, src] of [["the scope resolver", resolver], ["the page", page]] as const) {
      assert.doesNotMatch(
        src,
        /from "[^"]*access-map/,
        `${label} must not read a committed access map — the organogram decides, live`,
      );
      assert.doesNotMatch(src, /require\([^)]*access-map/, `${label} must not require one either`);
    }
    assert.ok(!page.includes("reviewAccessMapGeneratedAt"), "and the snapshot stamp is gone with it");
    assert.ok(
      resolver.includes('.from("au_v_org_tree_sales")'),
      "the seat map is read from the live org tree, with the districts a Regional Manager holds himself",
    );
  }

  // ────────────────────────── 8. the ADMIN surfaces, which the seat map does not govern
  //
  // The portal is scoped by the seat map above; the admin page and the workbook export are not.
  // They each hold a flat allow-list of three executive roles, and nothing tested either one.
  // Neither file can be imported here — a Next page pulls the whole server-component graph — so
  // these are whitespace-insensitive substring checks over the source. That is weaker than
  // calling the gate, and it is the strongest check available without a running server; it
  // catches the two failures that actually happen, a widened list and a deleted check.
  {
    const page = flat(SRC("app/(admin)/business-review/page.tsx"));
    const route = flat(SRC("app/api/business-review/export/route.ts"));
    const allowList = 'const ALLOWED_ROLES = new Set(["CEO", "SFE Manager", "Super Admin"]);';

    for (const [label, src] of [["the admin page", page], ["the export route", route]] as const) {
      assert.ok(
        src.includes(allowList),
        `${label} must admit exactly CEO, SFE Manager and Super Admin. This module reads whole-company ` +
          `sales, targets, marketing spend and every rep's achievement; a fourth role added here is a ` +
          `disclosure, not a convenience.`,
      );
    }

    assert.ok(
      page.includes('if (!ALLOWED_ROLES.has(access.role)) redirect("/admin/access");'),
      "the admin page must redirect a role outside the list — a page that renders is a page that leaked",
    );
    assert.ok(
      route.includes('if (!access.role) { return NextResponse.json({ error: "Not authenticated" }, { status: 401 }); }'),
      "the export route must answer 401 when there is no role at all, not 403 — unauthenticated is not forbidden",
    );
    assert.ok(
      route.includes('if (!ALLOWED_ROLES.has(access.role)) { return NextResponse.json({ error: "Forbidden: Business Review export" }, { status: 403 }); }'),
      "and 403 a role that is authenticated but not on the list",
    );

    // The 401 must be decided BEFORE the 403, or a session with no role falls into the allow-list
    // check and is told it is forbidden — which sends the wrong person to the wrong fix.
    assert.ok(
      route.indexOf("Not authenticated") < route.indexOf("Forbidden: Business Review export"),
      "the missing-role check must come first",
    );

    // The gate must be decided before anything loads. An export that builds the workbook and then
    // checks the role has already run every company-wide query on behalf of whoever asked.
    //
    // Both compare against the CALL, never the bare identifier — the identifier's first
    // occurrence is the import at the top of the file, which would make either check pass no
    // matter where the gate sat.
    assert.ok(
      route.indexOf("Forbidden: Business Review export") < route.indexOf("await generateReviewWorkbook("),
      "the export must refuse before it builds — not build, then refuse",
    );
    assert.ok(
      page.indexOf('redirect("/admin/access")') < page.indexOf("await loadBusinessReview({"),
      "and the page must redirect before it loads the review",
    );
  }

  // ────────────────────────── Only a seat role ever reads the seat map (2026-10-01)
  //
  // `loadReviewPortalScope` now skips the whole-organogram seat read for every role but District
  // Manager and Regional Manager ("slow to transfer between page and page"). That is safe ONLY if the
  // resolver answers every other role without looking at `seats` — so it is proved here, viewer by
  // viewer, against the same organogram with its seats emptied: every answer must be identical. And
  // `mayHoldReviewScope`, which lets the page skip the company-wide bundle, must never say "no" to a
  // role the resolver would give a scope to: that would be a viewer shown nothing for no reason.
  {
    const roles = [
      "Super Admin",
      "CEO",
      "SFE Manager",
      "Marketing Manager",
      "National Sales Manager",
      "Group Product Manager",
      "Product Manager",
      "Medical Rep",
      "Medical Representative",
      "District Manager",
      "Regional Manager",
      "Employee",
      "HR Manager",
      "Finance Manager",
      "Training Manager",
    ];
    const seatRoles = new Set(["District Manager", "Regional Manager"]);
    const people = ["A-12", "B-122", "A-10", "A-99", "R-500", "R-501", "B-154", "PD-0001", "B-1", "AI-0014", "NOBODY", null];
    const withoutSeats: ReviewOrgSnapshot = { ...ORG, seats: [] };
    for (const sessionRole of roles) {
      for (const hrId of people) {
        const full = resolveReviewPortalScopeFromOrg({ hrId, sessionRole }, ORG);
        if (!seatRoles.has(sessionRole)) {
          assert.deepEqual(
            resolveReviewPortalScopeFromOrg({ hrId, sessionRole }, withoutSeats),
            full,
            `${sessionRole} ${hrId ?? "(no id)"} must resolve without the seat map — the page no longer reads it for this role`,
          );
        }
        if (!mayHoldReviewScope(sessionRole)) {
          assert.equal(
            full.kind,
            "none",
            `${sessionRole} is said to hold no scope, so the page skips its bundle — yet ${hrId ?? "(no id)"} resolved to ${full.kind}`,
          );
        }
      }
    }
  }
}
