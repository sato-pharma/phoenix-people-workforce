import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applySeatScope,
  resolveReviewPortalScope,
  type ReviewPortalScope,
} from "../src/lib/business-review/portal-scope.ts";
import type { AreaSummary, DmSummary, ReviewDataset } from "../src/lib/business-review/types.ts";

/**
 * Business Review — who may see what.
 *
 * The portal shows one page to nine different roles and shows each of them a different slice of
 * it. That decision is `resolveReviewPortalScope`, and until now nothing tested it. A browser
 * sweep exercises one viewer at a time and only the ones somebody remembered to try; this runs
 * every viewer in the real access map, every time, including the denial paths — which are the
 * half a sweep never covers, because a page that renders looks like a pass.
 *
 * It reads the COMMITTED map rather than a fixture on purpose. A fixture would prove the function
 * is self-consistent; the map is what production actually resolves against, so a regeneration that
 * grants a seat that does not exist fails here instead of on somebody's screen.
 */

type ViewerEntry = {
  hrId: string;
  name: string;
  role: string;
  scope: "company" | "line" | "ownDm" | "dmSeats";
  line: string | null;
  dmSeatId: string | null;
  dmSeatIds?: string[];
  rsmSeatId: string | null;
  note: string | null;
};
type AccessMap = {
  lines: Record<string, { label: string; dmSeats: { seatId: string }[]; unmappedAreas: string[] }>;
  viewers: Record<string, ViewerEntry>;
};

const MAP = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/lib/business-review/data/access-map.json", import.meta.url)), "utf8"),
) as AccessMap;

const SRC = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
/** Collapse runs of whitespace so a reformat or a line-wrap does not false-fail a source check. */
const flat = (s: string) => s.replace(/\s+/g, " ");

/** Areas and districts, reduced to the one field the scope filter reads. */
function datasetOf(areaSeats: (string | null)[], dmSeats: (string | null)[]): ReviewDataset {
  return {
    areas: areaSeats.map((dmSeatId, i) => ({ areaCode: `A${i}`, dmSeatId })) as unknown as AreaSummary[],
    dms: dmSeats.map((dmSeatId, i) => ({ dmSeatId, label: `D${i}` })) as unknown as DmSummary[],
  } as unknown as ReviewDataset;
}

