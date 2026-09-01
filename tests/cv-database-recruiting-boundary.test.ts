import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canAccess,
  createAccessContext,
  isHrAuthorityRole,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

/**
 * The CV Database is a RECRUITING screen, and HR Operations is not a recruiting seat.
 *
 * ## What happened
 *
 * On 2026-09-01 the owner asked for the Vacancies Report in the HR Operations sidebar. That report
 * gates on `vacancies:read`, so the seat was granted it. The CV Database gated on the SAME resource
 * — and so opened to her as a side effect nobody asked for. Told about it, he answered: *"block the
 * cv database for her too"*.
 *
 * ## Why the fix is a resource change, not an exclusion list
 *
 * The screen reads `listCandidates()` — the candidate pool. `recruitment` was always its real
 * resource; it sat on `vacancies` only because, until that grant, every role inside
 * `isHrAuthorityRole` holding `vacancies:read` also held `recruitment:read`, which made the two
 * indistinguishable. Nine roles hold `vacancies:read` without `recruitment:read` and
 * `isHrAuthorityRole` already excludes all nine, so the move costs nobody anything.
 *
 * The first attempt was `excludedRoles: ["HR Operations"]` on the nav entries. That hid the row and
 * left the page open to a typed URL — presentation, not revocation. This file pins the difference:
 * the assertions that matter are the two BEHAVIOURAL ones, which call the same predicates the pages
 * call. The source checks exist only to catch the three sibling surfaces drifting apart.
 */
export async function runCvDatabaseRecruitingBoundaryTests() {
  // ---------------------------------------------------------------- behaviour: who gets in
  //
  // Expressed as the page's own gate — `isHrAuthorityRole(role) && canAccess(role, resource, read)`
  // — so a change to EITHER half is caught. Asserting only the permission would miss someone being
  // added to hrAuthorityRoles.
  const opens = async (role: PhoenixRole) =>
    isHrAuthorityRole(role)
    && (await canAccess(createAccessContext({ hrId: "A-17", role }), "recruitment", "read"));

  assert.equal(await opens("HR Operations"), false, "OWNER RULE 2026-09-01: HR Operations must NOT open the CV Database.");
  assert.equal(await opens("HR Advisory"), true, "HR Advisory owns recruiting and keeps it.");
  assert.equal(await opens("Super Admin"), true, "Super Admin keeps it.");

  // The grant the owner DID ask for, in the same breath, must survive the block. If a later session
  // "fixes" the CV Database by taking `vacancies:read` back off the seat, this fires: the Vacancies
  // Report is what he wanted, and it is not a valid casualty of what he refused.
  assert.equal(
    await canAccess(createAccessContext({ hrId: "A-17", role: "HR Operations" }), "vacancies", "read"),
    true,
    "HR Operations keeps vacancies:read — that is the Vacancies Report the owner asked for.",
  );

  // ---------------------------------------------------------------- source: the three surfaces
  //
  // Page, portal mirror and template route are three separate doors to the same candidate data.
  // Closing one and forgetting another is the failure this half exists for.
  const surfaces: Array<[string, string]> = [
    ["admin page", "../app/(admin)/cv-database/page.tsx"],
    ["portal mirror", "../app/employee-portals/cv-database/page.tsx"],
    ["CV template route", "../app/api/cv-database/template/route.ts"],
  ];

  for (const [label, path] of surfaces) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(
      source,
      /(canAccess|assertPermission)\(access, "recruitment", "read"\)/,
      `The CV Database ${label} must gate on recruitment:read.`,
    );
    assert.doesNotMatch(
      source,
      /(canAccess|assertPermission)\(access, "vacancies",/,
      `The CV Database ${label} must NOT gate on vacancies — HR Operations holds it for the ` +
        "Vacancies Report, and re-gating here silently reopens the screen the owner blocked.",
    );
  }

  // ---------------------------------------------------------------- nav agrees with the gate
  //
  // Both catalogue entries must name the same resource. If a row goes back to `vacancies`, the link
  // reappears in her sidebar pointing at a page that redirects her — the confusing shape, and the
  // signal that someone tried to solve this in the nav layer again.
  // The two rows have different SHAPES — the /hr row is one line, the module entry a multi-line
  // object — so each is read from its own `href:` up to the next one. Anchoring on content rather
  // than a byte window is deliberate: a fixed slice false-FAILS the moment the file shifts.
  const navSource = readFileSync(new URL("../src/config/system-navigation.ts", import.meta.url), "utf8");
  const hrefStarts = [...navSource.matchAll(/href: "/g)].map((match) => match.index ?? 0);
  const entryAt = (start: number) => {
    const next = hrefStarts.find((index) => index > start);
    return navSource.slice(start, next ?? navSource.length);
  };

  for (const href of ["/cv-database", "/hr/cv-database"]) {
    const starts = hrefStarts.filter((index) => navSource.startsWith(`href: "${href}"`, index));
    assert.equal(starts.length, 1, `Expected exactly one nav entry for ${href}.`);
    // Comments stripped first. Both entries EXPLAIN that excludedRoles was tried and rejected, and
    // a check that reads the prose fails on its own reasoning — which is exactly what happened the
    // first time this ran.
    const entry = entryAt(starts[0]).replace(/^[^\S\n]*\/\/.*$/gm, "");
    assert.match(
      entry,
      /resource: "recruitment"/,
      `The ${href} nav entry must name recruitment, so the row and the page's gate cannot disagree.`,
    );
    assert.doesNotMatch(
      entry,
      /excludedRoles/,
      `The ${href} nav entry must not use excludedRoles — an exclusion hides the row and leaves the `
        + "URL open, which is exactly the half-fix this rule replaced.",
    );
  }
}
