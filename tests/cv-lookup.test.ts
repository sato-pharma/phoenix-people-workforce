import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  canAccess,
  createAccessContext,
  permissionActions,
  phoenixRoles,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { HR_ROLE_BUNDLES, type HrFunctionKey } from "../src/lib/auth/hr-functions.ts";
import { CV_LOOKUP_MIN_LENGTH } from "../src/lib/recruitment/cv-lookup.ts";

/**
 * CV LOOKUP — search-only CV access.
 *
 * The owner, 2026-09-30, about Yasmeena Elsafory (`HR-009`, HR Operations): "i want to make
 * something that she can search the cvs in admin account and finds only what it search for i dont
 * want her to have access to all cvs."
 *
 * So the feature is a refusal with a search box attached, and everything worth pinning is a way that
 * refusal could quietly be undone. Six things:
 *
 *   1. THE POOL STAYS SHUT. She gains `cv_lookup:read` and gains NOTHING else — not
 *      `candidates:read`, not `recruitment:read`, and the CV Database still refuses her. The
 *      obvious-looking implementation of this request is to hand the seat `candidates:read`, which
 *      is precisely the access he refused, so it is asserted as an absence.
 *   2. READ AND ONLY READ, FOR HR AUTHORITY ROLES ONLY. No role in the company may hold any other
 *      action on this resource, ever — the hard boundary caps it rather than the matrix asking
 *      nicely. In particular no `export`: a downloadable result set is the pool in a spreadsheet.
 *   3. EVERY DOOR ASSERTS `cv_lookup`, AND NONE OF THEM ASSERTS `candidates`. The page and both API
 *      routes. A row in navigation naming a resource its page does not assert is exactly how the CV
 *      Database came to advertise a gate it did not enforce.
 *   4. THE PAGE LOADS NO CANDIDATES. Not "hides" — loads none. A pool fetched server-side and
 *      filtered in the browser would sit in the HTML for anybody who read the page source.
 *   5. THE FLOOR IS REAL. Three characters, checked before any round trip, so the box cannot be
 *      used to page the database out one letter at a time. (The owner chose NO cap on results; the
 *      floor is what replaces it, and it is the half a future session might drop as an annoyance.)
 *   6. ONE BUILDER FOR THE FILE. Both application routes build their PDF from the same module, so
 *      "the CV with its application" cannot come to mean two different documents.
 */