export async function runBusinessReviewPortalScopeTests(): Promise<void> {
  const viewers = Object.values(MAP.viewers);
  assert.ok(viewers.length >= 20, `the access map should hold the field-force viewers, found ${viewers.length}`);

  // ────────────────────────── 1. every viewer in the map resolves
  //
  // A grant that resolves to `none` is worse than no grant: the sidebar shows the link, the click
  // lands, and the page says the viewer has no access. Three roles shipped in exactly that state
  // before, so the whole map is walked rather than a sample.
  const byKind: Record<string, number> = {};
  for (const v of viewers) {
    const scope = resolveReviewPortalScope({ hrId: v.hrId, sessionRole: v.role });
    assert.notEqual(
      scope.kind,
      "none",
      `${v.role} (${v.scope}) is in the access map but resolves to no access: ` +
        `${scope.kind === "none" ? scope.reason : ""}`,
    );
    byKind[scope.kind] = (byKind[scope.kind] ?? 0) + 1;
  }
  assert.ok(byKind.company > 0, "somebody must hold the whole-company view");
  assert.ok(byKind.seats > 0, "and the district managers must hold a seat-level one");

  // ────────────────────────── 2. the snapshot must agree with the live session
  //
  // The fail-closed property, and the reason this file exists. The map is a point-in-time
  // snapshot; the session role is live. If a person changed role since it was generated, the
  // snapshot's scope is stale and may be WIDER than the role now deserves. Denying on disagreement
  // is the only safe answer, and it must hold for every viewer, not just the seat-level ones.
  for (const v of viewers) {
    const impersonated = resolveReviewPortalScope({ hrId: v.hrId, sessionRole: "Medical Rep" });
    assert.equal(
      impersonated.kind,
      "none",
      `${v.role}'s grant survived a session role of "Medical Rep" — the snapshot is being trusted over the live role`,
    );
    assert.match(
      impersonated.kind === "none" ? impersonated.reason : "",
      /no longer matches the access map/,
      "and the viewer is told why, so a real role change is fixed rather than guessed at",
    );
  }

  // A role that merely LOOKS like the granted one is still a different role.
  const aDm = viewers.find((v) => v.scope === "ownDm");
  assert.ok(aDm, "the map must hold at least one district manager");
  for (const nearMiss of ["District Sales Manager", "district manager", "DM", ""]) {
    assert.equal(
      resolveReviewPortalScope({ hrId: aDm.hrId, sessionRole: nearMiss }).kind,
      "none",
      `"${nearMiss}" is not "${aDm.role}" and must not be treated as it`,
    );
  }

  // ────────────────────────── 3. the denial paths
  {
    const noId = resolveReviewPortalScope({ hrId: null, sessionRole: "CEO" });
    assert.equal(noId.kind, "none", "a session with no HR ID gets nothing, whatever role it claims");
    assert.match(noId.kind === "none" ? noId.reason : "", /No HR ID/);

    assert.equal(
      resolveReviewPortalScope({ hrId: "   ", sessionRole: "Super Admin" }).kind,
      "none",
      "and whitespace is not an HR ID",
    );

    // A Medical Rep is not an oversight — it is the documented design. The reason has to say so,
    // or the owner gets asked to "fix" an access bug that is a decision.
    const rep = resolveReviewPortalScope({ hrId: "HR-NOT-IN-THE-MAP", sessionRole: "Medical Rep" });
    assert.equal(rep.kind, "none");
    assert.match(
      rep.kind === "none" ? rep.reason : "",
      /Medical Representatives have no access to this module by design/,
      "an absent viewer is told this is by design, not that something is broken",
    );
  }

  // ────────────────────────── 4. a seat grant must point at a seat that EXISTS
  //
  // The half a permission matrix cannot tell you. A viewer can be granted a district that is not
  // in their line's dataset — the map regenerates from the live org tree, the dataset from the
  // sales engine — and the result is a page that renders, passes a browser sweep, and is empty.
  for (const v of viewers) {
    const scope = resolveReviewPortalScope({ hrId: v.hrId, sessionRole: v.role });
    if (scope.kind !== "seats") continue;

    // Not reachable with today's map — all 17 seat-scoped viewers hold a seat, so breaking the
    // guard in portal-scope.ts does not turn this red. It is here for the regeneration that
    // retires a district: a DM whose seat vanishes would otherwise get a scope of no seats, which
    // `applySeatScope` renders as a blank page rather than as a denial.
    assert.ok(scope.dmSeatIds.length > 0, `${v.role} holds a seat scope with no seats in it`);
    assert.equal(
      new Set(scope.dmSeatIds).size,
      scope.dmSeatIds.length,
      `${v.role} was granted the same district twice, which would double every figure they see`,
    );
    if (v.scope === "ownDm") {
      assert.equal(scope.dmSeatIds.length, 1, "a district manager holds exactly their own district");
    }

    const known = new Set((MAP.lines[scope.line]?.dmSeats ?? []).map((s) => s.seatId));
    for (const seatId of scope.dmSeatIds) {
      assert.ok(
        known.has(seatId),
        `${v.role} is granted district seat ${seatId}, which does not exist in the ${scope.line} line. ` +
          `The grant resolves, the page renders, and it is empty.`,
      );
    }
  }

  // ────────────────────────── 5. a line scope names a line that has a dataset
  for (const v of viewers) {
    const scope: ReviewPortalScope = resolveReviewPortalScope({ hrId: v.hrId, sessionRole: v.role });
    if (scope.kind !== "line") continue;
    assert.ok(MAP.lines[scope.line], `${v.role} is scoped to line "${scope.line}", which has no dataset`);
    assert.ok(scope.label.includes(v.role), "and the badge names the role the scope came from");
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

  // ────────────────────────── 7. the areas no district owns are counted, not hidden
  //
  // Not a defect — a third of target-carrying territories have no rep, which is a hiring fact.
  // It is asserted here so that "my line total is bigger than the sum of my districts" has a
  // written answer the next time somebody asks.
  for (const [line, def] of Object.entries(MAP.lines)) {
    assert.ok(Array.isArray(def.unmappedAreas), `${line} must declare its unmapped areas, even if none`);
  }

  // ────────────────────────── 8. the ADMIN surfaces, which the map does not govern
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
