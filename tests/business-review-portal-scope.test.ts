import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applySeatScope,
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
  seatTier: "DM" | "RSM",
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
  const occupiedDmSeats = ORG.seats.filter((s) => s.seatTier === "DM" && s.occupantHrId);
  assert.ok(occupiedDmSeats.length >= 19, `the fixture should hold production's district seats, found ${occupiedDmSeats.length}`);

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

  // ────────────────────────── 2. the SESSION role decides, never the seat
  //
  // The fail-closed property. Somebody who still occupies a district seat but whose Phoenix role has
  // been changed gets what their ROLE carries today, not what their seat once did.
  for (const nearMiss of ["District Sales Manager", "district manager", "DM", "Medical Rep", ""]) {
    assert.equal(
      resolveReviewPortalScopeFromOrg({ hrId: "B-154", sessionRole: nearMiss }, ORG).kind,
      "none",
      `"${nearMiss}" is not "District Manager" and must not be treated as it`,
    );
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

    // A Medical Rep is not an oversight — it is the documented design. The reason has to say so,
    // or the owner gets asked to "fix" an access bug that is a decision.
    const rep = resolveReviewPortalScopeFromOrg({ hrId: "B-200", sessionRole: "Medical Rep" }, ORG);
    assert.equal(rep.kind, "none");
    assert.match(
      rep.kind === "none" ? rep.reason : "",
      /Medical Representatives have no access to this module by design/,
      "a role outside the module is told this is by design, not that something is broken",
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
    const vacant = ORG.seats.filter((s) => s.seatTier === "DM" && !s.occupantHrId).map((s) => s.seatId);
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
      resolver.includes('.from("au_v_org_tree")'),
      "the seat map is read from the live org tree",
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
}