export async function runCvLookupTests() {
  const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

  const PAGE = "app/(admin)/cv-lookup/page.tsx";
  const SEARCH_ROUTE = "app/api/recruitment/cv-lookup/route.ts";
  const FILE_ROUTE = "app/api/recruitment/cv-lookup/[id]/application/route.ts";
  const SERVICE = "src/lib/recruitment/cv-lookup.ts";

  const context = (role: PhoenixRole) => createAccessContext({ hrId: "HR-009", loginId: "hr-009", role });

  // ── 1 · THE POOL STAYS SHUT ───────────────────────────────────────────────────────────────────
  //
  // Asserted through canAccess with a context a real session would carry, not by reading the
  // matrix: `applyHardPermissionBoundaries` runs over the composed matrix at module load, so the
  // table is not the last word on access.
  assert.equal(
    await canAccess(context("HR Operations"), "cv_lookup", "read"),
    true,
    "OWNER RULE 2026-09-30: HR Operations must be able to SEARCH the CV database.",
  );
  assert.equal(
    await canAccess(context("HR Operations"), "candidates", "read"),
    false,
    "OWNER RULE 2026-09-30: HR Operations must NOT gain the candidate pool. Granting candidates:read " +
      "is the obvious-looking way to build a CV search and is exactly the access he refused.",
  );
  assert.equal(
    await canAccess(context("HR Operations"), "recruitment", "read"),
    false,
    "HR Operations must NOT gain the recruitment grant — that is the CV Database, shut to this seat " +
      "on 2026-09-01 (tests/cv-database-recruiting-boundary.test.ts).",
  );
  // Widened to the key union before the membership tests. `HR_ROLE_BUNDLES` is `as const`, so each
  // bundle is a readonly tuple of its OWN literals and `.includes("recruiting")` is a type error
  // rather than the `false` it is meant to assert — the compiler objecting that the seat cannot
  // possibly hold it is exactly the fact under test, and it must be asserted at runtime so a future
  // edit that DOES add it fails loudly instead of quietly becoming legal.
  const operationsFunctions: readonly HrFunctionKey[] = HR_ROLE_BUNDLES["HR Operations"];
  assert.ok(
    operationsFunctions.includes("cv_lookup"),
    "the cv_lookup function must stay in the HR Operations bundle — it is how the seat holds the grant",
  );
  assert.ok(
    !operationsFunctions.includes("recruiting"),
    "HR Operations must never hold the `recruiting` function: it carries candidates read/create/" +
      "update/delete and the whole pipeline, which is the widening the owner refused",
  );

  // ── 2 · READ, FOR HR AUTHORITY ROLES ONLY, AND NO OTHER ACTION FOR ANYBODY ─────────────────────
  const allowedReaders = new Set<PhoenixRole>(["Super Admin", "HR Operations"]);
  for (const role of phoenixRoles) {
    const canRead = await canAccess(context(role), "cv_lookup", "read");
    assert.equal(
      canRead,
      allowedReaders.has(role),
      `cv_lookup:read for "${role}" should be ${allowedReaders.has(role)}. The audience is the owner ` +
        "and the seat he granted it to; widening it needs his word, not a matrix edit.",
    );
    for (const action of permissionActions) {
      if (action === "read") continue;
      assert.equal(
        await canAccess(context(role), "cv_lookup", action),
        false,
        `"${role}" must hold NO cv_lookup:${action}. The hard boundary caps this resource at read — ` +
          "an `export` in particular would hand over the result set, which is the pool in a spreadsheet.",
      );
    }
  }

  // ── 3 · EVERY DOOR ASSERTS `cv_lookup`, AND NONE ASSERTS `candidates` ─────────────────────────
  const pageSource = read(PAGE);
  assert.match(
    pageSource,
    /canAccess\(access, "cv_lookup", "read"\)/,
    `${PAGE} must gate on cv_lookup:read — the gate is the revocation, not the sidebar row.`,
  );
  assert.match(pageSource, /isHrAuthorityRole\(access\.role\)/, `${PAGE} must also assert isHrAuthorityRole.`);
  assert.doesNotMatch(
    pageSource,
    /"(candidates|recruitment)"/,
    `${PAGE} must NOT name the candidates or recruitment resources — gating on either reopens the pool.`,
  );

  for (const route of [SEARCH_ROUTE, FILE_ROUTE]) {
    const source = read(route);
    assert.match(
      source,
      /requireRecruitmentAccess\(request, "cv_lookup", "read"\)/,
      `${route} must assert cv_lookup:read at the boundary.`,
    );
    assert.doesNotMatch(
      source,
      /"candidates"/,
      `${route} must NOT assert the candidates grant. A route that accepts either gate puts the narrow ` +
        "grant inside the gate guarding the pool, where the next widening of one reaches both.",
    );
    assert.match(source, /export const runtime = /, `${route} must declare runtime (check:routes).`);
    assert.match(source, /export const dynamic = /, `${route} must declare dynamic (check:routes).`);
  }

  // The service asserts it too, so a future caller reaching it by another route cannot skip the gate.
  const serviceSource = read(SERVICE);
  assert.match(
    serviceSource,
    /assertPermission\(access, "cv_lookup", "read"\)/,
    `${SERVICE} must assert the gate itself — searchCvLookup returns candidate identities.`,
  );
  // 🔒 OWNER RULING, 2026-09-30: "leave notes out of the CV Lookup search" — asked and answered
  // after the screen shipped, so this is a decision to honour, not a preference to weigh. The
  // message says so, because whoever sees this go red will be halfway through the widening that the
  // exclusion exists to refuse: "she could not find somebody, so search the notes too."
  assert.ok(
    !/^\s*"notes",/m.test(serviceSource) && !/^\s*"status_note",/m.test(serviceSource),
    `${SERVICE} must not search notes or status_note. OWNER RULING 2026-09-30 ("leave notes out of ` +
      'the CV Lookup search"): they are a colleague\'s judgement about the candidate rather than a ' +
      "fact about them, and searchable notes turn a lookup into a way to read what other people " +
      "have said. If a real candidate cannot be found, the answer is a better search term — never a " +
      "wider column list.",
  );

  // The navigation row must name the same resource the page asserts.
  const navSource = read("src/config/system-navigation.ts");
  const navRow = navSource
    .split("\n")
    .find((line) => line.includes('href: "/hr/cv-lookup"'));
  assert.ok(navRow, 'navigation must offer /hr/cv-lookup — otherwise the seat has a page it cannot find.');
  assert.match(
    navRow ?? "",
    /permissions: \[\{ resource: "cv_lookup" \}\]/,
    "the CV Lookup nav row must name cv_lookup. Naming `recruitment` or `candidates` here is the CV " +
      "Database's own drift, which cost this seat an unintended screen.",
  );

  // ── 3b · A HIT OFFERS BOTH THE FILE AND THE BOOKING ──────────────────────────────────────────
  //
  // "Schedule interview" reaches any screen that shows a CV (owner, 2026-09-18: "from any screen,
  // any CV"), and CV Lookup is one of them (owner, 2026-09-30). Pinned as the SHARED button, not as
  // the words on a button: a hand-rolled copy on this screen would be a second scheduling path with
  // its own idea of who may book, and `ScheduleInterviewButton` is what carries the gate and the
  // dialog. It draws nothing for a viewer who cannot book, so this screen must NOT restate that
  // condition itself.
  const view = read("src/components/recruitment/cv-lookup-search.tsx");
  assert.match(
    view,
    /import \{ ScheduleInterviewButton \} from "@\/components\/recruitment\/interview-calendar\/schedule-interview-button"/,
    "CV Lookup must use the SHARED Schedule interview button — a local copy is a second booking path.",
  );
  assert.match(view, /<ScheduleInterviewButton\b/, "…and actually draw it on a hit.");
  assert.ok(
    !/canBookInterviews|useInterviewCalendarMe|interview-calendar\/me/.test(view),
    "CV Lookup must not re-ask who may book: the shared button owns that gate, and a second copy of " +
      "the condition is how one of them goes stale.",
  );
  // The candidate it books is the one on the row — an id, a name, and what they applied for.
  assert.match(
    view,
    /candidate=\{\{\s*id: hit\.candidateId,\s*jobTitle: hit\.appliedFor \|\| null,\s*name: hit\.name\s*\}\}/,
    "the booking must carry the hit's own id, name and applied-for title onto the calendar.",
  );

  // ── 4 · THE PAGE LOADS NO CANDIDATES ─────────────────────────────────────────────────────────
  //
  // Asserted against the page's IMPORTS and its CALLS, not against the whole file: the page's own
  // comment names `listCandidates()` to explain what it deliberately does not do, and a substring
  // scan would read that explanation as the defect. (It did, on the first run of this test.)
  const pageImports = pageSource.slice(0, pageSource.indexOf("export const dynamic"));
  for (const forbidden of ["@/lib/recruitment/candidates", "@/lib/cv/cv-library", "@/lib/recruitment/cv-search"]) {
    assert.ok(
      !pageImports.includes(forbidden),
      `${PAGE} must not import ${forbidden}. The screen holds a search box and nothing else: a pool ` +
        "fetched server-side and hidden in the browser is still in the HTML for anyone who looks.",
    );
  }
  for (const forbidden of ["listCandidates(", "cvLibraryRowsFromCandidates(", "searchCandidateCvs("]) {
    assert.ok(
      !pageSource.includes(forbidden),
      `${PAGE} must not call ${forbidden}) — see above.`,
    );
  }

  // ── 5 · THE FLOOR IS REAL, AND COSTS NO ROUND TRIP ───────────────────────────────────────────
  assert.equal(
    CV_LOOKUP_MIN_LENGTH,
    3,
    "the floor is three characters. The owner chose NO cap on results, so this is the only thing " +
      "stopping the box being used to page the whole database out one letter at a time.",
  );
  // Proven by behaviour, not by reading the constant: a too-short query must answer with no hits
  // even for a caller that HOLDS the grant, and must do it before any query is built.
  const { searchCvLookup } = await import("../src/lib/recruitment/cv-lookup.ts");
  const short = await searchCvLookup(context("Super Admin"), "ah");
  assert.deepEqual(
    short,
    { hits: [], query: "ah", truncated: false },
    "a query below the floor must return nothing without touching the database",
  );
  const blank = await searchCvLookup(context("Super Admin"), "   ");
  assert.deepEqual(blank.hits, [], "a blank box is the screen's normal state, not an error");

  // And the route repeats it, so the floor is not one layer deep.
  assert.match(
    read(SEARCH_ROUTE),
    /CV_LOOKUP_MIN_LENGTH/,
    `${SEARCH_ROUTE} must apply the same floor as the service.`,
  );

  // ── 6 · ONE BUILDER, SO THE FILE CANNOT DRIFT ────────────────────────────────────────────────
  const BUILDER = "@/lib/recruitment/candidate-application-build";
  assert.ok(
    read(FILE_ROUTE).includes(BUILDER),
    `${FILE_ROUTE} must build its PDF from ${BUILDER}.`,
  );
  assert.ok(
    read("app/api/recruitment/candidates/[id]/application/route.ts").includes(BUILDER),
    "the screening page's application route must use the SAME builder, or 'the CV with its " +
      "application' means two different documents depending on which screen opened it.",
  );

  // ── THE AUDIT IS PART OF THE FEATURE, NOT A BY-PRODUCT ───────────────────────────────────────
  //
  // He was asked whether her searches should be recorded and answered yes, readable by him alone.
  // The search row is best-effort (a diagnostic must not break the thing it observes); the OPEN row
  // is REQUIRED, because a CV leaving the building with no trace is a failed open.
  assert.match(
    read(SEARCH_ROUTE),
    /recordCvLookupSearch\(/,
    `${SEARCH_ROUTE} must record every search — the owner asked for the log by name.`,
  );
  assert.match(serviceSource, /writeAuditLog\(/, `${SERVICE} must use the best-effort audit writer for a search.`);
  assert.match(
    read(FILE_ROUTE),
    /writeRequiredAuditLog\(\s*\{[\s\S]*?entityType: "cv_lookup_open"/,
    `${FILE_ROUTE} must write a REQUIRED audit row naming the candidate whose CV was opened.`,
  );
  // The search row holds the term and the count, never the people — writing 300 names into an audit
  // row would copy the pool into a second table.
  assert.ok(
    !/candidateName|hits\.map/.test(serviceSource.slice(serviceSource.indexOf("recordCvLookupSearch"))),
    `${SERVICE} must not write the people it found into the search audit row — only the term and the count.`,
  );

  // …AND A TRAIL HE CANNOT SELECT IS A TRAIL HE CANNOT READ. Writing the row is only half of
  // "logged, Super Admin only"; the other half is /admin/logs, where the entity-type picker is a
  // hand-kept shortlist. Production writes ~2,456 audit rows a day (measured 2026-09-30), so a
  // search from this morning is hundreds deep in "all" by the afternoon and yesterday's is gone.
  // Both types are asserted because they answer different questions — what was searched for, and
  // whose CV actually left the building.
  const VIEWER = "src/components/admin/audit-log-viewer.tsx";
  const viewerSource = read(VIEWER);
  const listStart = viewerSource.indexOf("const ENTITY_TYPES = [");
  const entityTypes = viewerSource.slice(listStart, viewerSource.indexOf("];", listStart));
  for (const entityType of ["cv_lookup_search", "cv_lookup_open"]) {
    assert.ok(
      entityTypes.includes(`"${entityType}"`),
      `${VIEWER} must offer "${entityType}" in ENTITY_TYPES. The owner asked for every CV Lookup ` +
        "search to be logged and readable by him alone; a type missing from that picker can only " +
        'be reached by paging "all", which is thousands of rows a day.',
    );
  }
}
